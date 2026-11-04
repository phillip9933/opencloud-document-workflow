import {
  WorkflowError,
  errorCode,
  manualReviewReason,
  correctableProposal
} from '../../src/domain/errors'
import { printedDateISO } from '../../src/domain/languages'
import { validateBundle } from '../../src/domain/review'
import { samples } from '../../src/domain/samples'

it('review decisions use codes and survive changed or translated error messages', () => {
  const error = new WorkflowError('EVIDENCE_QUOTE', 'Unrelated translated message')
  expect(manualReviewReason(error)).toBe('evidence')
  expect(correctableProposal(error)).toBe(true)
  error.message = 'Something else'
  expect(manualReviewReason(error)).toBe('evidence')
  expect(manualReviewReason(new WorkflowError('DATE_AMBIGUOUS', 'Changed wording'))).toBe('date')
  expect(correctableProposal(new WorkflowError('DATE_AMBIGUOUS', 'Changed wording'))).toBe(false)
})
it('matching message text alone cannot authorize fallback or another model attempt', () => {
  for (const error of [
    new Error('Quote is absent from its page'),
    new Error('Invalid calendar date'),
    new Error('Document exceeds configured model context capacity')
  ]) {
    expect(manualReviewReason(error)).toBeNull()
    expect(correctableProposal(error)).toBe(false)
  }
  expect(errorCode({ code: 'unknown-private-code' })).toBeUndefined()
})
it('actual evidence and date validators emit stable codes', () => {
  const bundle = samples()[0]!
  bundle.proposal!.issuer.value = 'An invented issuer'
  expect(() => validateBundle(bundle)).toThrow(
    expect.objectContaining({ code: 'FACT_NOT_LITERAL' })
  )
  expect(() => printedDateISO('not a date')).toThrow(
    expect.objectContaining({ code: 'DATE_UNSUPPORTED' })
  )
})
