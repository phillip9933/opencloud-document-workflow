// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { createDraftAPI } from '../../companion/draft-api.mjs'
import { defaultPolicy } from '../../src/domain/review.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-recovery-'))
  const database = join(directory, 'journal.sqlite3')
  const journal = new ProposalJournal(database)
  const workflow = new Workflow(journal)
  const adapter = new DemoAdapter(journal.db)
  adapter.seed()
  return {
    directory,
    database,
    journal,
    workflow,
    adapter,
    close() {
      journal.close()
      rmSync(directory, { recursive: true })
    }
  }
}

for (const host of [hostname(), 'previous-container']) {
  test(`abandoned locks recover with a reused PID and host ${host === hostname() ? 'unchanged' : 'changed'}`, () => {
    const f = fixture()
    try {
      f.journal.db
        .prepare('insert into workflow_locks values(?,?,?,?)')
        .run('__prepare__', 'previous-runtime', process.pid, host)
      const release = f.workflow.lock('__prepare__')
      assert.throws(() => f.workflow.lock('__prepare__'), /already running/)
      release()
      assert.equal(f.journal.db.prepare('select count(*) n from workflow_locks').get().n, 0)
    } finally {
      f.close()
    }
  })
}

test('interrupted proposal can retry without trusting a reused PID or prior hostname', async () => {
  const f = fixture()
  try {
    const actor = await f.adapter.identity()
    const configuration = {
      policy: { ...defaultPolicy(), aiInput: 'off', aiOutput: 'off', ocr: 'off' },
      rulesOnly: true
    }
    const first = await f.workflow.prepare(actor, f.adapter, 'Inbox/english.pdf', configuration)
    f.journal.db
      .prepare(
        "update proposals set result=NULL,state='running',owner='old-runtime',pid=?,host=? where id=?"
      )
      .run(process.pid, 'previous-container', first.id)
    const retried = await f.workflow.prepare(actor, f.adapter, 'Inbox/english.pdf', configuration, {
      retry: true
    })
    assert.equal(retried.id, first.id)
    assert.equal(retried.bundle.proposal, null)
    assert.equal(f.journal.db.prepare('select count(*) n from decisions').get().n, 0)
  } finally {
    f.close()
  }
})

test('prepare contention never consumes intake attempts; release resumes the same files', async () => {
  const f = fixture()
  let now = 1000000
  const actor = await f.adapter.identity()
  const intake = new Intake(f.workflow, {
    now: () => now,
    prepare: async () => {
      const release = f.workflow.lock('__prepare__')
      try {
        return { id: 'fixture-review' }
      } finally {
        release()
      }
    }
  })
  try {
    intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, f.adapter)
    await intake.tick({ force: true })
    const release = f.workflow.lock('__prepare__')
    try {
      for (let i = 0; i < 4; i++) {
        now += 300000
        await intake.tick({ force: true })
      }
      const rows = intake.status(actor).queue
      assert.equal(rows.length, 3)
      assert.ok(rows.every((row) => row.state === 'queued' && row.attempts === 0))
    } finally {
      release()
    }
    now += 300000
    await intake.tick({ force: true })
    assert.ok(
      intake.status(actor).queue.every((row) => row.state === 'prepared' && row.attempts === 1)
    )
    assert.equal(f.journal.db.prepare('select count(*) n from decisions').get().n, 0)
  } finally {
    await intake.stop()
    f.close()
  }
})

test('audit write failure after a response cannot send a second response or reject the handler', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-response-'))
  const database = join(directory, 'journal.sqlite3')
  const api = createDraftAPI({
    database,
    allowOrigin: 'http://localhost',
    backgroundDisconnect: async () => ({ connected: false })
  })
  const db = new DatabaseSync(database)
  db.exec(
    "CREATE TRIGGER fail_disconnect_event BEFORE INSERT ON activity WHEN NEW.kind='background_app_token_disconnected' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END"
  )
  let sends = 0
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead(status) {
      assert.equal(this.headersSent, false, 'second response')
      this.headersSent = true
      this.status = status
      sends++
    },
    end(value) {
      this.writableEnded = true
      this.body = JSON.parse(value)
    }
  }
  const request = {
    url: '/_workflow/api/background-disconnect',
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}')
    }
  }
  try {
    await api.handle(request, response)
    assert.equal(sends, 1)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { connected: false })
  } finally {
    db.close()
    api.close()
    rmSync(directory, { recursive: true })
  }
})

test('SIGKILL releases runtime ownership; restart preserves uncertain writes and recovers reads', async () => {
  const { spawn, spawnSync } = await import('node:child_process')
  const { once } = await import('node:events')
  const directory = mkdtempSync(join(tmpdir(), 'workflow-killed-'))
  const database = join(directory, 'journal.sqlite3')
  const journalURL = new URL('../../companion/journal.mjs', import.meta.url).href
  const workflowURL = new URL('../../companion/workflow.mjs', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ProposalJournal } from ${JSON.stringify(journalURL)};
    import { Workflow } from ${JSON.stringify(workflowURL)};
    const journal = new ProposalJournal(process.argv[1]);
    const workflow = new Workflow(journal);
    workflow.lock('__prepare__');
    journal.db.prepare("insert into proposals(id,scope,input,configuration,state,owner,pid,host,updated) values(?,?,?,?,?,?,?,?,?)").run('interrupted','scope','{}','{}','running','old',process.pid,'previous-container','old-time');
    journal.db.prepare("insert into decisions values(?,?,?,?,?,?)").run('uncertain','actor','exact-approval','move_intent','exact-intent','old-time');
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
      database
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  )
  let errors = ''
  child.stderr.on('data', (data) => {
    errors += data
  })
  let journal
  try {
    await new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`Fixture exited ${code}: ${errors}`)))
    })
    const competing = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { ProposalJournal } from ${JSON.stringify(journalURL)};
      try { new ProposalJournal(process.argv[1]).close(); process.exit(1) }
      catch (error) { process.exit(error.code === 'RUNTIME_BUSY' ? 0 : 2) }
    `,
        database
      ],
      { encoding: 'utf8' }
    )
    assert.equal(competing.status, 0, competing.stderr)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    journal = new ProposalJournal(database)
    const workflow = new Workflow(journal)
    workflow.lock('__prepare__')()
    assert.equal(journal.get('interrupted').state, 'failed')
    assert.equal(journal.get('interrupted').error, 'Preparation interrupted; retry required')
    const intent = journal.db.prepare('select * from decisions').get()
    assert.equal(intent.state, 'move_intent')
    assert.equal(intent.record, 'exact-approval')
    assert.equal(intent.plan, 'exact-intent')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    journal?.close()
    rmSync(directory, { recursive: true })
  }
})

test('another journal handle cannot steal an active proposal or resource lock', async () => {
  const f = fixture()
  const second = new ProposalJournal(f.database)
  let finish
  try {
    const release = f.workflow.lock('resource:fixture')
    assert.throws(() => new Workflow(second).lock('resource:fixture'), { code: 'WORKFLOW_BUSY' })
    release()
    const { samples } = await import('../../src/domain/samples.ts')
    const { validateBundle } = await import('../../src/domain/review.ts')
    const { proposal, ...input } = samples()[0]
    const config = { policy: defaultPolicy(), endpoint: 'http://localhost:11434', model: 'fixture' }
    const pending = f.journal.prepare(input, config, {
      planner: () =>
        new Promise((resolve) => {
          finish = () => resolve(validateBundle({ ...input, proposal }))
        })
    })
    await assert.rejects(second.prepare(input, config, { retry: true }), /still running/)
    finish()
    await pending
  } finally {
    finish?.()
    second.close()
    f.close()
  }
})

test('outer HTTP boundary handles errors before, during and after the response', async () => {
  const { handleRequest } = await import('../../companion/http-handler.mjs')
  for (const phase of ['before', 'partial', 'finished']) {
    let heads = 0,
      destroyed = false
    const response = {
      headersSent: false,
      writableEnded: false,
      writeHead(status) {
        assert.equal(this.headersSent, false)
        this.headersSent = true
        this.status = status
        heads++
      },
      end() {
        this.writableEnded = true
      },
      destroy() {
        destroyed = true
      }
    }
    await handleRequest(async (_request, res) => {
      if (phase !== 'before') res.writeHead(200)
      if (phase === 'finished') res.end()
      throw new Error('synthetic failure')
    })({}, response)
    assert.equal(heads, 1)
    assert.equal(response.status, phase === 'before' ? 404 : 200)
    assert.equal(destroyed, phase === 'partial')
  }
})

test('unexpected intake worker failures update health and recover on the next check', async () => {
  const f = fixture(),
    logged = []
  const actor = await f.adapter.identity()
  const intake = new Intake(f.workflow, { logger: (event) => logged.push(event) })
  try {
    intake.save(actor, { ...defaultIntake(), enabled: true }, f.adapter)
    await intake.tick({ force: true })
    assert.equal(intake.status(actor).health.state, 'ready')
    const lock = f.workflow.lock.bind(f.workflow)
    f.workflow.lock = () => {
      throw Error('private storage failure')
    }
    assert.equal(await intake.tick({ force: true }), false)
    const health = intake.status(actor).health
    assert.equal(health.state, 'held')
    assert.equal(health.reason, 'worker')
    assert.doesNotMatch(JSON.stringify(health), /private storage failure/)
    assert.deepEqual(logged, ['intake_worker_failed'])
    f.workflow.lock = lock
    await intake.tick({ force: true })
    assert.equal(intake.status(actor).health.state, 'ready')
  } finally {
    await intake.stop()
    f.close()
  }
})

test('preparation always supplies a finite download limit even without a settings service', async () => {
  const f = fixture()
  try {
    const actor = await f.adapter.identity()
    const get = f.adapter.get.bind(f.adapter)
    const bounds = []
    f.adapter.get = async (path, etag, limit) => {
      bounds.push(limit)
      return get(path, etag, limit)
    }
    const configuration = {
      policy: { ...defaultPolicy(), aiInput: 'off', aiOutput: 'off', ocr: 'off' },
      rulesOnly: true
    }
    await f.workflow.prepare(actor, f.adapter, 'Inbox/english.pdf', configuration)
    assert.deepEqual(bounds, [100 * 1024 * 1024])
    f.workflow.configuration = { settings: () => ({ limits: { maxMiB: NaN } }) }
    await assert.rejects(
      f.workflow.prepare(actor, f.adapter, 'Inbox/english.pdf', configuration),
      /capacity/
    )
    assert.equal(bounds.length, 1)
  } finally {
    f.close()
  }
})
