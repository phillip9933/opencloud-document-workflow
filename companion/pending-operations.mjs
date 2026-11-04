// SPDX-License-Identifier: AGPL-3.0-only
/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** Canonical identities and historical aliases share the same write interlocks.
 * @param {Database} db @param {string} scope @param {string} resource @param {string} canonical
 * @param {boolean} [includeAliases]
 */
export function resourceIdentities(db, scope, resource, canonical, includeAliases = true) {
  const aliases = includeAliases
    ? db
        .prepare('select resource from resource_aliases where scope=? and canonical=?')
        .all(scope, canonical)
        .map((row) => String(row.resource))
    : []
  return JSON.stringify([...new Set([resource, canonical, ...aliases])])
}
/** @param {Database} db @param {string} scope @param {string} identities */
export function hasPendingFiling(db, scope, identities) {
  return !!db
    .prepare(
      "select 1 from proposals p left join decisions d on d.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId') in (select value from json_each(?)) and (p.state='running' or (d.state is not null and d.state not in ('done','rejected','conflict'))) limit 1"
    )
    .get(scope, identities)
}
/** @param {Database} db @param {string} scope @param {string} identities */
export function hasPendingAutomation(db, scope, identities) {
  return !!db
    .prepare(
      "select 1 from proposals p join automatic_runs a on a.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId') in (select value from json_each(?)) and a.state in ('pending','running') limit 1"
    )
    .get(scope, identities)
}
/** @param {Database} db @param {string} scope @param {string} resource */
export function hasPendingMetadata(db, scope, resource) {
  return !!db
    .prepare(
      "select 1 from metadata_changes where scope=? and resource=? and state='intent' limit 1"
    )
    .get(scope, resource)
}
