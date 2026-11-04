// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
export const MAX_REQUEST_BYTES = 32_000_000
/** Read only after authentication. Never include input bytes in parse errors.
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit]
 * @returns {Promise<Record<string,unknown>>}
 */
export async function readRequestBody(request, limit = MAX_REQUEST_BYTES) {
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
      throw new WorkflowError('REQUEST_INVALID', 'Invalid request length')
    if (Number(declared) > limit)
      throw new WorkflowError('REQUEST_TOO_LARGE', 'Request exceeds limit')
  }
  /** @type {Buffer[]} */
  const parts = []
  let size = 0
  // Preserve the response socket on a streamed limit failure so the API can
  // return 413 with Connection: close instead of silently resetting it.
  const stream = request.iterator ? request.iterator({ destroyOnReturn: false }) : request
  for await (const part of stream) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += bytes.length
    if (size > limit) throw new WorkflowError('REQUEST_TOO_LARGE', 'Request exceeds limit')
    parts.push(bytes)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    throw new WorkflowError('REQUEST_INVALID', 'Invalid JSON request body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new WorkflowError('REQUEST_INVALID', 'Expected a JSON object')
  return body
}
