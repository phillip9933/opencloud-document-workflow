// SPDX-License-Identifier: AGPL-3.0-only
/** @param {{state:string,result?:string|null,operationState:string,updated:string}|undefined} row
 * @param {{updated:string}|undefined} latest
 */
export function selectBulkPreparation(row, latest) {
  if (!row) return null
  let result
  try {
    result = JSON.parse(row.result ?? '{}')
  } catch {
    return null
  }
  if (
    ['queued', 'running'].includes(row.state) &&
    ['queued', 'running', 'paused'].includes(row.operationState)
  )
    return { ...row, result }
  if (row.state !== 'held' || typeof result.error !== 'string') return null
  if (latest && latest.updated > (result.finishedAt ?? row.updated)) return null
  return { ...row, result }
}
