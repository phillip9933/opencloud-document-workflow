// SPDX-License-Identifier: AGPL-3.0-only
import { jobAssociations } from './job-associations.mjs'
import { pageOptions, pageCursor } from './pagination.mjs'
/** @param {import('node:sqlite').DatabaseSync} db @param {string} scope
 * @param {import('./contracts.d.mts').Actor} actor
 * @param {import('./workflow-contracts.d.mts').JobOptions} options */
export function workflowJobPage(
  db,
  scope,
  actor,
  { id = null, activeOnly = false, summary = false, ...options }
) {
  const { limit, after } = pageOptions({ limit: 200, ...options })
  const candidates = /** @type {Iterable<import('./workflow-contracts.d.mts').JobListRow>} */ (
    db
      .prepare(
        `select p.id, p.state, p.attempts,
                 ${summary ? 'null' : "case when json_type(p.result,'$.pages')='array' then p.result end"} result,
                 json_extract(p.input,'$.source') sourceInput, p.error, p.updated,
                 d.state decision, ${summary ? 'null' : 'd.record'} approval
            from proposals p left join decisions d on d.job=p.id
            where p.scope=? and (? is null or p.id=?)
              and (?=0 or (d.state is null or d.state<>'done')
                and not exists(select 1 from automatic_runs a where a.job=p.id and a.state='done'))
              and (? is null or p.updated<? or (p.updated=? and p.id<?))
            order by p.updated desc,p.id desc limit ?`
      )
      .iterate(
        scope,
        id,
        id,
        activeOnly ? 1 : 0,
        after?.time ?? null,
        after?.time ?? null,
        after?.time ?? null,
        after?.id ?? null,
        limit + 1
      )
  )
  const { rows, hasMore } = boundedPage(candidates, limit)
  const page = rows.map((j) => ({
    ...j,
    source: /** @type {import('../src/domain/review.ts').Source} */ (JSON.parse(j.sourceInput))
  }))
  const associations = jobAssociations(db, scope, actor.space, page)
  const jobs = page.map((j) => {
      const source = j.source
      return {
        ...j,
        source,
        sourceInput: undefined,
        conversion: associations.conversions.get(source.resourceId) ?? null,
        approval: /** @type {import('./workflow-contracts.d.mts').RecordedApproval|null} */ (
          j.approval ? JSON.parse(j.approval) : null
        ),
        workflowSpace: actor.space,
        automation: associations.automatic.get(j.id) ?? null,
        bundle: /** @type {import('../src/domain/review.ts').Bundle|null} */ (
          j.result ? JSON.parse(j.result) : null
        ),
        result: undefined
      }
    }),
    last = jobs.at(-1)
  return {
    jobs,
    nextCursor: hasMore && last ? pageCursor(last.updated, last.id) : null,
    hasMore
  }
}

// At least one record can be returned, even for a very large active review.
// Full review evidence is never truncated in order to fit a page.
/** @param {Iterable<import('./workflow-contracts.d.mts').JobListRow>} candidates @param {number} limit */
function boundedPage(candidates, limit) {
  const rows = []
  let bytes = 0
  for (const row of candidates) {
    bytes += Buffer.byteLength(row.result ?? '') + Buffer.byteLength(row.approval ?? '')
    if (rows.length >= limit || (rows.length && bytes > 16 * 1024 * 1024))
      return { rows, hasMore: true }
    rows.push(row)
  }
  return { rows, hasMore: false }
}
