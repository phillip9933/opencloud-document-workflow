// SPDX-License-Identifier: AGPL-3.0-only
import { workflowErrorCodes, manualReviewReason } from '../src/domain/errors.ts'
import { readdirSync } from 'node:fs'

const sourceFiles = new Set(
  readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.mjs'))
)
const events = new Set([
  'request_failed',
  'http_handler_failed',
  'intake_scan_failed',
  'intake_worker_failed',
  'intake_document_held',
  'server_started',
  'shutdown_failed',
  'backup_failed',
  'backup_cleanup_failed',
  'backup_unlock_failed',
  'session_failed',
  'app_token_failed',
  'bulk_item_held',
  'bulk_failed',
  'automation_held'
])
const codes = new Set([
  ...workflowErrorCodes,
  'ERR_SQLITE_ERROR',
  'SQLITE_BUSY',
  'WORKFLOW_BUSY',
  'RUNTIME_BUSY',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'EACCES',
  'ENOSPC',
  'ERR_HTTP_HEADERS_SENT'
])
const reasons = new Set([
  'backup_busy',
  'backup_access_required',
  'backup_upload_held',
  'capacity_hold',
  'backup_unavailable',
  'integrity_failed',
  'schema_incomplete',
  'manifest_invalid',
  'private_file_required',
  'private_directory_required',
  'unexpected_backup_entry',
  'backup_settings_invalid',
  'backup_clock_mismatch',
  'credential_format',
  'refresh_uncertain',
  'sign_in_required',
  'credential_changed',
  'credential_missing',
  'identity_changed',
  'connection_unavailable'
])
/** @param {Record<string, unknown>} detail */
function errorLevel(detail) {
  if (detail.code === 'WORKFLOW_BUSY' || detail.backupReason === 'backup_busy') return 'info'
  if (
    [401, 403, 404].includes(Number(detail.status)) ||
    [
      'VALIDATION_INVALID',
      'RESOURCE_NOT_FOUND',
      'REQUEST_INVALID',
      'REQUEST_TOO_LARGE',
      'AUTH_REQUIRED',
      'ACCESS_DENIED',
      'SOURCE_CHANGED',
      'DEPENDENCY_UNAVAILABLE',
      'OPERATION_HELD'
    ].includes(String(detail.code)) ||
    manualReviewReason(detail) !== null ||
    reasons.has(String(detail.backupReason ?? detail.sessionReason))
  )
    return 'warn'
  return 'error'
}
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError'])

/** @param {(line: string) => unknown} [write] @returns {import('./contracts.d.mts').Logger} */
export function createLogger(write = (line) => process.stderr.write(line)) {
  return (event, error) => {
    // Allowlisted metadata only: messages, stack text, URLs, request bodies and
    // arbitrary error properties may contain document content or credentials.
    /** @type {{time:string,level:string,event:string,errorType?:string,code?:string,status?:number,reason?:string,locations?:string[]}} */
    const record = {
      time: new Date().toISOString(),
      level: error ? 'error' : 'info',
      event: events.has(event) ? event : 'http_handler_failed'
    }
    if (error) {
      const detail = typeof error === 'object' ? /** @type {Record<string,unknown>} */ (error) : {}
      record.level = errorLevel(detail)
      const reason = detail.backupReason ?? detail.sessionReason
      if (typeof reason === 'string' && reasons.has(reason)) record.reason = reason
      record.errorType =
        typeof detail.name === 'string' && types.has(detail.name) ? detail.name : 'Error'
      if (typeof detail.code === 'string' && codes.has(detail.code)) record.code = detail.code
      if (
        typeof detail.status === 'number' &&
        Number.isInteger(detail.status) &&
        detail.status >= 400 &&
        detail.status <= 599
      )
        record.status = detail.status
      const frames = [
        ...String(detail.stack ?? '').matchAll(
          /\/companion\/([a-z][a-z0-9-]*\.mjs):(\d+):(\d+)\)?$/gm
        )
      ]
      record.locations = [
        ...new Set(
          frames
            .filter(([, file]) => sourceFiles.has(file))
            .map(([, file, line, column]) => `${file}:${line}:${column}`)
        )
      ].slice(0, 8)
    }
    try {
      write(JSON.stringify(record) + '\n')
    } catch {
      /* Log transport failure cannot crash document processing. */
    }
  }
}

export const logEvent = createLogger()
