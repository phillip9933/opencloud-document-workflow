// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises'
const release = JSON.parse(await readFile('/distribution/release.json', 'utf8'))
async function ready(origin) {
  const response = await fetch(origin + '/_workflow/api/healthz', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  })
  const value = await response.json()
  if (
    !response.ok ||
    value.service !== 'document-workflow' ||
    value.apiVersion !== 1 ||
    value.ready !== true ||
    typeof value.instance !== 'string'
  )
    throw Error('Document Workflow companion is not reachable')
  return value
}
const local = await ready('http://127.0.0.1:5175')
if (local.version !== release.version)
  throw Error('Matching Document Workflow companion is not reachable')
const worker = await fetch('http://converter:5180/health', {
  redirect: 'error',
  signal: AbortSignal.timeout(5000)
})
if (!worker.ok || (await worker.text()) !== 'ok')
  throw Error('The isolated document worker is not reachable')
if (process.argv[2]) {
  const origin = new URL(process.argv[2]).origin
  const routed = await ready(origin)
  if (routed.instance !== local.instance)
    throw Error('The proxy does not reach the companion that was just verified')
  const protectedResponse = await fetch(origin + '/_workflow/api/status', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  })
  if (protectedResponse.status !== 401)
    throw Error('The companion API must require OpenCloud sign-in')
}
console.log('Matching companion ' + release.version + ' is ready')
