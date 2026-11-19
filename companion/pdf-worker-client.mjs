// SPDX-License-Identifier: AGPL-3.0-only
import { isPDFReason, PDFProcessingError } from './pdf-errors.mjs'
import { OCR_BUDGET_MS } from './ocr.mjs'
import { request } from 'node:http'
import { workerOrigin } from './conversion-client.mjs'
import { WorkflowError } from '../src/domain/errors.ts'

/** @param {unknown} value @param {import('./contracts.d.mts').ProcessingLimits} limits */
function readWorkerResult(value, limits) {
  const { pages, ocrAttempted } = /** @type {{pages?:unknown,ocrAttempted?:unknown}} */ (
    value ?? {}
  )
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > limits.maxPages ||
    pages.some((page) => typeof page !== 'string') ||
    pages.reduce((length, page) => length + page.length, 0) > limits.maxCharacters ||
    typeof ocrAttempted !== 'boolean'
  )
    throw new WorkflowError('UPSTREAM_FAILURE', 'Invalid PDF worker result')
  return { pages: /** @type {string[]} */ (pages), ocrAttempted }
}

/** @param {import('node:http').IncomingMessage} response @param {number} max */
async function readReply(response, max) {
  const parts = []
  let length = 0
  for await (const part of response) {
    length += part.length
    if (length > max) throw new WorkflowError('UPSTREAM_FAILURE', 'PDF worker output exceeds limit')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

/** @param {import('node:http').IncomingMessage} response
 * @param {import('./contracts.d.mts').ProcessingLimits} limits */
async function parseReply(response, limits) {
  if (response.statusCode === 503) {
    response.resume()
    throw new WorkflowError('WORKFLOW_BUSY', 'The document worker is busy')
  }
  if (response.statusCode !== 200) {
    const reply = await readReply(response, 1024)
    if (isPDFReason(reply?.pdfReason)) throw new PDFProcessingError(reply.pdfReason)
    if (reply?.code === 'DEPENDENCY_UNAVAILABLE')
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'PDF worker tools or OCR data are missing')
    throw new WorkflowError('OPERATION_HELD', 'PDF extraction or OCR did not complete')
  }
  return readWorkerResult(
    await readReply(response, limits.maxCharacters * 6 + limits.maxPages * 4 + 1024),
    limits
  )
}

/** @param {string|undefined} endpoint @param {typeof request} [transport] @returns {typeof import('./pdf-worker.mjs').parsePDFText} */
export function createPDFWorkerClient(endpoint, transport = request) {
  const target = workerOrigin(endpoint) + '/extract'
  return (bytes, options, onOCR) =>
    new Promise((resolve, reject) => {
      const connection = transport(
        target,
        {
          method: 'POST',
          signal: AbortSignal.timeout(options.ocr ? OCR_BUDGET_MS + 120000 : 90000),
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': bytes.length,
            'X-Workflow-PDF-Options': JSON.stringify(options)
          }
        },
        (response) => {
          parseReply(response, options.limits).then(resolve, (error) =>
            reject(
              error instanceof WorkflowError
                ? error
                : new WorkflowError('UPSTREAM_FAILURE', 'PDF worker response failed')
            )
          )
        }
      )
      connection.on('information', (info) => {
        if (info.statusCode !== 102) return
        try {
          onOCR()
        } catch (error) {
          connection.destroy()
          reject(error)
        }
      })
      connection.on('error', () =>
        reject(new WorkflowError('UPSTREAM_FAILURE', 'PDF worker connection failed'))
      )
      connection.end(bytes)
    })
}
