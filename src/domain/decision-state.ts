// SPDX-License-Identifier: AGPL-3.0-only
/** Shared presentation policy. Backend approval and recovery guards remain authoritative. */
export function canContinueFiling(state?: string | null): boolean {
  return ['approved', 'folders_pending', 'move_done', 'transfer_ready'].includes(state ?? '')
}
export function needsFilingVerification(state?: string | null): boolean {
  return ['move_intent', 'tags_intent', 'copy_intent'].includes(state ?? '')
}
export function filingInProgress(state?: string | null): boolean {
  return canContinueFiling(state) || needsFilingVerification(state)
}
export function canReviseFiling(state?: string | null): boolean {
  return !state || ['done', 'rejected', 'conflict'].includes(state)
}
