// SPDX-License-Identifier: AGPL-3.0-only
/** @typedef {{origin:string,base:string,trashBase:string,account?:string,auth:string,fetcher:typeof fetch}} RemoteContext */
export class RemoteError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`OpenCloud HTTP ${status}`)
    this.status = status
  }
}
/** Shared guard for buffered, streamed and conditional requests.
 * @param {RemoteContext} context @param {string} method @param {string} url
 */
export function assertRemoteURL(context, method, url) {
  const parsed = new URL(url),
    base = new URL(context.base)
  if (parsed.origin !== context.origin || parsed.username || parsed.password || parsed.hash)
    throw new Error('URL outside configured endpoints')
  const directory = ['/graph/v1.0/me/drives', '/graph/v1.0/me/drives/'].includes(parsed.pathname)
  const ownRoles =
    method === 'GET' &&
    context.account &&
    url ===
      `${context.origin}/graph/v1.0/users/${encodeURIComponent(context.account)}/appRoleAssignments`
  const trashRead = method === 'PROPFIND' && url === context.trashBase
  if (
    !ownRoles &&
    !trashRead &&
    !directory &&
    url !== `${context.origin}/graph/v1.0/me` &&
    url !== `${context.origin}/graph/v1.0/extensions/org.libregraph/tags` &&
    !parsed.pathname.startsWith(base.pathname)
  )
    throw new Error('URL outside configured endpoints')
}
/** @param {RemoteContext} context @param {string} method @param {string} url
 * @param {{body?:NonNullable<Parameters<typeof fetch>[1]>['body'],headers?:Record<string,string>,timeout?:number,duplex?:'half',statuses?:number[]}} [options]
 */
export async function remoteResponse(
  context,
  method,
  url,
  { body, headers = {}, timeout = 60000, duplex, statuses } = {}
) {
  assertRemoteURL(context, method, url)
  const response = await context.fetcher(url, {
    method,
    body,
    ...(duplex ? { duplex } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: { ...headers, Authorization: context.auth }
  })
  if (statuses ? !statuses.includes(response.status) : !response.ok) {
    await response.body?.cancel()
    throw new RemoteError(response.status)
  }
  return response
}
/** @param {Response} response @param {number} [max] */
export async function responseBytes(response, max = 25 * 1024 * 1024) {
  const parts = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > max) throw new Error('Remote response exceeds limit')
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}
