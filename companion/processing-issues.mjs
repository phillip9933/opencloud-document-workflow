// SPDX-License-Identifier: AGPL-3.0-only
import { selectBulkPreparation } from './bulk-preparation.mjs'
import { manualReviewReason } from '../src/domain/errors.ts'
// Persist a useful, bounded diagnosis without copying provider bodies or secrets.
export function preparationIssue(error) {
  const reason = manualReviewReason(error)
  const text = typeof error?.message === 'string' ? error.message : '',
    result = (message, nextStep) => ({
      message,
      nextStep,
      settings: '/document-workflow/settings/processing'
    })
  if (
    ['TimeoutError', 'AbortError'].includes(error?.name) ||
    /^(The operation was aborted due to timeout|The operation was aborted)$/.test(text) ||
    /^(OCR command timed out|PDF extraction timed out|OCR document time limit reached)$/.test(text)
  )
    return result(
      'Processing timed out.',
      'Check the AI service or try a smaller document, then retry.'
    )
  if (
    reason === 'evidence' ||
    [
      'Missing bounded evidence',
      'Invalid evidence page',
      'Quote is absent from its page',
      'Fact is not present in its evidence',
      'Folder lacks supporting evidence',
      'Unknown folder category'
    ].includes(text)
  )
    return result(
      'The AI result could not be verified against the document.',
      'A proposed field or category did not match its cited text. Retry with another model or review the document manually.'
    )
  if (
    reason === 'date' ||
    /^(Unsupported printed date format; add an explicit language\/date rule|Ambiguous printed date; review the date convention explicitly|Invalid calendar date)$/.test(
      text
    )
  )
    return {
      ...result(
        'The printed document date needs review.',
        'Check the date interpretation rules in Folders settings or review the date manually.'
      ),
      settings: '/document-workflow/settings/folders'
    }
  if (text === 'fetch failed' || /^Ollama HTTP (5\d\d|429)$/.test(text))
    return result(
      'The AI service was unavailable or busy.',
      'Check the AI service connection, then retry.'
    )
  if (/^Ollama HTTP [45]\d\d$/.test(text))
    return result(
      'The AI service refused the request.',
      'Check the model and provider settings, then retry.'
    )
  if (text.startsWith('Select an installed local model'))
    return result(
      'The selected local AI model is not installed.',
      'Choose an installed model in Processing settings, then retry.'
    )
  if (
    reason === 'capacity' ||
    text.startsWith('Document exceeds configured model context capacity')
  )
    return result(
      'The document is too large for the configured AI context.',
      'Increase the model context in Processing settings or split the PDF, then retry.'
    )
  if (
    /^(Choose OCR languages|Selected OCR language data is not installed|OCR requires \w+)$/.test(
      text
    )
  )
    return result(
      'Text recognition is missing a required OCR language or tool.',
      'Check OCR languages in Processing settings, then retry.'
    )
  if (text === 'OCR command failed')
    return result(
      'Text recognition could not read the scanned pages.',
      'Check OCR languages and the scan quality, then retry.'
    )
  if (
    /^(Expected a PDF within the configured processing size|PDF extraction failed|PDF exceeds configured page or text capacity; adjust Processing settings|PDF exceeds the configured processing size)$/.test(
      text
    )
  )
    return result(
      'The PDF could not be read or exceeds the processing limits.',
      'Check the PDF and Processing capacity settings, then retry.'
    )
  if (/^(Source changed during reading|PDF source not found)$/.test(text))
    return {
      message: 'The uploaded file changed or is no longer available.',
      nextStep: 'Wait for the upload to finish, then check the inbox again.',
      settings: '/document-workflow/inbox'
    }
  if (
    /^(Ollama returned invalid proposal JSON|Incomplete or invalid Ollama response|Unexpected or missing fields|Expected an object|Invalid text field)$/.test(
      text
    )
  )
    return result(
      'The AI returned an incomplete or unsupported result.',
      'Check the selected model, then retry or review this document manually.'
    )
  return result(
    'Document preparation stopped before a valid review was ready.',
    'Check AI and OCR settings, then retry. If it stops again, review the document manually.'
  )
}
// Only pinned preparation reads establish the currently displayed attempt.
export function bulkPreparation(workflow, actor, source) {
  if (
    !workflow.db
      .prepare("select 1 from sqlite_master where type='table' and name='bulk_items'")
      .get()
  )
    return null
  const row = workflow.db
    .prepare(
      "select i.state,i.result,o.state operationState,o.updated from bulk_items i join bulk_operations o on o.id=i.operation where o.scope=? and o.kind='prepare' and json_extract(i.input,'$.resourceId')=? and json_extract(i.input,'$.etag')=? order by o.created desc,o.id desc limit 1"
    )
    .get(workflow.scope(actor), source.resourceId, source.etag)
  const latest = workflow.db
    .prepare(
      "select updated from proposals where scope=? and json_extract(input,'$.source.resourceId')=? and json_extract(input,'$.source.etag')=? order by updated desc,id desc limit 1"
    )
    .get(workflow.scope(actor), source.resourceId, source.etag)
  return selectBulkPreparation(row, latest)
}

export function processingIssue(workflow, actor, source) {
  // Original-format files can be filed manually; a missing PDF is not a failure.
  if (!/\.pdf$/i.test(source.path)) return null
  const hasIntake = workflow.db
    .prepare("select 1 from sqlite_master where type='table' and name='intake_queue'")
    .get()
  const row = hasIntake
    ? workflow.db
        .prepare(
          'select id,state,job,stage,issue from intake_queue where scope=? and resource=? and etag=? order by first_seen desc limit 1'
        )
        .get(workflow.scope(actor), source.resourceId, source.etag)
    : null
  const decision = row?.job ? workflow.decision(actor, row.job) : null,
    automatic = row?.job ? workflow.automation?.statusFor(actor, row.job) : null
  if (decision?.state === 'done' || automatic?.state === 'done') return null
  const result = (
    message,
    nextStep,
    settings = '/document-workflow/settings/processing',
    retryable = false
  ) => ({ ...(row ? { queueId: row.id } : {}), message, nextStep, settings, retryable })
  if (['move_intent', 'tags_intent', 'copy_intent'].includes(decision?.state))
    return result(
      'The last filing request has an unconfirmed outcome.',
      'Use Verify outcome before retrying. The app will check the existing file without repeating the write.',
      '/document-workflow/activity'
    )
  if (decision?.state === 'conflict')
    return result(
      'The source or destination no longer matches the approved filing plan.',
      'Inspect the destination and prepare a new filing plan. Existing files will not be overwritten.',
      '/document-workflow/settings/folders'
    )
  const attempt = workflow.db
    .prepare(
      'select state,issue from preparation_attempts where scope=? and space=? and resource=? and etag=?'
    )
    .get(workflow.scope(actor), source.space ?? actor.space, source.resourceId, source.etag)
  if (attempt) return attempt.state === 'failed' && attempt.issue ? JSON.parse(attempt.issue) : null
  const batch = bulkPreparation(workflow, actor, source)
  if (batch && ['queued', 'running'].includes(batch.state)) return null
  if (batch?.state === 'held')
    return {
      ...preparationIssue({ message: batch.result.error }),
      settings: '/document-workflow/activity',
      retryable: false
    }
  if (!row) return null
  if (['queued', 'settling', 'running'].includes(row.state)) return null
  if (automatic?.state === 'held')
    return result(
      automatic.detail || 'Automatic filing needs review.',
      'Review the filing details and fields. Verify any existing filing decision before continuing.',
      '/document-workflow/settings/processing',
      !decision
    )
  if (row.state === 'failed')
    return {
      ...result(
        'This earlier processing attempt stopped. Its detailed reason was not recorded.',
        'Check AI and OCR settings, then retry to record a fresh result.',
        '/document-workflow/settings/processing',
        !decision
      ),
      ...(row.issue ? JSON.parse(row.issue) : {})
    }
  if (row.job && workflow.journal.get(row.job)?.state === 'needs_ocr')
    return result(
      'Some PDF pages have no readable text.',
      'Enable text recognition and choose the document languages in Processing settings, then prepare it again.',
      '/document-workflow/settings/processing',
      !decision
    )
  return null
}

export function preparationState(workflow, actor, source) {
  const row = workflow.db
    .prepare(
      'select * from preparation_attempts where scope=? and space=? and resource=? and etag=?'
    )
    .get(workflow.scope(actor), source.space ?? actor.space, source.resourceId, source.etag)
  if (row) {
    const live =
      row.state === 'running' &&
      workflow.preparationOwners.has(row.owner) &&
      workflow.db.prepare('select 1 from workflow_locks where owner=?').get(row.owner)
    let state = row.state,
      issue = row.issue ? JSON.parse(row.issue) : null
    if (state === 'running' && !live) {
      state = 'failed'
      issue = {
        message: 'Document preparation was interrupted.',
        nextStep: 'Reprocess this document to start a fresh attempt.',
        retryable: false
      }
    }
    return {
      state,
      stage: row.stage,
      job: row.job,
      started: row.started,
      updated: row.updated,
      processingIssue: issue
    }
  }
  const batch = bulkPreparation(workflow, actor, source)
  if (batch)
    return {
      state: batch.state === 'held' ? 'failed' : batch.state,
      stage: batch.result.stage ?? null,
      job: null,
      paused: batch.operationState === 'paused',
      processingIssue:
        batch.state === 'held'
          ? { ...preparationIssue({ message: batch.result.error }), retryable: false }
          : null
    }
  const hasIntake = workflow.db
    .prepare("select 1 from sqlite_master where type='table' and name='intake_queue'")
    .get()
  const rowIntake = hasIntake
    ? workflow.db
        .prepare(
          'select state,stage,job from intake_queue where scope=? and resource=? and etag=? order by first_seen desc limit 1'
        )
        .get(workflow.scope(actor), source.resourceId, source.etag)
    : null
  return rowIntake
    ? {
        ...rowIntake,
        paused: workflow.intake?.paused(actor) ?? false,
        processingIssue: processingIssue(workflow, actor, source)
      }
    : {
        state: 'idle',
        stage: null,
        job: null,
        processingIssue: processingIssue(workflow, actor, source)
      }
}
