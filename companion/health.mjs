// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
const instance = randomUUID()
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} version
 */
export function healthResponse(req, res, version) {
  if (req.url !== '/_workflow/api/healthz' || req.method !== 'GET') return false
  const local =
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') &&
    /^127\.0\.0\.1:\d+$/.test(req.headers?.host ?? '')
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(
    JSON.stringify({
      service: 'document-workflow',
      instance,
      apiVersion: 1,
      ready: true,
      ...(local ? { version } : {})
    })
  )
  return true
}
