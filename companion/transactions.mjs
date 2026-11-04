// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A synchronous unit of journal work. Network/filesystem I/O belongs outside
 * this boundary. BEGIN stays outside the catch so a rejected nested transaction
 * cannot roll back its caller's transaction.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T & (T extends PromiseLike<unknown> ? never : unknown)} work
 * @returns {T}
 */
export function withTransaction(db, work) {
  if (Object.prototype.toString.call(work) === '[object AsyncFunction]')
    throw new TypeError('Journal transactions must be synchronous')
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    if (result && typeof (/** @type {{then?:unknown}} */ (result).then) === 'function')
      throw new TypeError('Journal transactions must be synchronous')
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
