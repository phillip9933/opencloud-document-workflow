// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkflowErrorCode } from './errors'
/** Stable, translatable display messages. Never used to authorize a retry or write. */
const messages: Record<WorkflowErrorCode, string | undefined> = {
  VALIDATION_INVALID: 'The document details are invalid. Review them before continuing.',
  INVALID_OBJECT: 'The AI returned an incomplete or unsupported result.',
  INVALID_FIELDS: 'The AI returned an incomplete or unsupported result.',
  INVALID_TEXT: 'The AI returned an incomplete or unsupported result.',
  EVIDENCE_MISSING: 'The AI result could not be verified against the document.',
  EVIDENCE_PAGE: 'The AI result could not be verified against the document.',
  EVIDENCE_QUOTE: 'The AI result could not be verified against the document.',
  FACT_NOT_LITERAL: 'The AI result could not be verified against the document.',
  FOLDER_UNSUPPORTED: 'The suggested folder could not be verified against the document.',
  FOLDER_UNKNOWN: 'The suggested folder is not in the configured categories.',
  TAGS_INVALID: 'The suggested tags could not be verified against the document.',
  TAG_NAME_INVALID: 'Choose a valid tag name.',
  DATE_AMBIGUOUS: 'The printed document date needs review.',
  DATE_INVALID: 'The printed document date needs review.',
  DATE_UNSUPPORTED: 'The printed document date needs review.',
  WORKFLOW_CONTEXT_CAPACITY: 'The document is too large for the configured AI context.',
  WORKFLOW_BUSY: 'This document is busy. Wait for its current operation to finish.',
  REQUEST_INVALID: 'Invalid request',
  REQUEST_TOO_LARGE: 'Request exceeds limit',
  RESOURCE_NOT_FOUND: undefined,
  UPSTREAM_FAILURE: undefined,
  PROVIDER_RESPONSE_INVALID: undefined,
  SCHEMA_MISMATCH: undefined,
  SCHEMA_VERSION: undefined,
  RUNTIME_BUSY: undefined,
  INTERNAL_ERROR: 'An internal error occurred. Check Activity before retrying.',
  AUTH_REQUIRED: 'OpenCloud sign-in required',
  ACCESS_DENIED: 'OpenCloud access denied',
  // These codes cover multiple guarded stages; retain their specific safe detail.
  OPERATION_HELD: undefined,
  SOURCE_CHANGED: undefined,
  DEPENDENCY_UNAVAILABLE: undefined
}
export function errorMessageKey(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code as WorkflowErrorCode]
    : undefined
}
export const errorMessageKeys = [
  ...new Set(Object.values(messages).filter((value): value is string => value !== undefined))
]
