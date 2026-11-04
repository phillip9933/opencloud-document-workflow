// SPDX-License-Identifier: AGPL-3.0-only
/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} version
 */
export function healthResponse(req, res, version) {
  if (req.url !== '/_workflow/api/healthz' || req.method !== 'GET') return false
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(JSON.stringify({ service: 'document-workflow', version, apiVersion: 1, ready: true }))
  return true
}
