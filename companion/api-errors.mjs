// SPDX-License-Identifier: AGPL-3.0-only
import { errorCode } from '../src/domain/errors.ts'
const internal = {
  status: 500,
  body: {
    error: 'An internal error occurred. Check Activity before retrying.',
    code: 'INTERNAL_ERROR'
  }
}
const accessCodes = new Map([
  [401, 'AUTH_REQUIRED'],
  [403, 'ACCESS_DENIED'],
  [404, 'RESOURCE_NOT_FOUND']
])
const statuses = new Map([
  ['AUTH_REQUIRED', 401],
  ['ACCESS_DENIED', 403],
  ['RESOURCE_NOT_FOUND', 404],
  ['REQUEST_INVALID', 400],
  ['REQUEST_TOO_LARGE', 413],
  ['UPSTREAM_FAILURE', 502],
  ['PROVIDER_RESPONSE_INVALID', 502]
])
/** @param {unknown} error */
export function apiError(error) {
  const detail =
    error && typeof error === 'object' ? /** @type {Record<string,unknown>} */ (error) : {}
  // External adapters can signal access status without a domain error. These
  // three responses never echo their message; every other unknown error is 500.
  const code = errorCode(error) ?? accessCodes.get(Number(detail.status))
  if (
    !code ||
    code === 'INTERNAL_ERROR' ||
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  )
    return { ...internal, body: { ...internal.body } }
  const status = statuses.get(code) ?? 409
  return {
    status,
    body: {
      error: displayMessage(status, detail.message),
      code,
      ...(detail.trashRecorded === false ? { trashRecorded: false } : {})
    }
  }
}
/** @param {number} status @param {unknown} message */
function displayMessage(status, message) {
  const fixed = new Map([
    [401, 'OpenCloud sign-in required'],
    [403, 'OpenCloud access denied'],
    [404, 'Resource not found'],
    [413, 'Request exceeds limit']
  ])
  const standard = fixed.get(status)
  if (standard) return standard
  const safe = typeof message === 'string' && message.length < 180 && !/[\r\n]/.test(message)
  if (status === 400) return safe ? message : 'Invalid request'
  if (safe && /^OpenCloud HTTP \d{3}$/.test(message)) return message
  return (
    'Operation held. ' +
    (safe && message
      ? message
      : 'Inspect the local activity and retry only after checking its state.')
  )
}
