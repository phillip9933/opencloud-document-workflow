// SPDX-License-Identifier: AGPL-3.0-only
import { withTransaction } from './transactions.mjs'
import { WorkflowError } from '../src/domain/errors.ts'

/** @param {string | undefined} configured */
export function retentionDays(configured) {
  const days = configured === undefined ? 90 : Number(configured)
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new WorkflowError('VALIDATION_INVALID', 'Text retention must be between 1 and 3650 days')
  return days
}

/** Retain document identity, evidence excerpts, fields and filing decisions.
 * Active and uncertain decisions still need their complete original evidence.
 * @param {import('node:sqlite').DatabaseSync} db @param {number} days @param {number} [now]
 */
export function retireExtractedText(db, days, now = Date.now()) {
  const cutoff = new Date(now - days * 86400000).toISOString()
  return withTransaction(db, () => {
    const rows = db
      .prepare(
        `
      select p.id,p.scope from proposals p
      left join decisions d on d.job=p.id
      left join automatic_runs a on a.job=p.id
      where (json_array_length(p.input,'$.pages') > 0 or p.raw is not null)
        and p.state not in ('pending','running')
        and (a.state is null or a.state not in ('pending','running'))
        and (
          (d.state='done' and d.updated <= ?)
          or (d.state is null and a.state='done' and a.updated <= ?)
          or (
            (d.state is null or d.state in ('done','rejected'))
            and exists (
              select 1 from document_trash t
              where t.scope=p.scope and t.state='trashed'
                and t.resource=json_extract(p.input,'$.source.resourceId')
                and t.sha=json_extract(p.input,'$.source.sha256')
                and json_extract(t.source,'$.space')=json_extract(p.input,'$.source.space')
                and t.created >= p.updated
            )
          )
        )
      order by p.updated,p.id limit 25
    `
      )
      .all(cutoff, cutoff)
    const proposal = db.prepare(`
      update proposals set raw=null,
        input=json_set(input,'$.pages',json('[]')),
        result=json_remove(result,'$.pages')
      where id=? and scope=?
    `)
    const batch = db.prepare(`
      update bulk_items set result=json_remove(result,'$.bundle.pages')
      where json_extract(result,'$.id')=?
        and operation in (select id from bulk_operations where scope=? and kind='prepare')
    `)
    for (const row of rows) {
      proposal.run(row.id, row.scope)
      batch.run(row.id, row.scope)
    }
    return rows.length
  })
}
