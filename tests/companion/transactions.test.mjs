// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../../companion/transactions.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT)')
  return db
}
test('transactions return results after commit and roll back all writes on callback failure', () => {
  const db = fixture()
  try {
    assert.equal(
      withTransaction(db, () => {
        db.exec("INSERT INTO records VALUES(1,'kept')")
        return 'result'
      }),
      'result'
    )
    const failure = new Error('synthetic failure')
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.exec("UPDATE records SET value='changed'; INSERT INTO records VALUES(2,'partial')")
          throw failure
        }),
      (error) => error === failure
    )
    assert.deepEqual(
      db
        .prepare('SELECT * FROM records')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, value: 'kept' }]
    )
    assert.equal(db.isTransaction, false)
  } finally {
    db.close()
  }
})
test('a failed commit rolls back; a rejected nested BEGIN leaves the outer transaction intact', () => {
  const db = fixture()
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE child(parent INTEGER REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED)'
    )
    assert.throws(
      () => withTransaction(db, () => db.exec('INSERT INTO child VALUES(99)')),
      /FOREIGN KEY/
    )
    assert.equal(db.prepare('SELECT count(*) n FROM child').get().n, 0)
    assert.equal(db.isTransaction, false)
    db.exec("BEGIN IMMEDIATE; INSERT INTO records VALUES(3,'outer')")
    assert.throws(
      () => withTransaction(db, () => assert.fail('nested callback ran')),
      /transaction/
    )
    assert.equal(db.isTransaction, true)
    db.exec('COMMIT')
    assert.equal(db.prepare('SELECT value FROM records').get().value, 'outer')
  } finally {
    db.close()
  }
})
test('async callbacks are refused before execution and synchronous thenables roll back', () => {
  const db = fixture()
  try {
    let called = false
    assert.throws(
      () =>
        withTransaction(db, async () => {
          called = true
        }),
      /synchronous/
    )
    assert.equal(called, false)
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.exec("INSERT INTO records VALUES(4,'partial')")
          return { then() {} }
        }),
      /synchronous/
    )
    assert.equal(db.isTransaction, false)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0)
  } finally {
    db.close()
  }
})

test('SQLite automatic rollback preserves the original constraint error', () => {
  const db = fixture()
  try {
    db.exec("INSERT INTO records VALUES(1,'original')")
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.exec("INSERT INTO records VALUES(2,'partial')")
          db.exec("INSERT OR ROLLBACK INTO records VALUES(1,'duplicate')")
        }),
      /UNIQUE constraint failed/
    )
    assert.equal(db.isTransaction, false)
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1)
  } finally {
    db.close()
  }
})
