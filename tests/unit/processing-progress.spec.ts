import { processingProgress, processingStatus } from '../../src/domain/processing'
it('reports recorded reading, OCR and model stages rather than guessing progress from elapsed time', () => {
  expect(processingProgress({ state: 'queued', stage: 'analysing' })).toMatchObject({
    step: 1,
    label: 'Waiting to prepare'
  })
  expect(processingProgress({ state: 'running', stage: 'reading' })).toMatchObject({
    step: 2,
    label: 'Reading PDF text'
  })
  expect(processingProgress({ state: 'running', stage: 'ocr' })).toMatchObject({
    step: 2,
    label: 'Reading scanned pages'
  })
  expect(processingProgress({ state: 'running', stage: 'analysing' })).toMatchObject({
    step: 3,
    label: 'Analysing with AI'
  })
  expect(processingProgress({ state: 'failed', stage: 'analysing' })).toMatchObject({
    step: 3,
    attention: true
  })
  expect(processingProgress({ state: 'prepared', decision: 'needs_review' })).toMatchObject({
    step: 4,
    label: 'Ready to review'
  })
  expect(processingProgress({ state: 'prepared', decision: 'done' })).toMatchObject({
    step: 5,
    label: 'Filed'
  })
})
it('keeps uncertain writes visible after cancellation and keeps duplicates distinct from their original', () => {
  expect(
    processingProgress({ state: 'cancelled', stage: 'review', decision: 'move_intent' })
  ).toMatchObject({ step: 4, label: 'Verify filing outcome', attention: true })
  expect(processingProgress({ state: 'cancelled', stage: 'analysing' })).toMatchObject({
    step: 3,
    label: 'Cancelled'
  })
  expect(processingProgress({ state: 'duplicate', decision: 'done' })).toMatchObject({
    step: 2,
    label: 'Duplicate held'
  })
})

it('shows the optional AI tag pass within the AI milestone without pretending it is complete', () => {
  expect(processingProgress({ state: 'running', stage: 'tagging' })).toEqual({
    step: 3,
    total: 5,
    label: 'Reviewing tags with AI'
  })
  expect(processingStatus({ state: 'running', stage: 'tagging' })).toBe('Processing')
})

it('finishes rejected suggestions explicitly while distinguishing a kept file from a trashed file', () => {
  expect(processingProgress({ state: 'prepared', decision: 'rejected' })).toEqual({
    step: 5,
    total: 5,
    label: 'File kept in place'
  })
  expect(processingStatus({ state: 'prepared', decision: 'rejected' })).toBe('Suggestion rejected')
  expect(processingProgress({ state: 'removed', decision: 'rejected' })).toEqual({
    step: 5,
    total: 5,
    label: 'In OpenCloud Trash'
  })
  expect(processingStatus({ state: 'removed', decision: 'rejected' })).toBe('In OpenCloud Trash')
})
