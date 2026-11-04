// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError, errorCode } from '../src/domain/errors.ts'
/** Untrusted provider JSON stays unknown until each consumer checks its fields.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function responseRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {Response} response @param {number} limit @returns {Promise<Record<string, unknown>>} */
export async function boundedJSON(response, limit = 256_000) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProviderHTTPError(response.status)
  }
  if (!response.body)
    throw new WorkflowError('PROVIDER_RESPONSE_INVALID', 'Ollama returned invalid response JSON')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > limit)
      throw new WorkflowError('UPSTREAM_FAILURE', 'Ollama response exceeds size limit')
    chunks.push(chunk)
  }
  try {
    /** @type {unknown} */
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid value')
    return responseRecord(value)
  } catch {
    throw new WorkflowError('PROVIDER_RESPONSE_INVALID', 'Ollama returned invalid response JSON')
  }
}

/** @param {Record<string, unknown>} data */
export function cloudCompletion(data) {
  const choice = responseRecord(Array.isArray(data.choices) ? data.choices[0] : undefined),
    message = responseRecord(choice.message)
  if (
    choice.finish_reason !== 'stop' ||
    message.refusal ||
    message.tool_calls ||
    typeof message.content !== 'string'
  )
    throw new WorkflowError('UPSTREAM_FAILURE', 'Cloud result is incomplete or refused')
  return message.content
}

/** Provider protocol failures carry structured status independently of display text. */
export class ProviderHTTPError extends WorkflowError {
  /** @param {number} status */
  constructor(status) {
    super('UPSTREAM_FAILURE', `Ollama HTTP ${status}`)
    this.status = status
  }
}
/** Only known unsupported probe responses count as an unsupported capability.
 * Transport errors, oversized bodies and authentication failures remain failures.
 * @param {unknown} error @param {number[]} statuses
 */
export function unsupportedProbe(error, statuses) {
  return (
    errorCode(error) === 'PROVIDER_RESPONSE_INVALID' ||
    (error instanceof ProviderHTTPError && statuses.includes(error.status))
  )
}
