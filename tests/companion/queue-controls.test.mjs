// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { extractPDFBytes } from '../../companion/extract.mjs'
import { defaultPolicy, validateBundle } from '../../src/domain/review.ts'
import { samples } from '../../src/domain/samples.ts'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-queue-')),
    path = join(dir, 'journal.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity()
  let now = 1000000,
    calls = 0
  const intake = new Intake(w, {
    now: () => now,
    prepare: async () => ({ id: 'fixture-' + ++calls })
  })
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  return {
    j,
    w,
    api,
    actor,
    intake,
    path,
    get calls() {
      return calls
    },
    advance() {
      now += 3000
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('full-queue counts and bulk retry cover 211 nested imports beyond the visible page and stay scoped', async () => {
  const s = await setup()
  try {
    s.api.list = async (path) =>
      path === 'Inbox'
        ? Array.from({ length: 211 }, (_, i) => ({ path: `Inbox/folder-${i}`, folder: true }))
        : [{ path: path + '/scan.pdf', folder: false, resourceId: path, etag: 'v1' }]
    await s.intake.scan(s.actor, s.api, s.intake.configuration(s.actor))
    s.j.db.prepare("update intake_queue set state='failed',attempts=3").run()
    const source = s.j.db.prepare('select * from intake_queue limit 1').get(),
      other = { ...s.actor, account: 'other-person' }
    s.j.db
      .prepare(
        "insert into intake_queue(id,scope,resource,path,etag,first_seen,state,attempts) values(?,?,?,?,?,?,'failed',3)"
      )
      .run(
        'other-job',
        s.w.scope(other),
        source.resource,
        source.path,
        source.etag,
        source.first_seen
      )
    const page = s.intake.status(s.actor, { limit: 20 })
    assert.equal(page.queue.length, 20)
    assert.ok(page.nextCursor)
    assert.equal(page.summary.total, 211)
    assert.equal(page.summary.attention, 211)
    assert.equal(s.intake.manage(s.actor, 'retry').affected, 211)
    assert.equal(s.intake.summary(s.actor).waiting, 211)
    assert.equal(s.intake.summary(other).attention, 1)
    assert.equal(s.intake.manage(s.actor, 'cancel', [page.queue[0].id, 'other-job']).affected, 1)
    assert.equal(s.intake.summary(other).attention, 1)
    assert.equal(s.intake.manage(s.actor, 'cancel').affected, 210)
    assert.equal(s.intake.summary(s.actor).cancelled, 211)
    assert.equal(s.intake.paused(s.actor), true)
    s.intake.manage(s.actor, 'resume')
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 0, 'scan must not resurrect cancelled uploads')
    assert.equal(s.intake.manage(s.actor, 'retry').affected, 211)
    assert.equal(s.intake.summary(s.actor).waiting, 211)
  } finally {
    s.close()
  }
})
test('pause drains the current preparation, persists after restart and never changes processing authorization settings', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    let entered, finish
    const ready = new Promise((r) => {
      entered = r
    })
    const gate = new Promise((r) => {
      finish = r
    })
    s.intake.prepare = async () => {
      entered()
      await gate
      return { id: 'active-fixture' }
    }
    const before = s.intake.configuration(s.actor),
      running = s.intake.tick({ force: true })
    await ready
    s.intake.manage(s.actor, 'pause')
    finish()
    await running
    assert.deepEqual(s.intake.configuration(s.actor), before)
    assert.equal(s.intake.summary(s.actor).ready, 1)
    assert.equal(s.intake.summary(s.actor).waiting, 2)
    const next = new ProposalJournal(s.path)
    try {
      const intake = new Intake(new Workflow(next))
      assert.equal(intake.paused(s.actor), true)
      assert.equal(intake.status(s.actor).health.state, 'paused')
    } finally {
      next.close()
    }
    assert.throws(() => s.intake.requestCheck(s.actor), /Resume/)
  } finally {
    s.close()
  }
})
test('cancel while inference awaits does not restore running work, auto-file, or erase source PDFs', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    let entered, finish
    const ready = new Promise((r) => {
        entered = r
      }),
      gate = new Promise((r) => {
        finish = r
      })
    let filing = 0
    s.intake.prepare = async () => {
      entered()
      await gate
      return { id: 'cancelled-fixture' }
    }
    s.intake.processPrepared = async () => {
      filing++
    }
    const running = s.intake.tick({ force: true })
    await ready
    assert.equal(s.intake.manage(s.actor, 'cancel').affected, 3)
    finish()
    await running
    assert.equal(s.intake.summary(s.actor).cancelled, 3)
    assert.equal(filing, 0)
    assert.equal((await s.api.list('Inbox')).length, 3)
    s.intake.manage(s.actor, 'resume')
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.intake.summary(s.actor).cancelled, 3)
  } finally {
    s.close()
  }
})
test('retry after resetting the attempt count actually retries a persisted failed proposal', async () => {
  const s = await setup()
  try {
    s.j.db.prepare("delete from demo_files where folder=0 and resourceId<>'demo-english'").run()
    let first = true
    s.intake.prepare = async (actor, api, path, options) => {
      const f = await api.stat(path),
        input = await extractPDFBytes(await api.get(path), {
          server: actor.server,
          account: actor.account,
          space: actor.space,
          path,
          resourceId: f.resourceId,
          etag: f.etag
        })
      return s.j.prepare(
        input,
        { endpoint: 'http://127.0.0.1:11434', model: 'fixture', policy: defaultPolicy() },
        {
          ...options,
          planner: async (input) => {
            if (first) {
              first = false
              throw Error('Simulated transient failure')
            }
            return validateBundle({ ...input, proposal: samples()[0].proposal })
          }
        }
      )
    }
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    assert.equal(s.intake.summary(s.actor).attention, 1)
    s.intake.manage(s.actor, 'retry')
    await s.intake.tick({ force: true })
    assert.equal(s.intake.summary(s.actor).ready, 1)
    assert.equal(s.j.db.prepare('select attempts from proposals').get().attempts, 2)
  } finally {
    s.close()
  }
})
test('live progress records extraction and analysis milestones and retains a safe failure diagnosis', async () => {
  const s = await setup()
  try {
    s.j.db.prepare("delete from demo_files where folder=0 and resourceId<>'demo-english'").run()
    s.intake.prepare = async (actor, api, path, options) => {
      options.onProgress('ocr')
      assert.equal(s.intake.status(actor).queue[0].progress.label, 'Reading scanned pages')
      options.onProgress('analysing')
      assert.equal(s.intake.status(actor).queue[0].progress.step, 3)
      throw Error('fetch failed')
    }
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    const row = s.intake.status(s.actor).queue[0]
    assert.equal(row.progress.step, 3)
    assert.equal(row.progress.attention, true)
    assert.match(row.detail, /unavailable/)
    const { processingIssue } = await import('../../companion/processing-issues.mjs'),
      f = await s.api.stat('Inbox/english.pdf'),
      issue = processingIssue(s.w, s.actor, f)
    assert.match(issue.message, /unavailable/)
    assert.match(issue.nextStep, /connection/)
    assert.equal(issue.retryable, true)
  } finally {
    s.close()
  }
})
test('a queued retry hides the old OCR hold until a new attempt completes', async () => {
  const s = await setup()
  try {
    const f = await s.api.stat('Inbox/english.pdf'),
      input = await extractPDFBytes(await s.api.get(f.path), {
        server: s.actor.server,
        account: s.actor.account,
        space: s.actor.space,
        path: f.path,
        resourceId: f.resourceId,
        etag: f.etag
      })
    input.pages = ['']
    const held = await s.j.prepare(
      input,
      { endpoint: 'http://127.0.0.1:11434', model: 'fixture', policy: defaultPolicy() },
      { scope: s.w.scope(s.actor) }
    )
    s.j.db
      .prepare(
        "insert into intake_queue(id,scope,resource,path,etag,first_seen,state,attempts,job) values(?,?,?,?,?,?,'prepared',1,?)"
      )
      .run('held', s.w.scope(s.actor), f.resourceId, f.path, f.etag, 1, held.id)
    const { processingIssue } = await import('../../companion/processing-issues.mjs')
    assert.match(processingIssue(s.w, s.actor, f).message, /no readable text/)
    const row = s.intake.status(s.actor).queue[0]
    assert.equal(row.proposalState, 'needs_ocr')
    assert.equal(row.retryable, true)
    assert.equal(s.intake.manage(s.actor, 'retry', ['held']).affected, 1)
    assert.equal(processingIssue(s.w, s.actor, f), null)
    s.j.db.prepare("update intake_queue set state='running' where id='held'").run()
    assert.equal(processingIssue(s.w, s.actor, f), null)
    s.j.db.prepare("update intake_queue set state='prepared' where id='held'").run()
    assert.match(processingIssue(s.w, s.actor, f).message, /no readable text/)
  } finally {
    s.close()
  }
})
test('long batches adopt a freshly verified connection between documents', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    const renewed = Object.create(s.api)
    let oldReads = 0,
      newReads = 0,
      prepares = 0
    const get = s.api.get.bind(s.api)
    s.api.get = async (...args) => {
      oldReads++
      return get(...args)
    }
    renewed.get = async (...args) => {
      newReads++
      return get(...args)
    }
    s.intake.prepare = async (actor, api) => {
      prepares++
      if (prepares === 1) {
        assert.equal(api, s.api)
        s.intake.attach(actor, renewed)
      } else assert.equal(api, renewed)
      return { id: 'renewed-' + prepares }
    }
    await s.intake.tick({ force: true })
    assert.equal(oldReads, 1)
    assert.equal(newReads, 2)
    assert.equal(s.intake.summary(s.actor).ready, 3)
  } finally {
    s.close()
  }
})
test('expired permissions hold the batch without consuming file attempts or failing the remaining files', async () => {
  const s = await setup()
  try {
    await s.intake.tick({ force: true })
    s.advance()
    s.api.get = async () => {
      throw Object.assign(Error('OpenCloud HTTP 401'), { status: 401 })
    }
    await s.intake.tick({ force: true })
    assert.equal(s.intake.summary(s.actor).waiting, 3)
    assert.equal(s.intake.summary(s.actor).attention, 0)
    assert.ok(
      s.j.db
        .prepare('select attempts from intake_queue')
        .all()
        .every((row) => row.attempts === 0)
    )
    assert.equal(s.intake.status(s.actor).health.reason, 'session')
    assert.equal(s.intake.sessions.size, 0)
  } finally {
    s.close()
  }
})

test('Activity current-inbox counts exclude absent old results while history and unresolved filing evidence remain intact', async () => {
  const s = await setup()
  try {
    await s.intake.scan(s.actor, s.api, s.intake.configuration(s.actor))
    s.j.db.prepare("update intake_queue set state='prepared'").run()
    const rows = s.intake.status(s.actor).queue,
      original = s.j.db.prepare('select id,state,job from intake_queue order by id').all()
    s.j.db.prepare("update intake_queue set state='failed' where id=?").run(rows[0].id)
    const saved = s.j.db.prepare('select id,state,job from intake_queue order by id').all()
    const empty = s.intake.status(s.actor, {}, [])
    assert.equal(empty.summary.total, 0)
    assert.equal(empty.summary.ready, 0)
    assert.equal(empty.summary.attention, 0)
    assert.equal(empty.summary.retryable, 0)
    assert.equal(empty.queue.length, 0)
    assert.equal(empty.historicalTotal, 3)
    const history = s.intake.status(s.actor, { includeHistory: true, limit: 2 }, [])
    assert.equal(history.queue.length, 2)
    assert.ok(history.nextCursor)
    assert.ok(history.queue.every((row) => row.historical && !row.retryable))
    assert.equal(
      s.intake.status(s.actor, { includeHistory: true, cursor: history.nextCursor }, []).queue
        .length,
      1
    )
    assert.deepEqual(
      s.j.db.prepare('select id,state,job from intake_queue order by id').all(),
      saved
    )
    const row = rows[0],
      file = await s.api.stat(row.path),
      present = { ...file, intakeState: 'failed', progress: { attention: true, step: 2 } }
    const current = s.intake.status(s.actor, {}, [present])
    assert.equal(current.summary.attention, 1)
    assert.equal(current.summary.retryable, 1)
    assert.equal(current.queue.length, 1)
    assert.equal(current.queue[0].historical, false)
    assert.equal(
      s.intake.status(s.actor, {}, [{ ...present, resourceId: 'different-resource' }]).queue.length,
      0,
      'old paths occupied by different files do not revive imports'
    )
    assert.equal(
      s.intake.status(s.actor, {}, [{ ...present, etag: 'new-version' }]).queue.length,
      0,
      'past versions are not current work'
    )
    assert.equal(
      s.intake.status({ ...s.actor, account: 'other' }, { includeHistory: true }, [])
        .historicalTotal,
      0
    )
    assert.equal(original.length, 3)
  } finally {
    s.close()
  }
})

test('current work retains an uncertain filing intent even when the original is absent from Inbox', async () => {
  const s = await setup()
  try {
    await s.intake.scan(s.actor, s.api, s.intake.configuration(s.actor))
    const row = s.intake.status(s.actor).queue[0]
    s.j.db
      .prepare("update intake_queue set state='prepared',job='uncertain' where id=?")
      .run(row.id)
    s.j.db
      .prepare(
        "insert into decisions(job,actor,record,state,plan,updated) values('uncertain',?,'{}','move_intent','{}',?)"
      )
      .run(s.actor.account, new Date().toISOString())
    const page = s.intake.status(s.actor, {}, [])
    assert.equal(page.queue.length, 1)
    assert.equal(page.queue[0].historical, false)
    assert.equal(page.queue[0].decision, 'move_intent')
    assert.equal(page.summary.attention, 1)
    assert.equal(page.summary.total, 1)
    assert.equal(page.queue[0].retryable, false)
  } finally {
    s.close()
  }
})

test('a non-Error preparation failure records a bounded hold and releases the intake worker', async () => {
  const s = await setup()
  try {
    s.intake.prepare = async () => {
      throw null
    }
    await s.intake.tick({ force: true })
    s.advance()
    await s.intake.tick({ force: true })
    const rows = s.j.db.prepare('select state,attempts,issue from intake_queue').all()
    assert.ok(rows.length > 0)
    assert.ok(rows.every((row) => row.state === 'failed' && row.attempts === 1))
    assert.ok(
      rows.every(
        (row) =>
          JSON.parse(row.issue).message ===
          'Document preparation stopped before a valid review was ready.'
      )
    )
    assert.equal(s.intake.running, false)
    assert.equal(s.intake.activeScope, null)
    assert.equal(s.j.db.prepare('select count(*) count from workflow_locks').get().count, 0)
  } finally {
    s.close()
  }
})
