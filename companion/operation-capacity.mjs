// SPDX-License-Identifier: AGPL-3.0-only
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { WorkflowError } from '../src/domain/errors.ts'

const MiB = 1024 * 1024
export const maxResultBytes = 16 * 1024

/** Called inside the same immediate transaction that inserts every admitted row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./contracts.d.mts').Actor} actor
 * @param {string} scope @param {string[]} inputs */
export function checkOperationCapacity(db, actor, scope, inputs) {
  const inputBytes = inputs.reduce((n, input) => n + Buffer.byteLength(input), 0)
  if (inputBytes > 4 * MiB || inputs.some((input) => Buffer.byteLength(input) > 64 * 1024))
    throw new WorkflowError(
      'VALIDATION_INVALID',
      'Batch details are too large; choose fewer documents'
    )
  const totals = db
    .prepare(
      `select count(*) total,
    count(case when o.scope=? then 1 end) scoped,
    count(case when json_extract(o.scope,'$[0]')=? and json_extract(o.scope,'$[1]')=? then 1 end) owned
    from bulk_items i join bulk_operations o on o.id=i.operation`
    )
    .get(scope, actor.server, actor.account)
  const active = db
    .prepare(
      `select count(*) total, count(case when scope=? then 1 end) scoped
    from bulk_operations where state in ('queued','running','paused')`
    )
    .get(scope)
  if (
    Number(totals?.total) + inputs.length > 100000 ||
    Number(totals?.owned) + inputs.length > 50000 ||
    Number(totals?.scoped) + inputs.length > 25000 ||
    Number(active?.total) >= 64 ||
    Number(active?.scoped) >= 8
  )
    throw new WorkflowError('OPERATION_HELD', 'Batch journal capacity reached')
  const file = db.prepare("select file from pragma_database_list where name='main'").get()?.file
  if (typeof file === 'string' && file) {
    const fs = statfsSync(dirname(file))
    const pending = db
      .prepare("select count(*) n from bulk_items where state in ('queued','running')")
      .get()
    const reserved = (Number(pending?.n) + inputs.length) * (maxResultBytes + 2048)
    if (fs.bavail * fs.bsize < 64 * MiB + reserved + inputBytes)
      throw new WorkflowError('OPERATION_HELD', 'Batch journal needs more free storage')
  }
}
