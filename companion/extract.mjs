// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { defaultLimits, validateLimits } from './configuration.mjs'
import { validateDocumentInput } from '../src/domain/review.ts'
/**
 * @param {string} path
 * @param {Omit<import('../src/domain/review.ts').Source,'sha256'> & {sha256?:string}} source
 * @param {import('./contracts.d.mts').ProcessingLimits} [limits]
 */
export async function extractPDF(path, source, limits = defaultLimits()) {
  limits = validateLimits(limits)
  const chunks = []
  let total = 0
  for await (const chunk of createReadStream(path)) {
    total += chunk.length
    if (total > limits.maxMiB * 1024 * 1024)
      throw new WorkflowError('VALIDATION_INVALID', 'PDF exceeds the configured processing size')
    chunks.push(chunk)
  }
  const data = Buffer.concat(chunks)
  return extractPDFBytes(data, source, limits)
}
/**
 * @param {Buffer} data
 * @param {Omit<import('../src/domain/review.ts').Source,'sha256'> & {sha256?:string}} source
 * @param {import('./contracts.d.mts').ProcessingLimits} [limits]
 */
export async function extractPDFBytes(data, source, limits = defaultLimits()) {
  limits = validateLimits(limits)
  if (
    data.length > limits.maxMiB * 1024 * 1024 ||
    !data.subarray(0, 5).equals(Buffer.from('%PDF-'))
  )
    throw new WorkflowError(
      'OPERATION_HELD',
      'Expected a PDF within the configured processing size'
    )
  // Feed exactly the bytes hashed, not a path that could change between reads.
  const { spawn } = await import('node:child_process')
  const text = await new Promise(
    /** @param {(value:string)=>void} resolve */ (resolve, reject) => {
      const child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
      /** @type {Buffer[]} */
      const chunks = []
      let bytes = 0,
        settled = false
      /** @param {Error|null} error @param {string} [result] */
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else if (result !== undefined) resolve(result)
        else reject(new WorkflowError('UPSTREAM_FAILURE', 'Extraction returned no result'))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new WorkflowError('UPSTREAM_FAILURE', 'PDF extraction timed out'))
      }, 30_000)
      child.on('error', () =>
        finish(new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Poppler pdftotext is required'))
      )
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > limits.maxCharacters * 4) {
          child.kill('SIGKILL')
          finish(new WorkflowError('VALIDATION_INVALID', 'PDF extracted text exceeds limit'))
        } else chunks.push(chunk)
      })
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.on('close', (code) =>
        code === 0
          ? finish(null, Buffer.concat(chunks).toString('utf8'))
          : finish(new WorkflowError('UPSTREAM_FAILURE', 'PDF extraction failed'))
      )
      child.stdin.end(data)
    }
  )
  const pages = text.split('\f')
  if (pages.length && !pages.at(-1)?.trim()) pages.pop()
  if (
    pages.length > limits.maxPages ||
    pages.reduce((n, p) => n + p.length, 0) > limits.maxCharacters
  )
    throw new WorkflowError(
      'VALIDATION_INVALID',
      'PDF exceeds configured page or text capacity; adjust Processing settings'
    )
  return validateDocumentInput({
    schemaVersion: 1,
    source: { ...source, sha256: createHash('sha256').update(data).digest('hex') },
    pages
  })
}
