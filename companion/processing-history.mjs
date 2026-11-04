// SPDX-License-Identifier: AGPL-3.0-only
/** @param {Pick<import('./contracts.d.mts').ConfigurationOwner,'db'|'scope'>} workflow @param {import('./contracts.d.mts').Actor} actor @param {string} id */
export function processingHistory(workflow, actor, id) {
  const db = workflow.db,
    scope = workflow.scope(actor),
    row = db
      .prepare(
        'select id,path,resource,etag,attempts,state,detail,stage,first_seen from intake_queue where id=? and scope=?'
      )
      .get(id, scope)
  if (!row) throw Object.assign(new Error('Processing record not found'), { status: 404 })
  const jobs = db
      .prepare(
        "select id,state,attempts,updated,result,error from proposals where scope=? and json_extract(input,'$.source.resourceId')=? order by updated desc,id desc"
      )
      .all(scope, row.resource),
    ids = JSON.stringify(jobs.map((job) => job.id))
  const batches = db
    .prepare(
      "select o.id,o.kind,o.created,o.updated,i.position,i.state,i.result from bulk_operations o join bulk_items i on i.operation=o.id where o.scope=? and (json_extract(i.input,'$.resourceId')=? or json_extract(i.result,'$.bundle.source.resourceId')=? or json_extract(i.input,'$.id') in (select value from json_each(?))) order by o.created desc,i.position"
    )
    .all(scope, row.resource, row.resource, ids)
  const events = db
    .prepare(
      'select seq,job,kind,detail,created from activity where scope=? and job in (select value from json_each(?)) order by seq desc'
    )
    .all(scope, ids)
  return {
    document: row,
    attempts: [
      ...jobs.map((job) => ({
        id: job.id,
        kind: 'prepare',
        state: job.state,
        created: String(job.updated),
        attempts: job.attempts,
        result: job.result ? JSON.parse(String(job.result)) : { error: job.error }
      })),
      ...batches.map((item) => ({
        ...item,
        created: String(item.created),
        result: item.result ? JSON.parse(String(item.result)) : null
      }))
    ].sort((a, b) => b.created.localeCompare(a.created)),
    events: events.map((event) => ({ ...event, detail: JSON.parse(String(event.detail)) }))
  }
}
