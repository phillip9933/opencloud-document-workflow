// SPDX-License-Identifier: AGPL-3.0-only
import { processingProgress } from '../src/domain/processing.ts'
import { selectBulkPreparation } from './bulk-preparation.mjs'
/** @param {string} resource @param {string} etag */
const recordKey = (resource, etag) => JSON.stringify([resource, etag])
/** @param {import('./contracts.d.mts').ConfigurationOwner} workflow @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileEntry[]} listing */
function listingRecords(workflow, actor, listing) {
  const db = workflow.db,
    scope = workflow.scope(actor),
    ids = JSON.stringify([...new Set(listing.map((f) => f.resourceId))])
  const records = {
    queued: new Map(
      /** @type {[string,{id:string,resource:string,etag:string,state:string,job:string|null,stage:string|null}][]} */ ([])
    ),
    latest: new Map(
      /** @type {[string,{id:string,state:string,input:string,updated:string,decision:string|null}][]} */ ([])
    ),
    automatic: new Map(
      /** @type {[string,{job:string,state:string,detail:string|null,created:string,updated:string}][]} */ ([])
    ),
    bulk: new Map(/** @type {[string,ReturnType<typeof selectBulkPreparation>][]} */ ([])),
    fields: new Map(/** @type {[string,Record<string,string|number>][]} */ ([])),
    duplicates: new Set(/** @type {string[]} */ ([]))
  }
  if (!listing.length) return records
  for (const row of /** @type {{id:string,resource:string,etag:string,state:string,job:string|null,stage:string|null}[]} */ (
    db
      .prepare(
        'select id,resource,etag,state,job,stage from intake_queue where scope=? and resource in (select value from json_each(?)) order by first_seen desc'
      )
      .all(scope, ids)
  )) {
    const key = recordKey(row.resource, row.etag)
    if (!records.queued.has(key)) records.queued.set(key, row)
  }
  const latestVersions = new Map(/** @type {[string,{updated:string}][]} */ ([]))
  for (const row of /** @type {{id:string,state:string,input:string,updated:string,decision:string|null}[]} */ (
    db
      .prepare(
        "select p.id,p.state,p.input,p.updated,d.state decision from proposals p left join decisions d on d.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId') in (select value from json_each(?)) order by p.updated desc,p.id desc"
      )
      .all(scope, ids)
  )) {
    const { source } = JSON.parse(row.input),
      key = recordKey(source.resourceId, source.etag)
    if (!records.latest.has(source.resourceId)) records.latest.set(source.resourceId, row)
    if (!latestVersions.has(key)) latestVersions.set(key, row)
  }
  for (const row of /** @type {{job:string,state:string,detail:string|null,created:string,updated:string}[]} */ (
    db
      .prepare(
        "select a.job,a.state,a.detail,a.created,a.updated from automatic_runs a join proposals p on p.id=a.job where a.scope=? and p.scope=? and json_extract(p.input,'$.source.resourceId') in (select value from json_each(?))"
      )
      .all(scope, scope, ids)
  ))
    records.automatic.set(row.job, row)
  const seenBulk = new Set()
  for (const row of /** @type {{input:string,state:string,result:string|null,operationState:string,updated:string}[]} */ (
    db
      .prepare(
        "select i.input,i.state,i.result,o.state operationState,o.updated from bulk_items i join bulk_operations o on o.id=i.operation where o.scope=? and o.kind='prepare' and json_extract(i.input,'$.resourceId') in (select value from json_each(?)) order by o.created desc,o.id desc"
      )
      .all(scope, ids)
  )) {
    const input = JSON.parse(row.input),
      key = recordKey(input.resourceId, input.etag)
    if (seenBulk.has(key)) continue
    seenBulk.add(key)
    records.bulk.set(key, selectBulkPreparation(row, latestVersions.get(key)))
  }
  for (const row of /** @type {{resource:string,fields:string|null}[]} */ (
    db
      .prepare(
        'select value resource, m.fields from json_each(?) f left join resource_aliases a on a.scope=? and a.resource=f.value left join file_locations l on l.scope=? and l.space=? and l.target_resource=f.value left join metadata m on m.scope=? and m.resource=coalesce(a.canonical,l.resource,f.value)'
      )
      .all(ids, scope, scope, actor.space, scope)
  ))
    records.fields.set(row.resource, row.fields ? JSON.parse(row.fields) : {})
  for (const row of /** @type {{queue_id:string}[]} */ (
    db
      .prepare(
        'select d.queue_id from duplicate_trash d join intake_queue q on q.id=d.queue_id and q.scope=d.scope where q.scope=? and q.resource in (select value from json_each(?))'
      )
      .all(scope, ids)
  ))
    records.duplicates.add(row.queue_id)
  return records
}
/** @param {{workflow:import('./contracts.d.mts').ConfigurationOwner}} context @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileEntry[]} listing */
export function describeFiles({ workflow }, actor, listing) {
  const records = listingRecords(workflow, actor, listing)
  return listing.map((f) => {
    const queued = records.queued.get(recordKey(f.resourceId, f.etag)),
      latest = records.latest.get(f.resourceId)
    const current =
        latest && (JSON.parse(latest.input).source.etag === f.etag || queued?.job === latest.id),
      automatic = current ? records.automatic.get(latest.id) : null,
      processed = current && (latest.decision === 'done' || automatic?.state === 'done')
    const bulk = records.bulk.get(recordKey(f.resourceId, f.etag))
    const { state, stage } = listingStage(processed, bulk, current ? latest : undefined, queued)
    const progress =
      !/\.pdf$/i.test(f.path) && !current
        ? { step: 1, total: 5, label: 'Choose filing details', attention: false }
        : processingProgress({
            state,
            stage,
            reviewState: current ? (latest.decision ?? latest.state) : null,
            automatic
          })
    return {
      ...f,
      reviewJob: current ? latest.id : null,
      reviewState: current ? (latest.decision ?? latest.state) : null,
      fields: records.fields.get(f.resourceId) ?? {},
      stage,
      progress,
      intakeState: state ?? null,
      ...(queued?.state === 'duplicate'
        ? {
            duplicate: {
              id: queued.id,
              job: queued.job,
              uncertain: records.duplicates.has(queued.id)
            }
          }
        : {})
    }
  })
}

/** @param {boolean|undefined} processed
 * @param {ReturnType<typeof selectBulkPreparation>|undefined} bulk
 * @param {{decision:string|null,state:string}|undefined} latest
 * @param {{state:string,stage:string|null}|undefined} queued
 */
function listingStage(processed, bulk, latest, queued) {
  const latestRunning =
      latest && !latest.decision && ['running', 'pending', 'failed'].includes(latest.state),
    state = processed
      ? 'processed'
      : bulk?.state === 'running'
        ? 'running'
        : bulk?.state === 'queued'
          ? 'queued'
          : bulk?.state === 'held'
            ? 'failed'
            : latestRunning
              ? latest.state === 'pending'
                ? 'queued'
                : latest.state
              : queued?.state
  let stage = queued?.stage ?? null
  if (bulk && ['running', 'held'].includes(bulk.state)) {
    stage = bulk.result.stage ?? 'reading'
  } else if (latestRunning)
    stage = ['running', 'failed'].includes(latest.state) ? 'analysing' : 'reading'
  return { state, stage }
}
