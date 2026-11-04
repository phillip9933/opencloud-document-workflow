// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { defaultLimits, validateLimits } from './configuration.mjs'
import { extractPDFBytes } from './extract.mjs'
import { ocrPages, ocrCandidatePages } from './ocr.mjs'
import { manualReviewReason } from '../src/domain/errors.ts'
import { validateBundle } from '../src/domain/review.ts'

/** Read exactly the pinned bytes; keep source checks ahead of OCR and inference.
 * @param {import('./contracts.d.mts').DocumentReadOptions} options
 */
export async function readDocument({
  actor,
  api,
  path,
  before,
  configuration,
  limits: configuredLimits,
  progress,
  onOCR
}) {
  const limits = validateLimits(configuredLimits ?? defaultLimits()),
    bytes = await api.get(path, before.etag, limits.maxMiB * 1024 * 1024),
    after = await api.stat(path)
  if (after?.resourceId !== before.resourceId || after?.etag !== before.etag)
    throw new Error('Source changed during reading')
  const source = {
    server: actor.server,
    account: actor.account,
    space: api.space ?? actor.space,
    resourceId: before.resourceId,
    path,
    etag: before.etag,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  const input = await extractPDFBytes(bytes, source, limits)
  const indices =
    configuration.policy.ocr !== 'off' ? await ocrCandidatePages(bytes, input.pages) : []
  const ocrAttempted = indices.length > 0
  if (ocrAttempted) {
    progress('ocr')
    input.pages = await ocrPages(bytes, input.pages, configuration.ocrLanguages ?? [], limits, {
      indices
    })
    onOCR(source)
  }
  return { source, input, ocrAttempted }
}

/** Provider data cannot replace the source, OCR text or configured rules.
 * @param {import('../src/domain/review.ts').DocumentInput} input
 * @param {unknown} bundle
 */
export function validatePreparedReview(input, bundle) {
  const validated = validateBundle(bundle)
  const { proposal, manualReview, ...returnedInput } = validated.bundle
  if (JSON.stringify(returnedInput) !== JSON.stringify(input))
    throw new Error('Provider result changed source identity or extracted pages')
  return validated
}

/** @param {unknown} error @param {boolean} enabled */
export function manualFallbackReason(error, enabled) {
  return enabled ? manualReviewReason(error) : null
}
