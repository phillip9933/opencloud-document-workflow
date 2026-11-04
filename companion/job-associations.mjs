// SPDX-License-Identifier: AGPL-3.0-only
/** @param {import('./orchestration-contracts.d.mts').ConversionRecord} record @param {string} space */
export function conversionAssociation(record, space) {
  return {
    conversionId: record.id,
    archivePath: record.original,
    originalResourceId: record.resourceId,
    originalSha256: record.sha256,
    space
  }
}
/** Read associations for a page together rather than issuing two queries per document.
 * @param {import('node:sqlite').DatabaseSync} db @param {string} scope @param {string} space
 * @param {Array<{id:string,source:{resourceId:string}}>} jobs
 */
export function jobAssociations(db, scope, space, jobs) {
  const automatic = new Map(
    /** @type {[string, import('./orchestration-contracts.d.mts').AutomaticRun][]} */ ([])
  )
  const conversions = new Map(
    /** @type {[string, ReturnType<typeof conversionAssociation>][]} */ ([])
  )
  if (!jobs.length) return { automatic, conversions }
  for (const row of /** @type {import('./orchestration-contracts.d.mts').AutomaticRun[]} */ (
    db
      .prepare(
        'select job,state,detail,created,updated from automatic_runs where scope=? and job in (select value from json_each(?))'
      )
      .all(scope, JSON.stringify(jobs.map((job) => job.id)))
  ))
    automatic.set(row.job, row)
  for (const row of db
    .prepare(
      "select record from conversions where scope=? and json_extract(record,'$.pdfResourceId') in (select value from json_each(?)) and json_extract(record,'$.state')='done' order by rowid"
    )
    .all(scope, JSON.stringify([...new Set(jobs.map((job) => job.source.resourceId))]))) {
    const record = /** @type {import('./orchestration-contracts.d.mts').ConversionRecord} */ (
      JSON.parse(String(row.record))
    )
    if (record.pdfResourceId && !conversions.has(record.pdfResourceId))
      conversions.set(record.pdfResourceId, conversionAssociation(record, space))
  }
  return { automatic, conversions }
}
