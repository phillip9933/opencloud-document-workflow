// SPDX-License-Identifier: AGPL-3.0-only
import { responseBytes } from './remote-transport.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
/** @param {string|undefined} endpoint @param {Buffer} bytes @param {string} extension */
export async function renderRemotePDF(endpoint, bytes, extension) {
  if (!endpoint)
    throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'The conversion service is not configured')
  const url = new URL(endpoint)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'converter' ||
    url.port !== '5180' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new WorkflowError('OPERATION_HELD', 'Invalid private conversion service')
  const response = await fetch(endpoint + '/convert/' + extension, {
    method: 'POST',
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(300000)
  })
  if (!response.ok) {
    const message = (await responseBytes(response, 1024)).toString('utf8')
    const allowed = [
      'The file could not be exported to PDF; the original has been kept',
      'The converted PDF exceeds the 1000-page limit; the original has been kept',
      'Conversion took too long; the original has been kept',
      'The conversion tool could not read this file; the original has been kept'
    ]
    throw new WorkflowError(
      'OPERATION_HELD',
      allowed.includes(message) ? message : 'Conversion failed; the original has been kept'
    )
  }
  const parts = []
  let size = 0
  if (!response.body) throw new WorkflowError('OPERATION_HELD', 'Conversion returned no PDF')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 100 * 1024 * 1024)
      throw new WorkflowError('OPERATION_HELD', 'Converted PDF exceeds limit')
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}
