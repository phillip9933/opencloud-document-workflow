// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../domain/errors'
import type { Ref } from 'vue'
import type { Workspace, DraftJob } from './workspace'
import type { Review, Policy, ManualActions } from '../domain/review'
import type { useInboxNavigation } from './inbox-navigation'
import { reviewDigest, createApproval } from '../domain/review'
import { statusLabel as displayStatus } from '../domain/status'
type DecisionOperation = 'approve' | 'reject' | 'apply' | 'reconcile' | 'file'
type Verification = { checkedAt: string; resourceId: string; sha256: string; tags: string[] }
interface DecisionResult {
  state: string
  uncertain?: boolean
  tags: string[]
  verification?: Verification & { originalResourceId?: string }
}
interface Context {
  store: Workspace
  active: Ref<Review | undefined>
  job: Ref<DraftJob | undefined>
  busy: Ref<boolean>
  fileTrashState: Ref<{ busy: boolean; uncertain: boolean }>
  fieldsBusy: Ref<boolean>
  fieldsUncertain: Ref<boolean>
  fieldEditsPending: Ref<boolean>
  previewChanged: Ref<boolean>
  error: Ref<string>
  message: Ref<string>
  navigation: ReturnType<typeof useInboxNavigation>
  policy: Ref<Policy>
  manual: Ref<boolean>
  manualActions(): ManualActions | undefined
  requestedJob: Ref<string | undefined>
  inInbox: Ref<boolean>
  verification: Ref<Verification | null>
}
export function useReviewDecisions(context: Context) {
  const {
    store,
    active,
    job,
    busy,
    fileTrashState,
    fieldsBusy,
    fieldsUncertain,
    fieldEditsPending,
    previewChanged,
    error,
    message,
    navigation,
    policy,
    manual,
    manualActions,
    requestedJob,
    inInbox,
    verification
  } = context
  const { reviews, selected } = store
  function actionBlocked(operation: DecisionOperation) {
    return (
      !active.value ||
      !job.value ||
      busy.value ||
      fileTrashState.value.busy ||
      fileTrashState.value.uncertain ||
      fieldsBusy.value ||
      (['approve', 'apply', 'file'].includes(operation) && fieldsUncertain.value) ||
      (['approve', 'file'].includes(operation) && (fieldEditsPending.value || previewChanged.value))
    )
  }
  async function refreshResult(
    id: string,
    resourceId: string,
    operation: DecisionOperation,
    result: DecisionResult
  ) {
    await store.refresh()
    if (requestedJob.value || !store.jobs.value.some((value) => value.id === id))
      await store.openJob(id)
    else {
      const index = reviews.value.findIndex((r) => r.bundle.source.resourceId === resourceId)
      if (index >= 0) selected.value = index
    }
    if (operation === 'reconcile' && result.state === 'done' && result.verification) {
      if ((result.verification.originalResourceId ?? result.verification.resourceId) !== resourceId)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Verification identity did not match this document'
        )
      verification.value = { ...result.verification, tags: result.tags }
    }
  }
  async function decide(operation: 'approve' | 'reject' | 'apply' | 'reconcile' | 'file') {
    if (!active.value || !job.value || actionBlocked(operation)) return
    busy.value = true
    error.value = ''
    message.value = ''
    const resourceId = active.value.bundle.source.resourceId,
      before = navigation.snapshot()
    let advance = false
    try {
      const id = job.value.id,
        payload = ['approve', 'file'].includes(operation)
          ? {
              id,
              policy: JSON.parse(JSON.stringify(policy.value)),
              reviewDigest: await reviewDigest(active.value, policy.value, manualActions()),
              ...(manual.value ? { manualActions: manualActions() } : {})
            }
          : { id }
      let result
      if (operation === 'file') {
        await store.request('approve', payload)
        result = await store.request('apply', { id })
      } else result = await store.request(operation, payload)
      await refreshResult(id, resourceId, operation, result)
      advance =
        inInbox.value &&
        !result.uncertain &&
        ((['file', 'apply'].includes(operation) && result.state === 'done') ||
          (operation === 'reject' && result.state === 'rejected'))
      message.value = result.uncertain
        ? 'Outcome needs verification'
        : operation === 'reject'
          ? 'Rejected'
          : operation === 'reconcile' && result.state === 'done'
            ? 'Verified'
            : result.state === 'done'
              ? ''
              : displayStatus(result.state)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Operation held'
      try {
        await store.refresh()
        if (requestedJob.value) await store.openJob(requestedJob.value)
      } catch {
        /* Keep the original operation error visible if the read-only refresh also fails. */
      }
    } finally {
      busy.value = false
    }
    if (advance) await navigation.advance(before, resourceId)
  }
  async function takeOver() {
    if (!job.value || busy.value) return
    busy.value = true
    error.value = ''
    try {
      const id = job.value.id
      await store.request('automation-takeover', {
        id,
        reviewDigest: job.value.approval?.reviewDigest
      })
      await store.openJob(id)
      message.value = ''
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Takeover held'
    } finally {
      busy.value = false
    }
  }
  async function exportApproval() {
    if (!active.value || busy.value) return
    busy.value = true
    error.value = ''
    message.value = ''
    try {
      const approval = await createApproval(active.value, policy.value, manualActions())
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(approval, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'document-review-approval.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      message.value =
        'Approval record downloaded. OpenCloud has not been changed. A connected worker must recheck identity, bytes, ETag and permissions before applying it.'
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not export approval'
    } finally {
      busy.value = false
    }
  }

  return { decide, takeOver, exportApproval }
}
