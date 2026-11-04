// SPDX-License-Identifier: AGPL-3.0-only
import { validatePolicy, validateManualActions } from '../src/domain/review.ts'
import { WorkflowError } from '../src/domain/errors.ts'
/** @param {unknown} value @returns {string} */
export function requestID(value) {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new WorkflowError('VALIDATION_INVALID', 'Choose processing items')
  return value
}
/** @param {Record<string,unknown>} body */
export function requestPage(body) {
  if (body.limit !== undefined && typeof body.limit !== 'number')
    throw new WorkflowError('VALIDATION_INVALID', 'Choose a page size between 1 and 200')
  return { limit: body.limit, cursor: body.cursor }
}
/** @param {unknown} value @returns {import('./api-contracts.d.mts').QueueAction} */
export function requestAction(value) {
  if (value !== 'pause' && value !== 'resume' && value !== 'retry' && value !== 'cancel')
    throw new WorkflowError('VALIDATION_INVALID', 'Unknown processing action')
  return value
}
/** @param {unknown} value @param {import('./api-contracts.d.mts').QueueAction} action */
export function requestSelection(value, action) {
  if (value === undefined) return undefined
  if ((action !== 'retry' && action !== 'cancel') || !Array.isArray(value) || !value.length)
    throw new WorkflowError('VALIDATION_INVALID', 'Choose processing items')
  return value.map(requestID)
}
/** @param {unknown} value @returns {string} */
export function requestText(value) {
  if (typeof value !== 'string') throw new WorkflowError('VALIDATION_INVALID', 'Expected text')
  return value
}
/** @param {unknown} value */
export function optionalText(value) {
  return value === undefined ? undefined : requestText(value)
}
/** @param {unknown} value @returns {Record<string,unknown>} */
export function requestObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('VALIDATION_INVALID', 'Expected an object')
  return /** @type {Record<string,unknown>} */ (value)
}
/** @param {unknown} value @returns {string[]} */
export function requestStrings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new WorkflowError('VALIDATION_INVALID', 'Expected a text list')
  return value
}
/** @param {Record<string,unknown>} body */
export function sourceInput(body) {
  return {
    path: requestText(body.path),
    resourceId: requestText(body.resourceId),
    etag: requestText(body.etag)
  }
}
/** @param {Record<string,unknown>} body */
export function metadataInput(body) {
  if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 0)
    throw new WorkflowError('VALIDATION_INVALID', 'Inspect the current metadata version')
  return { ...sourceInput(body), sha256: requestText(body.sha256), version: body.version }
}
/** Decode an operation before queuing any items. Per-document evidence checks
 * still run at execution time; this only validates request shapes.
 * @param {Record<string,unknown>} body @returns {import('./operation-contracts.d.mts').OperationRequest}
 */
export function operationInput(body) {
  const id = requestText(body.id)
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 10000)
    throw new WorkflowError(
      'VALIDATION_INVALID',
      'Choose between 1 and 10000 documents for this operation'
    )
  const items = body.items.map(requestObject)
  switch (body.kind) {
    case 'prepare':
      return {
        id,
        kind: 'prepare',
        items: items.map((item) => ({
          ...item,
          path: requestText(item.path),
          resourceId: optionalText(item.resourceId),
          etag: optionalText(item.etag),
          documentSpace: optionalText(item.documentSpace),
          retry: optionalBoolean(item.retry),
          newReview: optionalBoolean(item.newReview),
          cloudConsent: optionalBoolean(item.cloudConsent)
        }))
      }
    case 'convert':
      return {
        id,
        kind: 'convert',
        items: items.map((item) => ({ ...item, ...sourceInput(item) }))
      }
    case 'metadata':
      return {
        id,
        kind: 'metadata',
        items: items.map((item) => ({ ...item, ...metadataInput(item) }))
      }
    case 'automatic':
      return {
        id,
        kind: 'automatic',
        items: items.map((item) => ({ ...item, id: requestText(item.id) }))
      }
    case 'file':
      return {
        id,
        kind: 'file',
        items: items.map((item) => ({
          ...item,
          id: requestText(item.id),
          reviewDigest: requestText(item.reviewDigest),
          policy: validatePolicy(item.policy),
          manualActions:
            item.manualActions === undefined ? undefined : validateManualActions(item.manualActions)
        }))
      }
    default:
      throw new WorkflowError('VALIDATION_INVALID', 'Choose a processing operation')
  }
}
/** @param {unknown} value */
function optionalBoolean(value) {
  if (value !== undefined && typeof value !== 'boolean')
    throw new WorkflowError('VALIDATION_INVALID', 'Expected a processing switch')
  return value
}
