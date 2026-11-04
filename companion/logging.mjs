// SPDX-License-Identifier: AGPL-3.0-only
const events = new Set(['request_failed', 'http_handler_failed', 'intake_scan_failed', 'intake_worker_failed', 'intake_document_held', 'server_started', 'shutdown_failed'])
const codes = new Set(['ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'WORKFLOW_BUSY', 'RUNTIME_BUSY', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EACCES', 'ENOSPC', 'ERR_HTTP_HEADERS_SENT'])
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError'])

export function createLogger(write = line => process.stderr.write(line)) {
  return (event, error) => {
    // Allowlisted metadata only: messages, stack text, URLs, request bodies and
    // arbitrary error properties may contain document content or credentials.
    const record = { time: new Date().toISOString(), level: error ? 'error' : 'info', event: events.has(event) ? event : 'http_handler_failed' }
    if (error) {
      record.errorType = types.has(error.name) ? error.name : 'Error'
      if (codes.has(error.code)) record.code = error.code
      if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) record.status = error.status
      const frames = [...String(error.stack ?? '').matchAll(/\/companion\/([a-z][a-z0-9-]*\.mjs):(\d+):(\d+)\)?$/gm)]
      record.locations = [...new Set(frames.map(([, file, line, column]) => `${file}:${line}:${column}`))].slice(0, 8)
    }
    try { write(JSON.stringify(record) + '\n') } catch { /* Log transport failure cannot crash document processing. */ }
  }
}

export const logEvent = createLogger()
