// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
/** @param {{limit?:number,cursor?:unknown}} [options] @param {'time'|'number'} [kind] */
export function pageOptions({ limit = 100, cursor } = {}, kind = 'time') {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new WorkflowError('VALIDATION_INVALID', 'Choose a page size between 1 and 200')
  let after = null
  if (cursor !== undefined && cursor !== null) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid value')
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString())
      if (
        !after ||
        Object.keys(after).sort().join(',') !== 'id,time' ||
        typeof after.id !== 'string' ||
        after.id.length > 400 ||
        (kind === 'time' &&
          (typeof after.time !== 'string' || new Date(after.time).toISOString() !== after.time)) ||
        (kind === 'number' && (!Number.isSafeInteger(after.time) || after.time < 0))
      )
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid value')
    } catch {
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid page cursor; refresh this list')
    }
  }
  return { limit, after }
}
/** @param {string|number} time @param {string} id */
export const pageCursor = (time, id) =>
  Buffer.from(JSON.stringify({ time, id })).toString('base64url')
