// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultLimits } from '../../companion/configuration.mjs'
import { defaultFilingRules } from '../../src/domain/filing.ts'
import { DocumentTrash } from '../../companion/document-trash.mjs'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-document-trash-')),
    dbPath = join(dir, 'state.sqlite3'),
    j = new ProposalJournal(dbPath),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity()
  await api.move('Inbox/english.pdf', 'Docs/invoice.pdf', '"v1"')
  w.metadata = new Metadata(w)
  w.configuration = {
    settings: () => ({ rules: { root: 'Docs' }, limits: { maxMiB: 100 } }),
    destinationSpace: () => actor.space
  }
  const trash = (w.documentTrash = new DocumentTrash(w)),
    source = await api.stat('Docs/invoice.pdf'),
    bytes = await api.get(source.path),
    input = {
      id: randomUUID(),
      path: source.path,
      documentSpace: actor.space,
      resourceId: source.resourceId,
      etag: source.etag,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  let deletes = 0
  const original = api.trash.bind(api)
  api.trash = async (...args) => {
    deletes++
    return original(...args)
  }
  return {
    dir,
    dbPath,
    j,
    w,
    api,
    actor,
    trash,
    input,
    bytes,
    get deletes() {
      return deletes
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('explicitly trashes the exact library file once, retains its bytes and metadata, and audits the recoverable move', async () => {
  const s = await setup()
  try {
    s.j.db
      .prepare('insert into metadata values(?,?,?,?,?)')
      .run(
        s.w.scope(s.actor),
        s.input.resourceId,
        1,
        '{"reference":"KEEP"}',
        new Date().toISOString()
      )
    const result = await s.trash.process(s.actor, s.api, s.input)
    assert.equal(result.state, 'trashed')
    assert.equal(s.deletes, 1)
    assert.equal(await s.api.stat(s.input.path), null)
    assert.deepEqual(
      Buffer.from(
        s.j.db.prepare('select data from demo_trash where resourceId=?').get(s.input.resourceId)
          .data
      ),
      s.bytes
    )
    assert.equal(s.w.metadata.read(s.actor, s.input.resourceId).fields.reference, 'KEEP')
    assert.equal(s.trash.list(s.actor).length, 0)
    await s.trash.process(s.actor, s.api, s.input)
    assert.equal(s.deletes, 1)
    assert.equal(s.w.history(s.actor).filter((row) => row.kind === 'document_trashed').length, 1)
  } finally {
    s.close()
  }
})
test('stale identities, hashes, destination boundaries and unreadable Trash hold before any DELETE', async () => {
  for (const reason of ['resource', 'etag', 'sha', 'path', 'space', 'permission', 'trash']) {
    const s = await setup()
    try {
      const input = { ...s.input }
      if (reason === 'resource') input.resourceId = 'wrong'
      if (reason === 'etag') input.etag = 'wrong'
      if (reason === 'sha') input.sha256 = '0'.repeat(64)
      if (reason === 'path') input.path = 'Inbox/english.pdf'
      if (reason === 'space') input.documentSpace = 'other'
      if (reason === 'permission') s.api.identity = async () => ({ ...s.actor, account: 'other' })
      if (reason === 'trash')
        s.api.listTrash = async () => {
          throw Error('unavailable')
        }
      await assert.rejects(s.trash.process(s.actor, s.api, input))
      assert.equal(s.deletes, 0)
      assert.ok(await s.api.stat(s.input.path))
      assert.equal(s.trash.list(s.actor).length, 0)
    } finally {
      s.close()
    }
  }
})
test('a lost committed Trash response verifies by identity and never repeats DELETE after restoration', async () => {
  const s = await setup()
  try {
    const original = s.api.trash.bind(s.api)
    s.api.trash = async (...args) => {
      await original(...args)
      throw Error('lost response')
    }
    assert.equal((await s.trash.process(s.actor, s.api, s.input)).state, 'trashed')
    const row = s.j.db
      .prepare('select * from demo_trash where resourceId=?')
      .get(s.input.resourceId)
    s.j.db
      .prepare('insert into demo_files values(?,?,?,?,?,?)')
      .run(row.path, row.resourceId, row.etag, row.tags, 0, row.data)
    await s.trash.process(s.actor, s.api, s.input)
    assert.equal(s.deletes, 1)
    assert.ok(await s.api.stat(s.input.path))
  } finally {
    s.close()
  }
})
test('an unknown Trash outcome remains read-only across restart and blocks new requests or metadata writes', async () => {
  const s = await setup()
  try {
    s.api.trash = async () => {
      throw Error('unknown')
    }
    const result = await s.trash.process(s.actor, s.api, s.input)
    assert.equal(result.uncertain, true)
    assert.deepEqual(s.trash.pending(s.actor, s.input.resourceId), { id: s.input.id })
    await assert.rejects(
      s.w.metadata.save(s.actor, s.api, { ...s.input, version: 0, fields: {}, addTags: [] }),
      /pending Trash/
    )
    await assert.rejects(
      s.trash.process(s.actor, s.api, { ...s.input, id: randomUUID() }),
      /pending Trash/
    )
    const j = new ProposalJournal(s.dbPath),
      w = new Workflow(j),
      trash = (w.documentTrash = new DocumentTrash(w))
    try {
      s.api.trash = async () => {
        throw Error('must not execute')
      }
      assert.equal(
        (await trash.process(s.actor, s.api, { id: s.input.id }, { verifyOnly: true })).uncertain,
        true
      )
      assert.equal(trash.list(s.actor).length, 1)
      assert.ok(await s.api.stat(s.input.path))
      await assert.rejects(
        trash.process(
          { ...s.actor, account: 'other' },
          s.api,
          { id: s.input.id },
          { verifyOnly: true }
        ),
        /not found/
      )
    } finally {
      j.close()
    }
  } finally {
    s.close()
  }
})
test('pending metadata and existing filing decisions prevent Trash before any write', async () => {
  for (const pending of ['metadata', 'filing']) {
    const s = await setup()
    try {
      const scope = s.w.scope(s.actor)
      if (pending === 'metadata')
        s.j.db
          .prepare('insert into metadata_changes values(?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            scope,
            s.input.resourceId,
            s.input.path,
            s.input.sha256,
            s.input.etag,
            0,
            '{}',
            '[]',
            'intent',
            new Date().toISOString()
          )
      else {
        s.j.db
          .prepare(
            'insert into proposals(id,scope,input,configuration,state,updated) values(?,?,?,?,?,?)'
          )
          .run(
            'job',
            scope,
            JSON.stringify({ source: { resourceId: s.input.resourceId } }),
            '{}',
            'needs_review',
            new Date().toISOString()
          )
        s.j.db
          .prepare('insert into decisions(job,actor,record,state,updated) values(?,?,?,?,?)')
          .run('job', s.actor.account, '{}', 'approved', new Date().toISOString())
      }
      await assert.rejects(s.trash.process(s.actor, s.api, s.input), /verify/i)
      assert.equal(s.deletes, 0)
      assert.ok(await s.api.stat(s.input.path))
    } finally {
      s.close()
    }
  }
})
test('preparation protects its own resource while another document can be moved to Trash', async () => {
  const s = await setup()
  s.w.configuration.settings = () => ({
    rules: { ...defaultFilingRules(), root: 'Docs' },
    limits: defaultLimits()
  })
  let entered, finish
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (finish = r))
  s.w.journal.prepare = async () => {
    entered()
    await gate
    return { id: 'synthetic', cached: false, review: { state: 'needs_review', bundle: {} } }
  }
  let running
  try {
    running = s.w.prepare(s.actor, s.api, s.input.path, { policy: { ocr: 'off' } })
    await started
    await assert.rejects(
      s.trash.process(s.actor, s.api, s.input),
      (e) => e.trashRecorded === false && /document is busy/.test(e.message)
    )
    assert.equal(s.deletes, 0)
    await s.api.move('Inbox/japanese.pdf', 'Docs/other.pdf', '"v1"')
    const other = await s.api.stat('Docs/other.pdf'),
      bytes = await s.api.get(other.path),
      result = await s.trash.process(s.actor, s.api, {
        id: randomUUID(),
        path: other.path,
        documentSpace: s.actor.space,
        resourceId: other.resourceId,
        etag: other.etag,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    assert.equal(result.state, 'trashed')
    assert.ok(await s.api.stat(s.input.path))
    finish()
    await running
    assert.equal((await s.trash.process(s.actor, s.api, s.input)).state, 'trashed')
  } finally {
    finish()
    await running?.catch(() => {})
    s.close()
  }
})
test('a Trash intent locks its resource against preparation before any document bytes can be read', async () => {
  const s = await setup()
  let entered, finish
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (finish = r))
  const original = s.api.listTrash.bind(s.api)
  s.api.listTrash = async () => {
    entered()
    await gate
    return original()
  }
  let trashing
  try {
    trashing = s.trash.process(s.actor, s.api, s.input)
    await started
    const get = s.api.get
    s.api.get = async () => assert.fail('A busy resource must not be read by preparation')
    await assert.rejects(
      s.w.prepare(s.actor, s.api, s.input.path, { policy: { ocr: 'off' } }),
      /already running/
    )
    s.api.get = get
    finish()
    assert.equal((await trashing).state, 'trashed')
  } finally {
    finish()
    await trashing?.catch(() => {})
    s.close()
  }
})
test('a document queued for preparation remains protected from Trash without blocking unrelated files', async () => {
  const s = await setup()
  try {
    const { Operations } = await import('../../companion/operations.mjs'),
      operations = new Operations(s.w, {})
    operations.stopped = true
    operations.start(s.actor, s.api, {
      id: randomUUID(),
      kind: 'prepare',
      items: [{ path: s.input.path, resourceId: s.input.resourceId, etag: s.input.etag }]
    })
    await assert.rejects(
      s.trash.process(s.actor, s.api, s.input),
      (e) => e.trashRecorded === false && /pending bulk/.test(e.message)
    )
    assert.equal(s.deletes, 0)
    assert.equal(s.trash.list(s.actor).length, 0)
  } finally {
    s.close()
  }
})
