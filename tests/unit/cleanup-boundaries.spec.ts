// SPDX-License-Identifier: AGPL-3.0-only
import { createCompanionRequest } from '../../src/state/companion-request'
import { retainPinnedReview, createReviewCollection } from '../../src/state/review-collection'
import {
  canContinueFiling,
  needsFilingVerification,
  filingInProgress,
  canReviseFiling
} from '../../src/domain/decision-state'
import { samples } from '../../src/domain/samples'
import type { DraftJob } from '../../src/state/workspace'

afterEach(() => vi.unstubAllGlobals())
const actor = { server: 'https://example.invalid', account: 'synthetic', space: 'space' }
const request = () =>
  createCompanionRequest({
    token: () => 'synthetic',
    space: () => actor.space,
    generation: () => 0,
    connection: () => actor
  })
it('preserves typed response codes and safe Trash non-write evidence across the request boundary', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { code: 'SOURCE_CHANGED', error: 'Reopen the document', trashRecorded: false },
        { status: 409 }
      )
    )
  )
  await expect(request()('document-trash')).rejects.toMatchObject({
    code: 'SOURCE_CHANGED',
    message: 'Reopen the document',
    trashRecorded: false
  })
  await expect(request()('metadata')).rejects.not.toHaveProperty('trashRecorded')
})
it('maps unrecognized server codes to upstream failures, not a correctable document error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ code: 'unknown', error: 'Service unavailable' }, { status: 502 })
    )
  )
  await expect(request()('status')).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE' })
})
function job(id = 'a'): DraftJob {
  const bundle = samples()[0]
  return {
    id,
    source: bundle.source,
    bundle,
    state: 'needs_review',
    error: null,
    decision: null,
    updated: '2026-01-01T00:00:00Z'
  }
}
it('keeps the selected attempt when two jobs have identical document contents', () => {
  const reviews = createReviewCollection()
  reviews.installJobs([job('a'), job('b')])
  reviews.selected.value = 1
  reviews.installJobs([job('b'), job('a')])
  expect(reviews.jobFor(reviews.reviews.value[reviews.selected.value])?.id).toBe('b')
  reviews.clear()
  expect(reviews.jobs.value).toEqual([])
  expect(reviews.reviews.value).toEqual([])
})
it('retains detailed diagnostics only for an unchanged job revision', () => {
  const pinned = {
    ...job(),
    processingIssue: {
      message: 'Needs date review',
      nextStep: 'Inspect the date',
      retryable: false
    }
  }
  expect(retainPinnedReview([job()], pinned)[0].processingIssue).toEqual(pinned.processingIssue)
  for (const changed of [
    { ...job(), state: 'running' },
    { ...job(), updated: '2026-01-02T00:00:00Z' },
    { ...job(), source: { ...job().source, etag: 'changed' } },
    { ...job(), processingIssue: null }
  ])
    expect(retainPinnedReview([changed], pinned)[0].processingIssue).not.toEqual(
      pinned.processingIssue
    )
  expect(retainPinnedReview([], pinned)).toEqual([pinned])
})
it.each(['move_intent', 'tags_intent', 'copy_intent'])(
  'allows only verification for the uncertain %s filing state',
  (state) => {
    expect(needsFilingVerification(state)).toBe(true)
    expect(canContinueFiling(state)).toBe(false)
    expect(filingInProgress(state)).toBe(true)
    expect(canReviseFiling(state)).toBe(false)
  }
)
it('keeps completed and rejected reviews editable without treating them as pending writes', () => {
  for (const state of [null, 'done', 'rejected', 'conflict']) {
    expect(canReviseFiling(state)).toBe(true)
    expect(filingInProgress(state)).toBe(false)
  }
})
