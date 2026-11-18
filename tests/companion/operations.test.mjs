// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { Operations } from '../../companion/operations.mjs'
const actor = { server: 'https://example.org', account: 'person', space: 'one' }
test('bulk work retains per-document results and cannot be replayed using the same operation ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-')),
    j = new ProposalJournal(join(dir, 'db.sqlite3')),
    w = new Workflow(j)
  let calls = 0
  const operations = new Operations(w, {
      prepare: async (_actor, _api, path) => {
        calls++
        if (path.includes('held')) throw new Error('Source changed')
        return { id: path, state: 'needs_review' }
      }
    }),
    api = { identity: async () => actor },
    request = {
      id: randomUUID(),
      kind: 'prepare',
      items: [{ path: 'Inbox/one.pdf' }, { path: 'Inbox/held.pdf' }, { path: 'Inbox/three.pdf' }]
    }
  try {
    operations.start(actor, api, request)
    await operations.active.get(request.id)
    const result = operations.status(actor, request.id)
    assert.equal(result.state, 'completed')
    assert.deepEqual(
      result.items.map((i) => i.state),
      ['done', 'held', 'done']
    )
    assert.equal(calls, 3)
    operations.start(actor, api, request)
    operations.launch(actor, api, request.id)
    await operations.active.get(request.id)
    assert.equal(calls, 3)
    assert.throws(
      () => operations.start(actor, api, { ...request, items: [{ path: 'different.pdf' }] }),
      /different request/
    )
    assert.throws(() => operations.status({ ...actor, space: 'other' }, request.id), /not found/)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('access expiry holds each remaining item before processing and interrupted items are never blindly retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-recovery-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j)
  let calls = 0
  const operations = new Operations(w, {
      prepare: async () => {
        calls++
        return { state: 'done' }
      }
    }),
    request = {
      id: randomUUID(),
      kind: 'prepare',
      items: [{ path: 'Inbox/one.pdf' }, { path: 'Inbox/two.pdf' }]
    }
  try {
    operations.stopped = true
    operations.start(actor, { identity: async () => actor }, request)
    w.db
      .prepare("update bulk_items set state='running' where operation=? and position=0")
      .run(request.id)
    operations.stopped = false
    operations.launch(
      actor,
      { identity: async () => ({ ...actor, account: 'different' }) },
      request.id
    )
    await operations.active.get(request.id)
    assert.deepEqual(
      operations.status(actor, request.id).items.map((i) => i.state),
      ['held', 'held']
    )
    assert.equal(calls, 0)
    assert.match(operations.status(actor, request.id).items[0].result.error, /not repeated/)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('bulk filing verifies each plan, preserves successful files around a collision, and remains non-replaying after reopen', async () => {
  const { DemoAdapter } = await import('../../companion/demo.mjs'),
    { Metadata } = await import('../../companion/metadata.mjs'),
    { samples } = await import('../../src/domain/samples.ts'),
    { defaultPolicy, reviewDigest, validateBundle } = await import('../../src/domain/review.ts')
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-filing-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    api = new DemoAdapter(j.db),
    metadata = (w.metadata = new Metadata(w))
  api.seed()
  const actor = await api.identity(),
    original = j.db.prepare("select data from demo_files where resourceId='demo-english'").get()
  j.db
    .prepare('insert into demo_files values(?,?,?,?,?,?)')
    .run('Inbox/alias.pdf', 'english-alias', '"v1"', '[]', 0, original.data)
  const policy = defaultPolicy(),
    configuration = { endpoint: 'http://127.0.0.1:11434', model: 'fixture', policy },
    prepare = j.prepare.bind(j)
  j.prepare = (input, config, options) =>
    prepare(input, config, {
      ...options,
      planner: async (value) => {
        const proposal = structuredClone(
          samples()[value.source.resourceId.includes('japanese') ? 1 : 0].proposal
        )
        proposal.tags = proposal.tags.filter((t) => !['Japanese'].includes(t.value))
        return validateBundle({ ...value, proposal })
      }
    })
  const operations = new Operations(w, { metadata }),
    items = []
  let moves = 0
  const move = api.move.bind(api)
  api.move = async (...args) => {
    moves++
    return move(...args)
  }
  try {
    for (const path of ['Inbox/english.pdf', 'Inbox/alias.pdf', 'Inbox/japanese.pdf']) {
      const job = await w.prepare(actor, api, path, configuration)
      items.push({
        id: job.id,
        policy,
        reviewDigest: await reviewDigest(validateBundle(job.bundle), policy)
      })
    }
    const id = randomUUID()
    operations.start(actor, api, { id, kind: 'file', items })
    await operations.active.get(id)
    assert.deepEqual(
      operations.status(actor, id).items.map((i) => i.state),
      ['done', 'held', 'done']
    )
    assert.equal(moves, 2)
    assert.ok(await api.stat('Inbox/alias.pdf'))
    assert.equal(w.decision(actor, items[1].id).state, 'conflict')
    assert.ok(JSON.parse(w.decision(actor, items[0].id).record).reviewedAt)
    const second = new ProposalJournal(path)
    try {
      const restored = new Operations(new Workflow(second), {
        metadata: new Metadata(new Workflow(second))
      })
      restored.launch(
        actor,
        {
          identity: async () => {
            assert.fail('Completed/held items must not authenticate or mutate again')
          }
        },
        id
      )
      await restored.active.get(id)
      assert.deepEqual(
        restored.status(actor, id).items.map((i) => i.state),
        ['done', 'held', 'done']
      )
      await restored.stop()
    } finally {
      second.close()
    }
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('bulk operations use the latest verified session between items and pause remaining work on expiry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-session-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  let current = { identity: async () => actor, name: 'one' },
    seen = []
  const operations = new Operations(w, {
    session: () => current,
    prepare: async (_actor, api) => {
      seen.push(api.name)
      current = {
        identity: async () => {
          throw Object.assign(Error('expired'), { status: 401 })
        }
      }
    }
  })
  const id = randomUUID()
  try {
    operations.start(actor, current, {
      id,
      kind: 'prepare',
      items: [{ path: 'one.pdf' }, { path: 'two.pdf' }, { path: 'three.pdf' }]
    })
    await operations.active.get(id)
    assert.deepEqual(seen, ['one'])
    assert.equal(operations.status(actor, id).state, 'paused')
    assert.deepEqual(
      operations.status(actor, id).items.map((i) => i.state),
      ['done', 'queued', 'queued']
    )
    current = { identity: async () => actor, name: 'renewed' }
    operations.prepare = async (_actor, api) => {
      seen.push(api.name)
    }
    operations.launch(actor, current, id)
    await operations.active.get(id)
    assert.deepEqual(seen, ['one', 'renewed', 'renewed'])
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('bulk preparation holds a replaced selection before OCR or any model request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-selected-preparation-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  let calls = 0
  const operations = new Operations(w, {
      prepare: async () => {
        calls++
      }
    }),
    api = {
      identity: async () => actor,
      stat: async () => ({ resourceId: 'replacement', etag: '"changed"' })
    },
    id = randomUUID()
  try {
    operations.start(actor, api, {
      id,
      kind: 'prepare',
      items: [
        { path: 'Inbox/selected.pdf', resourceId: 'selected', etag: '"original"', newReview: true }
      ]
    })
    await operations.active.get(id)
    assert.equal(calls, 0)
    assert.equal(operations.status(actor, id).items[0].state, 'held')
    assert.match(operations.status(actor, id).items[0].result.error, /changed before preparation/)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('processing pause finishes the active preparation, and cancel keeps remaining files unprocessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-processing-controls-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  let paused = false,
    finish,
    started
  const begun = new Promise((resolve) => {
    started = resolve
  })
  w.intake = { paused: () => paused }
  const calls = []
  const operations = new Operations(w, {
      prepare: async (_actor, _api, path) => {
        calls.push(path)
        started()
        await new Promise((resolve) => {
          finish = resolve
        })
        return { state: 'needs_review' }
      }
    }),
    api = { identity: async () => actor },
    id = randomUUID()
  try {
    operations.start(actor, api, {
      id,
      kind: 'prepare',
      items: [{ path: 'one.pdf' }, { path: 'two.pdf' }, { path: 'three.pdf' }]
    })
    await begun
    paused = true
    finish()
    await operations.active.get(id)
    assert.deepEqual(calls, ['one.pdf'])
    assert.equal(operations.status(actor, id).state, 'paused')
    assert.equal(operations.cancelProcessing(actor), 2)
    assert.deepEqual(
      operations.status(actor, id).items.map((i) => i.state),
      ['done', 'cancelled', 'cancelled']
    )
    paused = false
    operations.resumeProcessing(actor, api)
    assert.deepEqual(calls, ['one.pdf'])
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('retry-all never repeats uncertain conversion, metadata or filing writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-processing-retry-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  const operations = new Operations(w, {}),
    api = { identity: async () => actor }
  try {
    operations.stopped = true
    for (const kind of ['convert', 'metadata', 'file']) {
      const id = randomUUID()
      operations.start(actor, api, { id, kind, items: [{ path: 'one.pdf' }] })
      j.db.prepare("update bulk_items set state='held' where operation=?").run(id)
      j.db.prepare("update bulk_operations set state='held' where id=?").run(id)
    }
    assert.equal(operations.retryProcessing(actor, api), 0)
    assert.equal(j.db.prepare("select count(*) n from bulk_items where state='held'").get().n, 3)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('processing summary counts only scoped preparation work and safe retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-processing-summary-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j),
    operations = new Operations(w, {}),
    api = { identity: async () => actor }
  try {
    operations.stopped = true
    const id = randomUUID()
    operations.start(actor, api, {
      id,
      kind: 'prepare',
      items: [{ path: 'one.pdf' }, { path: 'two.pdf' }, { path: 'three.pdf' }]
    })
    j.db.prepare("update bulk_operations set state='paused' where id=?").run(id)
    j.db.prepare("update bulk_items set state='held' where operation=? and position=0").run(id)
    j.db.prepare("update bulk_items set state='running' where operation=? and position=1").run(id)
    assert.deepEqual(operations.processingSummary(actor), {
      waiting: 1,
      running: 1,
      retryable: 1,
      cancellable: 1
    })
    assert.deepEqual(operations.processingSummary({ ...actor, space: 'other' }), {
      waiting: 0,
      running: 0,
      retryable: 0,
      cancellable: 0
    })
    operations.cancelProcessing(actor)
    assert.equal(operations.processingSummary(actor).waiting, 0)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('a held preparation retains the stage that actually failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-held-stage-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j),
    operations = new Operations(w, {
      prepare: async (_actor, _api, _path, { onProgress }) => {
        onProgress('analysing')
        throw Error('AI service unavailable')
      }
    }),
    id = randomUUID()
  try {
    operations.start(
      actor,
      { identity: async () => actor },
      { id, kind: 'prepare', items: [{ path: 'Inbox/test.pdf' }] }
    )
    await operations.active.get(id)
    const item = operations.status(actor, id).items[0]
    assert.equal(item.state, 'held')
    assert.equal(item.result.stage, 'analysing')
    assert.equal(operations.processingSummary(actor).retryable, 1)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('a missing session pauses the entire remaining batch without turning queued documents into held results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-no-session-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j),
    operations = new Operations(w, {
      session: () => null,
      prepare: async () => assert.fail('No unauthenticated preparation')
    }),
    id = randomUUID()
  try {
    operations.start(
      actor,
      {},
      { id, kind: 'prepare', items: [{ path: 'one.pdf' }, { path: 'two.pdf' }] }
    )
    await operations.active.get(id)
    assert.equal(operations.status(actor, id).state, 'paused')
    assert.deepEqual(
      operations.status(actor, id).items.map((i) => i.state),
      ['queued', 'queued']
    )
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('targeted held retry preserves completed results, source pins, cancellations and unrelated operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-targeted-retry-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  let paused = true
  w.intake = { paused: () => paused }
  const seen = [],
    api = {
      identity: async () => actor,
      stat: async () => ({ resourceId: 'selected', etag: 'v1' })
    },
    operations = new Operations(w, {
      prepare: async (_actor, _api, path, options) => {
        seen.push({ path, options })
        return { state: 'needs_review' }
      }
    }),
    id = randomUUID(),
    other = randomUUID()
  try {
    operations.stopped = true
    for (const key of [id, other]) {
      operations.start(actor, api, {
        id: key,
        kind: 'prepare',
        items: [
          { path: 'kept.pdf' },
          { path: 'retry.pdf', resourceId: 'selected', etag: 'v1', newReview: true },
          { path: 'cancelled.pdf' }
        ]
      })
      j.db.prepare("update bulk_operations set state='completed' where id=?").run(key)
      j.db
        .prepare("update bulk_items set state='done',result=? where operation=? and position=0")
        .run(JSON.stringify({ id: 'kept-result' }), key)
      j.db.prepare("update bulk_items set state='held' where operation=? and position=1").run(key)
      j.db
        .prepare("update bulk_items set state='cancelled' where operation=? and position=2")
        .run(key)
    }
    operations.stopped = false
    assert.equal(operations.retryHeld(actor, api, id).retried, 1)
    assert.deepEqual(
      operations.status(actor, id).items.map((i) => i.state),
      ['done', 'queued', 'cancelled']
    )
    assert.equal(operations.status(actor, other).items[1].state, 'held')
    assert.deepEqual(operations.status(actor, id).items[0].result, { id: 'kept-result' })
    assert.throws(() => operations.retryHeld({ ...actor, account: 'other' }, api, id), /not found/)
    paused = false
    operations.resumeProcessing(actor, api)
    await operations.active.get(id)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].path, 'retry.pdf')
    assert.equal(seen[0].options.expectedResourceId, 'selected')
    assert.equal(seen[0].options.expectedEtag, 'v1')
    assert.equal(seen[0].options.newReview, true)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})

test('current-inbox batch retry excludes absent, changed and other-Space sources without hiding active work or deleting history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-current-bulk-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j),
    operations = new Operations(w, {}),
    api = { identity: async () => actor },
    id = randomUUID()
  try {
    operations.stopped = true
    operations.start(actor, api, {
      id,
      kind: 'prepare',
      items: [
        { path: 'Inbox/present.pdf', resourceId: 'present', etag: 'v1' },
        { path: 'Inbox/gone.pdf', resourceId: 'gone', etag: 'v1' },
        { path: 'Inbox/present.pdf', resourceId: 'other', etag: 'v1' },
        { path: 'Inbox/present.pdf', resourceId: 'present', etag: 'v1', documentSpace: 'other' }
      ]
    })
    j.db.prepare("update bulk_operations set state='completed' where id=?").run(id)
    j.db
      .prepare("update bulk_items set state='held',result=? where operation=?")
      .run(JSON.stringify({ error: 'Original held result' }), id)
    const files = [{ path: 'Inbox/present.pdf', resourceId: 'present', etag: 'v1' }]
    assert.equal(operations.processingSummary(actor).retryable, 4)
    assert.equal(operations.processingSummary(actor, files).retryable, 1)
    assert.equal(operations.processingSummary(actor, []).retryable, 0)
    assert.equal(operations.retryProcessing(actor, api, files), 1)
    const results = operations.status(actor, id).items
    assert.deepEqual(
      results.map((item) => item.state),
      ['queued', 'held', 'held', 'held']
    )
    assert.ok(results.slice(1).every((item) => item.result.error === 'Original held result'))
    assert.equal(operations.processingSummary(actor, []).waiting, 1)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})

test('bulk prepare contention leaves the batch queued and resumes after the lock releases', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-busy-'))
  const j = new ProposalJournal(join(dir, 'db.sqlite3')),
    w = new Workflow(j)
  let calls = 0
  const operations = new Operations(w, {
    prepare: async () => {
      calls++
      const release = w.lock('__prepare__')
      release()
      return { state: 'needs_review' }
    }
  })
  const api = { identity: async () => actor }
  const request = {
    id: randomUUID(),
    kind: 'prepare',
    items: [{ path: 'Inbox/one.pdf' }, { path: 'Inbox/two.pdf' }]
  }
  const release = w.lock('__prepare__')
  try {
    operations.start(actor, api, request)
    await operations.active.get(request.id)
    assert.deepEqual(
      operations.status(actor, request.id).items.map((i) => i.state),
      ['queued', 'queued']
    )
    assert.equal(calls, 1)
    release()
    t.mock.timers.tick(1000)
    await operations.active.get(request.id)
    assert.deepEqual(
      operations.status(actor, request.id).items.map((i) => i.state),
      ['done', 'done']
    )
    assert.equal(j.db.prepare('select count(*) n from decisions').get().n, 0)
  } finally {
    release()
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})

test('a pending automatic result is not recorded as completed by its batch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = mkdtempSync(join(tmpdir(), 'workflow-bulk-pending-'))
  const j = new ProposalJournal(join(dir, 'db.sqlite3')),
    w = new Workflow(j)
  let calls = 0
  w.automation = { run: async () => ({ state: ++calls === 1 ? 'pending' : 'done' }) }
  const operations = new Operations(w, {})
  const api = { identity: async () => actor }
  const request = { id: randomUUID(), kind: 'automatic', items: [{ id: 'synthetic-job' }] }
  try {
    operations.start(actor, api, request)
    await operations.active.get(request.id)
    assert.equal(operations.status(actor, request.id).items[0].state, 'queued')
    t.mock.timers.tick(1000)
    await operations.active.get(request.id)
    assert.equal(operations.status(actor, request.id).items[0].state, 'done')
    assert.equal(calls, 2)
  } finally {
    await operations.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})

test('batch history pages redact cached evidence, check document reads for detail and run beyond page one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-page-')),
    journal = new ProposalJournal(join(dir, 'journal')),
    w = new Workflow(journal)
  const id = randomUUID(),
    api = { identity: async () => actor }
  const ops = new Operations(w, {
    prepare: async (_a, _api, path) => ({
      id: path,
      bundle: { pages: ['private fixture'], manualReview: { reason: 'date' } }
    })
  })
  t.after(async () => {
    await ops.stop()
    journal.close()
    rmSync(dir, { recursive: true })
  })
  const items = Array.from({ length: 104 }, (_, n) => ({ path: 'Inbox/' + n + '.pdf' }))
  ops.start(actor, api, { id, kind: 'prepare', items })
  await ops.active.get(id)
  const first = ops.status(actor, id),
    second = ops.status(actor, id, { cursor: first.nextCursor })
  assert.equal(first.items.length, 100)
  assert.equal(first.counts.done, 104)
  assert.deepEqual(
    second.items.map((i) => i.position),
    [100, 101, 102, 103]
  )
  assert.equal(second.nextCursor, null)
  assert.ok(!JSON.stringify(first).includes('private fixture'))
  let allowed = false
  t.mock.method(w, 'requireReadableJob', async (_a, _api, job) => {
    assert.equal(job, items[102].path)
    if (!allowed) throw Error('Read denied')
  })
  await assert.rejects(ops.result(actor, api, id, 102), /Read denied/)
  allowed = true
  assert.deepEqual((await ops.result(actor, api, id, 102)).result.bundle.pages, ['private fixture'])
})

test('batch admission reserves capacity before inserting rows and still accepts idempotent reads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-quota-'))
  const j = new ProposalJournal(join(dir, 'journal')),
    w = new Workflow(j),
    ops = new Operations(w, { prepare: async () => ({}) })
  t.after(() => {
    j.close()
    rmSync(dir, { recursive: true })
  })
  ops.stopped = true
  const api = { identity: async () => actor }
  const request = () => ({ id: randomUUID(), kind: 'prepare', items: [{ path: 'Inbox/test.pdf' }] })
  const first = request()
  ops.start(actor, api, first)
  for (let i = 1; i < 8; i++) ops.start(actor, api, request())
  assert.throws(() => ops.start(actor, api, request()), /capacity/)
  assert.equal(ops.start(actor, api, first).id, first.id)
  assert.equal(j.db.prepare('select count(*) n from bulk_items').get().n, 8)
  const page = ops.list(actor, { limit: 4 })
  const next = ops.list(actor, { limit: 4, cursor: page.nextCursor })
  assert.equal(new Set([...page.operations, ...next.operations].map((r) => r.id)).size, 8)
  assert.equal(next.nextCursor, null)
})

test('large preparation results reference the scoped journal and load only after authorization', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-result-'))
  const j = new ProposalJournal(join(dir, 'journal')),
    w = new Workflow(j)
  t.after(() => {
    j.close()
    rmSync(dir, { recursive: true })
  })
  const id = randomUUID(),
    job = randomUUID(),
    api = { identity: async () => actor }
  const bundle = { pages: ['Synthetic invoice '.repeat(2000)], manualReview: { reason: 'date' } }
  j.db
    .prepare(
      "insert into proposals(id,scope,input,configuration,state,result,updated) values(?,?,'{}','{}','needs_details',?,?)"
    )
    .run(job, w.scope(actor), JSON.stringify(bundle), new Date().toISOString())
  const ops = new Operations(w, { prepare: async () => ({ id: job, bundle }) })
  ops.start(actor, api, { id, kind: 'prepare', items: [{ path: 'Inbox/invoice.pdf' }] })
  await ops.active.get(id)
  assert.ok(
    j.db.prepare('select length(result) n from bulk_items where operation=?').get(id).n < 500
  )
  assert.equal(ops.status(actor, id).items[0].result.manualReview, 'object')
  t.mock.method(w, 'requireReadableJob', async () => {
    throw Error('Read denied')
  })
  await assert.rejects(ops.result(actor, api, id, 0), /Read denied/)
  t.mock.method(w, 'requireReadableJob', async () => {})
  assert.deepEqual((await ops.result(actor, api, id, 0)).result.bundle, bundle)
})
