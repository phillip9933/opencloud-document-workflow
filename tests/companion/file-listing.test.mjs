// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrateJournal } from '../../companion/migrations.mjs'
import { describeFiles } from '../../companion/file-listing.mjs'
import {
  resourceIdentities,
  hasPendingFiling,
  hasPendingAutomation,
  hasPendingMetadata
} from '../../companion/pending-operations.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  migrateJournal(db)
  const actor = { server: 'https://fixture.test', account: 'synthetic', space: 'space' },
    scope = JSON.stringify(Object.values(actor))
  return { db, actor, scope, workflow: { db, scope: () => scope } }
}
function proposal(db, scope, id, resource, etag, state, updated) {
  db.prepare(
    'insert into proposals(id,scope,input,configuration,state,attempts,updated) values(?,?,?,?,?,1,?)'
  ).run(id, scope, JSON.stringify({ source: { resourceId: resource, etag } }), '{}', state, updated)
}
test('listing query count stays fixed as the file count grows and metadata stays scoped', () => {
  const { db, actor, scope, workflow } = fixture()
  try {
    const files = Array.from({ length: 500 }, (_, i) => ({
      path: `Inbox/${i}.pdf`,
      resourceId: `r${i}`,
      etag: 'v1',
      tags: []
    }))
    db.prepare('insert into metadata values(?,?,1,?,?)').run(
      scope,
      'canonical',
      '{"year":2025}',
      '2026'
    )
    db.prepare('insert into resource_aliases values(?,?,?,?)').run(
      scope,
      'r0',
      'space',
      'canonical'
    )
    db.prepare('insert into metadata values(?,?,1,?,?)').run(
      'foreign',
      'r1',
      '{"private":"hidden"}',
      '2026'
    )
    let reads = 0
    const prepare = db.prepare.bind(db)
    db.prepare = (...args) => {
      reads++
      return prepare(...args)
    }
    const one = describeFiles({ workflow }, actor, files.slice(0, 1)),
      oneReads = reads
    reads = 0
    const many = describeFiles({ workflow }, actor, files)
    assert.equal(reads, oneReads)
    assert.equal(reads, 6)
    assert.deepEqual(many[0].fields, one[0].fields)
    assert.deepEqual(many[0].fields, { year: 2025 })
    assert.deepEqual(many[1].fields, {})
    assert.equal(many.length, 500)
    reads = 0
    assert.deepEqual(describeFiles({ workflow }, actor, []), [])
    assert.equal(reads, 0)
  } finally {
    db.close()
  }
})
test('listing retains current ETags, completed automation and newer-review supersession of held batches', () => {
  const { db, actor, scope, workflow } = fixture()
  try {
    const file = { path: 'Inbox/test.pdf', resourceId: 'r', etag: 'v2', tags: [] }
    proposal(db, scope, 'old', 'r', 'v1', 'failed', '2026-01-01')
    assert.equal(describeFiles({ workflow }, actor, [file])[0].reviewJob, null)
    db.prepare('insert into bulk_operations values(?,?,?,?,?,?,?)').run(
      'batch',
      scope,
      'prepare',
      '{}',
      'done',
      '2026-01-02',
      '2026-01-02'
    )
    db.prepare('insert into bulk_items values(?,?,?,?,?)').run(
      'batch',
      0,
      JSON.stringify({ resourceId: 'r', etag: 'v2' }),
      'held',
      JSON.stringify({ error: 'failed', stage: 'ocr', finishedAt: '2026-01-02' })
    )
    assert.equal(describeFiles({ workflow }, actor, [file])[0].intakeState, 'failed')
    proposal(db, scope, 'new', 'r', 'v2', 'needs_review', '2026-01-03')
    const current = describeFiles({ workflow }, actor, [file])[0]
    assert.equal(current.reviewJob, 'new')
    assert.equal(current.intakeState, null)
    db.prepare('insert into automatic_runs values(?,?,?,?,?,?,?)').run(
      'new',
      scope,
      '{}',
      'done',
      null,
      '2026-01-03',
      '2026-01-03'
    )
    assert.equal(describeFiles({ workflow }, actor, [file])[0].intakeState, 'processed')
  } finally {
    db.close()
  }
})
test('pending-operation checks retain aliases, terminal exceptions and scope isolation', () => {
  const { db, scope } = fixture()
  try {
    db.prepare('insert into resource_aliases values(?,?,?,?)').run(
      scope,
      'old',
      'space',
      'canonical'
    )
    const ids = resourceIdentities(db, scope, 'current', 'canonical')
    proposal(db, scope, 'job', 'old', 'v1', 'needs_review', '2026')
    assert.equal(hasPendingFiling(db, scope, ids), false)
    db.prepare('insert into decisions values(?,?,?,?,?,?)').run(
      'job',
      'synthetic',
      '{}',
      'move_intent',
      '{}',
      '2026'
    )
    assert.equal(hasPendingFiling(db, scope, ids), true)
    assert.equal(hasPendingFiling(db, 'foreign', ids), false)
    for (const state of ['done', 'rejected', 'conflict']) {
      db.prepare('update decisions set state=?').run(state)
      assert.equal(hasPendingFiling(db, scope, ids), false)
    }
    db.prepare('insert into automatic_runs values(?,?,?,?,?,?,?)').run(
      'job',
      scope,
      '{}',
      'pending',
      null,
      '2026',
      '2026'
    )
    assert.equal(hasPendingAutomation(db, scope, ids), true)
    db.prepare("update automatic_runs set state='done'").run()
    assert.equal(hasPendingAutomation(db, scope, ids), false)
    db.prepare('insert into metadata_changes values(?,?,?,?,?,?,?,?,?,?,?)').run(
      'm',
      scope,
      'canonical',
      'Inbox/test.pdf',
      'sha',
      'v1',
      0,
      '{}',
      '[]',
      'intent',
      '2026'
    )
    assert.equal(hasPendingMetadata(db, scope, 'canonical'), true)
    assert.equal(hasPendingMetadata(db, 'foreign', 'canonical'), false)
  } finally {
    db.close()
  }
})
