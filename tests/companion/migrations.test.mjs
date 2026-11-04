// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateJournal, JOURNAL_SCHEMA_VERSION } from '../../companion/migrations.mjs'
import { ProposalJournal } from '../../companion/journal.mjs'

const releasedSchema = readFileSync(
  new URL('../fixtures/journal-0.20.0.sql', import.meta.url),
  'utf8'
)
function snapshot(db) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name)
  return Object.fromEntries(
    names.map((name) => [
      name,
      db
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row }))
    ])
  )
}
function seedLegacy(db) {
  db.exec(releasedSchema)
  db.prepare(
    'INSERT INTO proposals(id,scope,input,configuration,state,result,raw,updated) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    'proposal',
    'scope',
    '{"source":"fixture"}',
    '{"policy":"fixture"}',
    'ready',
    'exact result',
    'exact evidence',
    '2026-01-01'
  )
  db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?)').run(
    'proposal',
    'actor',
    'exact approval',
    'move_intent',
    'exact write intent',
    '2026-01-01'
  )
  db.prepare('INSERT INTO activity(scope,job,kind,detail,created) VALUES(?,?,?,?,?)').run(
    'scope',
    'proposal',
    'move_intent',
    '{"fixture":true}',
    '2026-01-01'
  )
  db.prepare('INSERT INTO metadata VALUES(?,?,?,?,?)').run(
    'scope',
    'resource',
    4,
    '{"tax_year":"2025"}',
    '2026-01-01'
  )
  db.prepare('INSERT INTO metadata_changes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'pending',
    'scope',
    'resource',
    'Filed/fixture.pdf',
    'hash',
    'etag',
    4,
    '{"tax_year":"2025"}',
    '["Fixture"]',
    'tags_intent',
    '2026-01-01'
  )
  db.prepare(
    'INSERT INTO intake_queue(id,scope,resource,path,etag,first_seen,state,attempts,job,stage,issue) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'queue',
    'scope',
    'resource',
    'Inbox/fixture.pdf',
    'etag',
    123,
    'failed',
    2,
    'proposal',
    'analysing',
    '{"reason":"fixture"}'
  )
  db.prepare('INSERT INTO preferences VALUES(?,?)').run('scope', '{"reviewFirst":true}')
}

test('released unversioned journal is adopted without changing data, evidence or pending writes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    seedLegacy(db)
    const before = snapshot(db)
    migrateJournal(db)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, JOURNAL_SCHEMA_VERSION)
    assert.deepEqual(snapshot(db), before)
    migrateJournal(db)
    assert.deepEqual(snapshot(db), before)
    assert.throws(() => db.exec("UPDATE activity SET kind='changed'"), /append-only/)
    assert.throws(() => db.exec('DELETE FROM activity'), /append-only/)
  } finally {
    db.close()
  }
})

test('fresh journal has every supported table before any service constructor runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-migration-'))
  const path = join(directory, 'journal.sqlite3')
  const journal = new ProposalJournal(path)
  try {
    assert.equal(journal.db.prepare('PRAGMA user_version').get().user_version, 1)
    const tables = snapshot(journal.db)
    assert.equal(Object.keys(tables).length, 33)
    assert.ok(Object.values(tables).every((rows) => rows.length === 0))
  } finally {
    journal.close()
    rmSync(directory, { recursive: true })
  }
})

test('historical missing columns are added without changing old values', () => {
  const db = new DatabaseSync(':memory:')
  try {
    seedLegacy(db)
    db.exec(
      'ALTER TABLE proposals DROP COLUMN raw; ALTER TABLE intake_queue DROP COLUMN last_seen; ALTER TABLE intake_queue DROP COLUMN stage; ALTER TABLE intake_queue DROP COLUMN issue'
    )
    const approval = db.prepare('SELECT * FROM decisions').get()
    migrateJournal(db)
    assert.deepEqual(db.prepare('SELECT * FROM decisions').get(), approval)
    assert.equal(db.prepare('SELECT raw FROM proposals').get().raw, null)
    assert.deepEqual(
      { ...db.prepare('SELECT attempts,last_seen,stage,issue FROM intake_queue').get() },
      { attempts: 2, last_seen: null, stage: null, issue: null }
    )
  } finally {
    db.close()
  }
})

test('failed adoption rolls back every schema change and keeps the old version and records', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE intake_queue(legacy TEXT); INSERT INTO intake_queue VALUES('retain')")
    const schema = db.prepare('SELECT * FROM sqlite_master').all()
    assert.throws(() => migrateJournal(db))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0)
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(), schema)
    assert.equal(db.prepare('SELECT legacy FROM intake_queue').get().legacy, 'retain')
  } finally {
    db.close()
  }
})

test('newer schemas and altered stamped schemas fail closed without automatic repair', () => {
  const db = new DatabaseSync(':memory:')
  try {
    seedLegacy(db)
    db.exec('PRAGMA user_version=999')
    const before = snapshot(db)
    assert.throws(() => migrateJournal(db), { code: 'SCHEMA_VERSION' })
    assert.deepEqual(snapshot(db), before)
    db.exec('PRAGMA user_version=1; DROP TRIGGER activity_no_delete')
    assert.throws(() => migrateJournal(db), { code: 'SCHEMA_MISMATCH' })
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='activity_no_delete'").get(),
      undefined
    )
    assert.deepEqual(snapshot(db), before)
  } finally {
    db.close()
  }
})

test('unrelated tables are preserved and cannot inject schema inspection SQL', () => {
  const db = new DatabaseSync(':memory:')
  try {
    seedLegacy(db)
    db.exec('CREATE TABLE "extra); DROP TABLE decisions;--" (value TEXT);')
    migrateJournal(db)
    assert.equal(db.prepare('SELECT count(*) n FROM decisions').get().n, 1)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  } finally {
    db.close()
  }
})
