// SPDX-License-Identifier: AGPL-3.0-only
export const workflowErrorCodes = [
  'VALIDATION_INVALID',
  'INVALID_OBJECT',
  'INVALID_FIELDS',
  'INVALID_TEXT',
  'EVIDENCE_MISSING',
  'EVIDENCE_PAGE',
  'EVIDENCE_QUOTE',
  'FACT_NOT_LITERAL',
  'FOLDER_UNSUPPORTED',
  'FOLDER_UNKNOWN',
  'TAGS_INVALID',
  'TAG_NAME_INVALID',
  'DATE_AMBIGUOUS',
  'DATE_INVALID',
  'DATE_UNSUPPORTED',
  'WORKFLOW_CONTEXT_CAPACITY',
  'WORKFLOW_BUSY',
  'REQUEST_INVALID',
  'REQUEST_TOO_LARGE',
  'OPERATION_HELD',
  'SOURCE_CHANGED',
  'DEPENDENCY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'RESOURCE_NOT_FOUND',
  'UPSTREAM_FAILURE',
  'PROVIDER_RESPONSE_INVALID',
  'SCHEMA_MISMATCH',
  'SCHEMA_VERSION',
  'RUNTIME_BUSY',
  'INTERNAL_ERROR'
] as const
export type WorkflowErrorCode = (typeof workflowErrorCodes)[number]
const codes = new Set<string>(workflowErrorCodes)
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode
  constructor(code: WorkflowErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
export function errorCode(error: unknown): WorkflowErrorCode | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' && codes.has(error.code)
    ? (error.code as WorkflowErrorCode)
    : undefined
}
export function manualReviewReason(error: unknown): 'evidence' | 'date' | 'capacity' | null {
  switch (errorCode(error)) {
    case 'INVALID_OBJECT':
    case 'INVALID_FIELDS':
    case 'INVALID_TEXT':
    case 'EVIDENCE_MISSING':
    case 'EVIDENCE_PAGE':
    case 'EVIDENCE_QUOTE':
    case 'FACT_NOT_LITERAL':
    case 'FOLDER_UNSUPPORTED':
    case 'FOLDER_UNKNOWN':
    case 'TAGS_INVALID':
    case 'TAG_NAME_INVALID':
      return 'evidence'
    case 'DATE_AMBIGUOUS':
    case 'DATE_INVALID':
    case 'DATE_UNSUPPORTED':
      return 'date'
    case 'WORKFLOW_CONTEXT_CAPACITY':
      return 'capacity'
    default:
      return null
  }
}
export function correctableProposal(error: unknown): boolean {
  switch (errorCode(error)) {
    case 'EVIDENCE_MISSING':
    case 'EVIDENCE_PAGE':
    case 'EVIDENCE_QUOTE':
    case 'FACT_NOT_LITERAL':
    case 'FOLDER_UNSUPPORTED':
    case 'FOLDER_UNKNOWN':
    case 'TAGS_INVALID':
    case 'DATE_UNSUPPORTED':
      return true
    default:
      return false
  }
}
