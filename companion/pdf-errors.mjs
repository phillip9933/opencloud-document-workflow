// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'

// Only these reasons cross the worker boundary. Tool output stays private.
const diagnostics = /** @type {const} */ ({
  ocr_language: {
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'A selected OCR language is unavailable.',
    nextStep:
      'Install or select an available language under OCR languages in Processing settings, then retry.'
  },
  worker_tool: {
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'A required PDF or OCR tool is unavailable.',
    nextStep: 'Ask your administrator to check the document worker installation.'
  },
  pdf_unreadable: {
    code: 'OPERATION_HELD',
    message: 'The PDF could not be read or exceeds the processing limits.',
    nextStep: 'Check the PDF and Processing capacity settings, then retry.'
  },
  pdf_capacity: {
    code: 'VALIDATION_INVALID',
    message: 'The document exceeds the PDF processing limits.',
    nextStep: 'Check the PDF and Processing capacity settings, then retry.'
  },
  worker_timeout: {
    code: 'OPERATION_HELD',
    message: 'Processing timed out.',
    nextStep: 'Split the PDF into smaller documents and retry.'
  },
  ocr_page_limit: {
    code: 'OPERATION_HELD',
    message: 'More than 64 pages require OCR.',
    nextStep: 'Split the PDF into smaller documents and retry.'
  },
  ocr_failed: {
    code: 'UPSTREAM_FAILURE',
    message: 'Text recognition could not read the scanned pages.',
    nextStep: 'Check OCR languages and the scan quality, then retry.'
  }
})
/** @typedef {keyof typeof diagnostics} PDFReason */
/** @param {unknown} value @returns {value is PDFReason} */
export function isPDFReason(value) {
  return typeof value === 'string' && Object.hasOwn(diagnostics, value)
}
export class PDFProcessingError extends WorkflowError {
  /** @param {PDFReason} reason @param {string} [detail] */
  constructor(reason, detail) {
    super(diagnostics[reason].code, detail ?? diagnostics[reason].message)
    this.pdfReason = reason
  }
}
/** @param {PDFReason} reason */
export function pdfIssue(reason) {
  const { message, nextStep } = diagnostics[reason]
  return { message, nextStep, settings: '/document-workflow/settings/processing' }
}
