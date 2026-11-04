// SPDX-License-Identifier: AGPL-3.0-only
import { errorCode } from '../src/domain/errors.ts'
/** @param {unknown} error */
export function apiError(error) {
  const detail =
    error && typeof error === 'object' ? /** @type {Record<string,unknown>} */ (error) : {}
  const code = errorCode(error)
  const status =
    code === 'REQUEST_INVALID'
      ? 400
      : code === 'REQUEST_TOO_LARGE'
        ? 413
        : typeof detail.status === 'number' && [401, 403, 404].includes(detail.status)
          ? detail.status
          : 409
  const message = typeof detail.message === 'string' ? detail.message : ''
  const text =
    status === 401
      ? 'OpenCloud sign-in required'
      : status === 403
        ? 'OpenCloud access denied'
        : status === 404
          ? 'Resource not found'
          : status === 400
            ? code === 'REQUEST_INVALID'
              ? message
              : 'Invalid request'
            : status === 413
              ? 'Request exceeds limit'
              : /^OpenCloud HTTP \d{3}$/.test(message)
                ? message
                : 'Operation held. ' +
                  (message && message.length < 180 && !/[\r\n]/.test(message)
                    ? message
                    : 'Inspect the local activity and retry only after checking its state.')
  return {
    status,
    body: {
      error: text,
      ...(code ? { code } : {}),
      ...(detail.trashRecorded === false ? { trashRecorded: false } : {})
    }
  }
}
