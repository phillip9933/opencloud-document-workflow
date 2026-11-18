// SPDX-License-Identifier: AGPL-3.0-only
import { extractPDFText } from './extract.mjs'
import { ocrCandidatePages, ocrPages } from './ocr.mjs'
import { validateLimits } from './configuration.mjs'
import { WorkflowError, errorCode } from '../src/domain/errors.ts'

/** @typedef {{limits:import('./contracts.d.mts').ProcessingLimits,ocr:boolean,languages:string[]}} PDFOptions */
/** @param {Buffer} bytes @param {PDFOptions} options @param {()=>void} onOCR */
export async function parsePDFText(bytes, { limits, ocr, languages }, onOCR) {
  const pages = await extractPDFText(bytes, limits)
  const indices = ocr ? await ocrCandidatePages(bytes, pages) : []
  if (!indices.length) return { pages, ocrAttempted: false }
  onOCR()
  return {
    pages: await ocrPages(bytes, pages, languages, limits, { indices }),
    ocrAttempted: true
  }
}

/** @param {string | string[] | undefined} header @returns {PDFOptions} */
function optionsFromHeader(header) {
  const value = typeof header === 'string' ? JSON.parse(header) : null
  if (
    !value ||
    typeof value.ocr !== 'boolean' ||
    !Array.isArray(value.languages) ||
    value.languages.length > 10 ||
    value.languages.some(
      (/** @type {unknown} */ lang) =>
        typeof lang !== 'string' ||
        lang.length > 100 ||
        !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(lang)
    )
  )
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid PDF worker settings')
  return { limits: validateLimits(value.limits), ocr: value.ocr, languages: value.languages }
}

/** @param {import('node:http').IncomingMessage} req @param {number} max */
async function pdfBytes(req, max) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > max) throw new WorkflowError('VALIDATION_INVALID', 'PDF exceeds worker limit')
    parts.push(part)
  }
  return Buffer.concat(parts)
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
export async function servePDFText(req, res) {
  try {
    const options = optionsFromHeader(req.headers['x-workflow-pdf-options'])
    const bytes = await pdfBytes(req, options.limits.maxMiB * 1024 * 1024)
    const parsed = await parsePDFText(bytes, options, () => {
      // Informational response keeps OCR progress separate from final data.
      res.writeProcessing()
    })
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(parsed))
  } catch (error) {
    const code = errorCode(error)
    res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code }))
  }
}
