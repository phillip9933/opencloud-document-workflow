// SPDX-License-Identifier: AGPL-3.0-only
import { once } from 'node:events'
import { WorkflowError } from '../src/domain/errors.ts'
import { requestText } from './api-input.mjs'

/** @param {number} size @param {number} max */
function checkSize(size, max) {
  if (size > max)
    throw new WorkflowError('REQUEST_TOO_LARGE', 'Document exceeds the processing size limit')
}

/** @param {Response} response @param {import('node:http').ServerResponse} res @param {number} max */
async function streamPDF(response, res, max) {
  const reader = response.body?.getReader()
  if (!reader) throw new WorkflowError('UPSTREAM_FAILURE', 'OpenCloud returned no document')
  const controller = new AbortController()
  const close = () => {
    controller.abort()
    void reader.cancel().catch(() => {})
  }
  res.once('close', close)
  if (res.destroyed) close()
  try {
    checkSize(Number(response.headers.get('content-length')), max)
    let size = 0
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      checkSize(size, max)
      if (!res.write(value)) await once(res, 'drain', { signal: controller.signal })
    }
    if (!res.destroyed) res.end()
  } finally {
    res.off('close', close)
    await reader.cancel().catch(() => {})
  }
}

/** @param {import('./configuration.mjs').Configuration} configuration
 * @returns {import('./api-contracts.d.mts').FullAPIRoute} */
export function createDocumentPreview(configuration) {
  // Account keys deliberately omit Space so switching Spaces cannot bypass the limit.
  const active = new Set()
  return async ({ actor, documentAPI, body, res }) => {
    const account = JSON.stringify([actor.server, actor.account])
    if (active.has(account) || active.size >= 8)
      throw new WorkflowError('WORKFLOW_BUSY', 'Too many document previews; try again shortly')
    active.add(account)
    const controller = new AbortController()
    const close = () => controller.abort()
    res.once('close', close)
    try {
      const path = requestText(body.path)
      const current = await documentAPI.stat(path)
      if (res.destroyed) return true
      if (!current || current.folder || !current.etag)
        throw new WorkflowError('RESOURCE_NOT_FOUND', 'Document not found')
      const max = configuration.settings(actor).limits.maxMiB * 1024 * 1024
      checkSize(current.size ?? 0, max)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'inline; filename="document.pdf"')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (documentAPI.openDownload)
        await streamPDF(
          await documentAPI.openDownload(path, current.etag, controller.signal),
          res,
          max
        )
      else {
        // In-memory demo and synthetic adapters do not need a remote stream.
        const bytes = await documentAPI.get(path, current.etag, max)
        checkSize(bytes.length, max)
        res.end(bytes)
      }
      return true
    } finally {
      res.off('close', close)
      active.delete(account)
    }
  }
}
