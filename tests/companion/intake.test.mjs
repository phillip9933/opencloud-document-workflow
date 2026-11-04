// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { Intake, defaultIntake, validateIntake } from '../../companion/intake.mjs'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-intake-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity()
  let now = 1000000,
    calls = 0
  const intake = new Intake(w, { now: () => now, prepare: async () => ({ id: `test-${++calls}` }) })
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  return {
    dir,
    path,
    j,
    w,
    api,
    actor,
    intake,
    get calls() {
      return calls
    },
    advance(ms = 3000) {
      now += ms
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('intake waits for stable uploads, prepares once, persists queue, and never approves', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 0)
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 3)
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 3)
    assert.equal(
      s.intake.status(s.actor).queue.every((i) => i.state === 'prepared'),
      true
    )
    assert.equal(s.j.db.prepare('select count(*) n from decisions').get().n, 0)
    const second = new ProposalJournal(s.path),
      next = new Intake(new Workflow(second))
    assert.equal(next.status(s.actor).queue.length, 3)
    assert.equal(next.configuration(s.actor).enabled, true)
    assert.equal(next.sessions.size, 0)
    second.close()
  } finally {
    s.close()
  }
})
test('changed uploads supersede old queue records and restart settling', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    s.j.db.prepare('update demo_files set etag=? where resourceId=?').run('"v2"', 'demo-english')
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 2)
    assert.equal(
      s.intake.status(s.actor).queue.find((i) => i.resource === 'demo-english' && i.etag === '"v1"')
        .state,
      'superseded'
    )
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 3)
  } finally {
    s.close()
  }
})
test('retries are bounded, concurrent ticks serialize, and pausing stops new work', async () => {
  const s = await setup()
  try {
    let calls = 0
    s.intake.prepare = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 2))
      throw new Error('provider unavailable')
    }
    await s.intake.tick({ force: true })
    for (let n = 0; n < 4; n++) {
      s.advance(1000000)
      await Promise.all([s.intake.tick({ force: true }), s.intake.tick({ force: true })])
    }
    assert.equal(calls, 9)
    assert.equal(
      s.intake.status(s.actor).queue.every((i) => i.attempts === 3),
      true
    )
    s.intake.retry(s.actor, s.intake.status(s.actor).queue[0].id)
    assert.equal(
      s.intake.status(s.actor).queue.some((q) => q.state === 'queued' && q.attempts === 0),
      true
    )
    s.intake.save(s.actor, { ...defaultIntake(), enabled: false }, s.api)
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(calls, 9)
  } finally {
    s.close()
  }
})
test('revoked or changed identities stop intake before listing or processing', async () => {
  const s = await setup()
  try {
    s.api.identity = async () => {
      throw Object.assign(new Error('revoked'), { status: 403 })
    }
    s.api.list = async () => {
      throw new Error('must not list')
    }
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 0)
    assert.equal(s.intake.sessions.size, 0)
    assert.equal(s.w.history(s.actor)[0].kind, 'intake_scan_held')
  } finally {
    s.close()
  }
})
test('large inboxes and deep folder collections are fully discovered and paginated without trial caps', async () => {
  const s = await setup()
  try {
    s.api.list = async (path) =>
      path === 'Inbox'
        ? Array.from({ length: 205 }, (_, i) => ({ path: `Inbox/folder${i}`, folder: true }))
        : Array.from({ length: 6 }, (_, i) => ({
            path: `${path}/${i}.pdf`,
            resourceId: `${path}-${i}`,
            etag: 'v1'
          }))
    await s.intake.scan(s.actor, s.api, s.intake.configuration(s.actor))
    assert.equal(s.j.db.prepare('select count(*) n from intake_queue').get().n, 1230)
    const ids = new Set()
    let cursor
    do {
      const page = s.intake.status(s.actor, { limit: 200, cursor })
      for (const q of page.queue) {
        assert.ok(!ids.has(q.id))
        ids.add(q.id)
      }
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(ids.size, 1230)
    assert.equal(s.calls, 0)
  } finally {
    s.close()
  }
})
test('intake settings reject traversal, Filed feedback loops, and unsupported bounds', () => {
  assert.throws(() => validateIntake({ ...defaultIntake(), folder: 'Inbox/../Filed' }))
  assert.equal(validateIntake({ ...defaultIntake(), intervalSeconds: 0 }).intervalSeconds, 0)
  for (const intervalSeconds of [-1, 1, 4, 86401])
    assert.throws(() => validateIntake({ ...defaultIntake(), intervalSeconds }))
})

test('an expired in-flight scan cannot detach a newer verified session', async () => {
  const s = await setup()
  let failOld, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const old = {
    identity: () => {
      entered()
      return new Promise((_, reject) => {
        failOld = reject
      })
    }
  }
  try {
    s.intake.attach(s.actor, old)
    const running = s.intake.tick({ force: true })
    await started
    s.intake.attach(s.actor, s.api)
    failOld(Object.assign(new Error('private-expired-token'), { status: 401 }))
    await running
    assert.equal(s.intake.sessions.get(s.w.scope(s.actor))?.api, s.api)
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 3)
    assert.equal(JSON.stringify(s.w.history(s.actor)).includes('private-expired-token'), false)
  } finally {
    s.close()
  }
})

test('scan health survives restart without retaining sessions and distinguishes recovery from a folder hold', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    let health = s.intake.status(s.actor).health
    assert.equal(health.state, 'ready')
    assert.equal(health.lastSuccess, 1000000)
    s.api.list = async () => {
      throw new Error('private-network-response')
    }
    s.advance()
    await s.intake.tick({ force: true })
    health = s.intake.status(s.actor).health
    assert.equal(health.state, 'held')
    assert.equal(health.lastSuccess, 1000000)
    assert.equal(health.lastAttempt, 1003000)
    assert.equal(health.reason, 'source')
    const second = new ProposalJournal(s.path),
      next = new Intake(new Workflow(second))
    try {
      const restored = next.status(s.actor)
      assert.equal(restored.sessionAttached, false)
      assert.equal(restored.health.state, 'waiting_for_session')
      assert.equal(restored.health.lastSuccess, 1000000)
      assert.equal(JSON.stringify(restored).includes('private-network-response'), false)
    } finally {
      second.close()
    }
  } finally {
    s.close()
  }
})

test('identity failures respect the scan interval and a fresh verified session can recover', async () => {
  const s = await setup()
  let identities = 0
  try {
    s.intake.attach(s.actor, {
      identity: async () => {
        identities++
        throw Object.assign(new Error('upstream body'), { status: 503 })
      }
    })
    await s.intake.tick()
    await s.intake.tick()
    assert.equal(identities, 1)
    s.advance(30000)
    await s.intake.tick()
    assert.equal(identities, 2)
    s.intake.attach(s.actor, s.api)
    s.advance(30000)
    await s.intake.tick()
    assert.equal(s.intake.status(s.actor).health.state, 'ready')
  } finally {
    s.close()
  }
})

test('failed inference keeps one stable duplicate owner through retries and restart', async () => {
  const s = await setup()
  try {
    const original = s.j.db
      .prepare("select * from demo_files where resourceId='demo-english'")
      .get()
    s.j.db
      .prepare('insert into demo_files values(?,?,?,?,?,?)')
      .run('Inbox/zduplicate.pdf', 'duplicate-resource', '"v1"', '[]', 0, original.data)
    let englishCalls = 0
    s.intake.prepare = async (actor, api, path) => {
      if (path === 'Inbox/english.pdf') {
        englishCalls++
        s.j.db
          .prepare(
            'insert or replace into proposals(id,scope,input,configuration,state,attempts,updated) values(?,?,?,?,?,?,?)'
          )
          .run(
            'failed-original',
            s.w.scope(actor),
            JSON.stringify({
              source: {
                resourceId: 'demo-english',
                sha256: (await import('node:crypto'))
                  .createHash('sha256')
                  .update(original.data)
                  .digest('hex')
              }
            }),
            '{}',
            'failed',
            englishCalls,
            new Date().toISOString()
          )
        throw new Error('unsupported fact')
      }
      if (path === 'Inbox/zduplicate.pdf') throw new Error('Duplicate must never reach inference')
      return { id: 'prepared-' + path }
    }
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    let queue = s.intake.status(s.actor).queue
    assert.equal(queue.find((q) => q.resource === 'duplicate-resource').state, 'duplicate')
    assert.equal(queue.find((q) => q.resource === 'duplicate-resource').job, 'failed-original')
    assert.equal(englishCalls, 1)
    s.advance(100000)
    await s.intake.tick({ force: true })
    queue = s.intake.status(s.actor).queue
    assert.equal(queue.find((q) => q.resource === 'demo-english').state, 'failed')
    assert.equal(queue.find((q) => q.resource === 'duplicate-resource').state, 'duplicate')
    assert.equal(englishCalls, 2)
    const next = new ProposalJournal(s.path)
    try {
      assert.equal(
        next.db.prepare('select resource from intake_content where job=?').get('failed-original')
          .resource,
        'demo-english'
      )
    } finally {
      next.close()
    }
  } finally {
    s.close()
  }
})

test('configured filing destination cannot be used as an inbox', async () => {
  const s = await setup()
  try {
    assert.throws(
      () => s.intake.save(s.actor, { ...defaultIntake(), folder: 'Filed' }, s.api),
      /outside the filing destination/
    )
  } finally {
    s.close()
  }
})

function manualScheduler(intake) {
  let next = 0
  const tasks = new Map()
  intake.schedule = (fn, delay) => {
    const id = ++next
    tasks.set(id, { fn, delay })
    return id
  }
  intake.cancel = (id) => tasks.delete(id)
  return {
    tasks,
    async run() {
      const entry = tasks.entries().next().value
      assert.ok(entry, 'Expected a pending manual check')
      tasks.delete(entry[0])
      const alreadyRunning = intake.running
      entry[1].fn()
      while (!alreadyRunning && intake.running) await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      return entry[1].delay
    }
  }
}
test('manual-only timing survives restart and timer ticks never list or prepare', async () => {
  const s = await setup()
  try {
    s.intake.save(s.actor, { ...defaultIntake(), enabled: true, intervalSeconds: 0 }, s.api)
    let lists = 0
    const list = s.api.list.bind(s.api)
    s.api.list = async (path) => {
      lists++
      return list(path)
    }
    await s.intake.tick()
    s.advance(86400000)
    await s.intake.tick()
    assert.equal(lists, 0)
    assert.equal(s.calls, 0)
    assert.equal(s.intake.status(s.actor).health.nextScanAt, null)
    assert.equal(s.intake.status(s.actor).health.manualOnly, true)
    const j = new ProposalJournal(s.path)
    try {
      const next = new Intake(new Workflow(j), {
        prepare: async () => {
          throw Error('Must not prepare')
        }
      })
      next.attach(s.actor, s.api)
      await next.tick()
      assert.equal(next.configuration(s.actor).intervalSeconds, 0)
      assert.equal(lists, 0)
    } finally {
      j.close()
    }
  } finally {
    s.close()
  }
})
test('one manual check waits once for its cohort, prepares stable files and stops; later arrivals wait', async () => {
  const s = await setup()
  try {
    s.intake.save(
      s.actor,
      { ...defaultIntake(), enabled: true, intervalSeconds: 0, settleSeconds: 2 },
      s.api
    )
    const scheduler = manualScheduler(s.intake)
    s.intake.requestCheck(s.actor)
    s.intake.requestCheck(s.actor)
    assert.equal(scheduler.tasks.size, 1)
    await scheduler.run()
    assert.equal(s.calls, 0)
    assert.equal(s.intake.status(s.actor).health.manualCheck, 'settling')
    assert.equal(scheduler.tasks.size, 1)
    s.advance()
    const original = s.j.db
      .prepare("select * from demo_files where resourceId='demo-english'")
      .get()
    s.j.db
      .prepare('insert into demo_files values(?,?,?,?,?,?)')
      .run('Inbox/later.pdf', 'later', '"v1"', '[]', 0, original.data)
    await scheduler.run()
    assert.equal(s.calls, 3)
    assert.equal(
      s.intake.status(s.actor).queue.find((q) => q.resource === 'later').state,
      'settling'
    )
    assert.equal(s.intake.status(s.actor).health.manualCheck, null)
    assert.equal(scheduler.tasks.size, 0)
    s.advance(86400000)
    await s.intake.tick()
    assert.equal(s.calls, 3)
  } finally {
    s.close()
  }
})
test('manual settling recheck leaves changed uploads for a new manual check and excludes other accounts', async () => {
  const s = await setup()
  try {
    s.intake.save(
      s.actor,
      { ...defaultIntake(), enabled: true, intervalSeconds: 0, settleSeconds: 2 },
      s.api
    )
    const other = { ...s.actor, account: 'another-account' }
    s.intake.save(
      other,
      { ...defaultIntake(), enabled: true, intervalSeconds: 0 },
      {
        identity: async () => other,
        list: async () => {
          throw Error('Another account must not be scanned')
        }
      }
    )
    const scheduler = manualScheduler(s.intake)
    s.intake.requestCheck(s.actor)
    await scheduler.run()
    s.advance()
    s.j.db.prepare('update demo_files set etag=? where resourceId=?').run('"v2"', 'demo-english')
    await scheduler.run()
    assert.equal(s.calls, 2)
    assert.equal(
      s.intake.status(s.actor).queue.find((q) => q.resource === 'demo-english' && q.etag === '"v2"')
        .state,
      'settling'
    )
    assert.equal(s.intake.status(other).health.lastAttempt, null)
    assert.equal(scheduler.tasks.size, 0)
  } finally {
    s.close()
  }
})
test('manual requests wait for an active tick, and pause or shutdown cancels their settling followup', async () => {
  const s = await setup()
  try {
    const scheduler = manualScheduler(s.intake)
    s.intake.running = true
    s.intake.requestCheck(s.actor)
    await scheduler.run()
    assert.equal(scheduler.tasks.size, 1)
    s.intake.running = false
    await scheduler.run()
    assert.equal(s.intake.status(s.actor).health.manualCheck, 'settling')
    s.intake.save(s.actor, { ...s.intake.configuration(s.actor), enabled: false }, s.api)
    assert.equal(scheduler.tasks.size, 0)
    assert.throws(() => s.intake.requestCheck(s.actor), /Enable inbox processing/)
    s.intake.save(s.actor, { ...s.intake.configuration(s.actor), enabled: true }, s.api)
    s.intake.requestCheck(s.actor)
    await scheduler.run()
    assert.equal(scheduler.tasks.size, 1)
    await s.intake.stop()
    assert.equal(scheduler.tasks.size, 0)
    assert.equal(s.intake.manualChecks.size, 0)
  } finally {
    s.close()
  }
})

test('automatic intake leaves images and office documents untouched and never requests conversion', async () => {
  const s = await setup()
  try {
    s.api.list = async () => [
      { path: 'Inbox/photo.jpg', folder: false, resourceId: 'image', etag: 'v1' },
      { path: 'Inbox/sheet.xlsx', folder: false, resourceId: 'sheet', etag: 'v1' }
    ]
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 0)
    assert.equal(s.intake.status(s.actor).queue.length, 0)
    assert.equal(s.j.db.prepare('select count(*) n from decisions').get().n, 0)
  } finally {
    s.close()
  }
})
test('verified app-token adapters stay preferred over browser polling and old detach cannot remove a renewed token', async () => {
  const s = await setup()
  try {
    const token = { identity: async () => s.actor },
      renewed = { identity: async () => s.actor },
      browser = { identity: async () => s.actor },
      scope = s.w.scope(s.actor)
    s.intake.attach(s.actor, token, { background: true })
    s.intake.attach(s.actor, browser)
    assert.equal(s.intake.sessions.get(scope).api, token)
    s.intake.save(s.actor, s.intake.configuration(s.actor), browser)
    assert.equal(s.intake.sessions.get(scope).api, token)
    s.intake.attach(s.actor, renewed, { background: true })
    s.intake.detach(token)
    assert.equal(s.intake.sessions.get(scope).api, renewed)
    s.intake.detach(renewed)
    assert.equal(s.intake.sessions.has(scope), false)
    assert.equal(s.intake.backgroundSessions.has(scope), false)
    const other = { ...s.actor, account: 'other' }
    s.intake.attach(other, browser)
    s.intake.attach(s.actor, token, { background: true })
    assert.equal(s.intake.sessions.get(s.w.scope(other)).api, browser)
  } finally {
    s.close()
  }
})

test('intake picks up a renewed adapter between items and stops the cohort when paused', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    const renewed = new DemoAdapter(s.j.db)
    const adapters = []
    s.intake.prepare = async (actor, api) => {
      adapters.push(api)
      if (adapters.length === 1) s.intake.attach(actor, renewed, { background: true })
      if (adapters.length === 2) s.intake.manage(actor, 'pause')
      return { id: `renewal-${adapters.length}` }
    }
    await s.intake.tick({ force: true })
    assert.deepEqual(adapters, [s.api, renewed])
    const states = s.j.db
      .prepare('select state from intake_queue order by id')
      .all()
      .map((row) => row.state)
    assert.equal(states.filter((state) => state === 'prepared').length, 2)
    assert.equal(states.filter((state) => state === 'settling').length, 1)
    assert.equal(s.intake.running, false)
    assert.equal(s.intake.activeScope, null)
    assert.equal(s.j.db.prepare('select count(*) n from workflow_locks').get().n, 0)
  } finally {
    s.close()
  }
})
