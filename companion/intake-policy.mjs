// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { safePath } from '../src/domain/review.ts'
export const defaultIntake = () => ({
  enabled: false,
  folder: 'Inbox',
  recursive: true,
  intervalSeconds: 30,
  settleSeconds: 10,
  cloudConsent: false
})
/** @param {unknown} value */
export function validateIntake(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid intake settings')
  const c = /** @type {Record<string,unknown>} */ (value)
  if (
    !c ||
    Object.keys(c).sort().join(',') !==
      'cloudConsent,enabled,folder,intervalSeconds,recursive,settleSeconds' ||
    typeof c.cloudConsent !== 'boolean' ||
    typeof c.enabled !== 'boolean' ||
    typeof c.recursive !== 'boolean' ||
    typeof c.intervalSeconds !== 'number' ||
    !Number.isInteger(c.intervalSeconds) ||
    (c.intervalSeconds !== 0 && c.intervalSeconds < 5) ||
    c.intervalSeconds > 86400 ||
    typeof c.settleSeconds !== 'number' ||
    !Number.isInteger(c.settleSeconds) ||
    c.settleSeconds < 2 ||
    c.settleSeconds > 3600
  )
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid intake settings')
  if (typeof c.folder !== 'string')
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid intake settings')
  safePath(c.folder)
  return structuredClone(/** @type {ReturnType<typeof defaultIntake>} */ (c))
}
/** @param {{state:string,decision?:string|null,automaticState?:string|null,proposalState?:string|null}} row */
export function intakeBucket(row) {
  if (['duplicate', 'trashed', 'restored'].includes(row.state)) return 'duplicates'
  if (row.state === 'removed') return 'completed'
  if (row.state === 'superseded') return 'superseded'
  if (row.decision === 'done' || row.automaticState === 'done') return 'completed'
  if (row.decision && !['rejected'].includes(row.decision)) return 'attention'
  if (row.state === 'cancelled') return 'cancelled'
  if (row.state === 'running' || ['pending', 'running'].includes(row.automaticState ?? ''))
    return 'running'
  if (['settling', 'queued'].includes(row.state)) return 'waiting'
  if (row.state === 'failed' || row.automaticState === 'held' || row.proposalState === 'needs_ocr')
    return 'attention'
  if (row.decision === 'rejected') return 'completed'
  return 'ready'
}
/** @param {{state:string,decision?:string|null,automaticState?:string|null,proposalState?:string|null}} row */
export function intakeRetryable(row) {
  return (
    !row.decision &&
    row.automaticState !== 'done' &&
    (['failed', 'cancelled'].includes(row.state) ||
      (row.state === 'prepared' &&
        (row.automaticState === 'held' || row.proposalState === 'needs_ocr')))
  )
}
/** @param {{state:string,decision?:string|null,automaticState?:string|null,proposalState?:string|null}} row */
export function intakeCancellable(row) {
  return (
    row.decision !== 'done' &&
    row.automaticState !== 'done' &&
    row.state !== 'cancelled' &&
    (['settling', 'queued', 'running', 'failed'].includes(row.state) ||
      (row.state === 'prepared' &&
        ['pending', 'running', 'held'].includes(row.automaticState ?? '')))
  )
}
