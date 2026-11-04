<script setup lang="ts">
import DocumentProcessingStatus from '../components/DocumentProcessingStatus.vue'
import { useDocumentProcessing } from '../state/document-processing'
import DestinationPicker from '../components/DestinationPicker.vue'
import DocumentTrashButton from '../components/DocumentTrashButton.vue'
// SPDX-License-Identifier: AGPL-3.0-only
import { useRetryMonitor } from '../state/retry-monitor'
import ProcessingIssue from '../components/ProcessingIssue.vue'
import PreparationReview from '../components/PreparationReview.vue'
import { useInboxNavigation } from '../state/inbox-navigation'
import { useLocale } from '../state/locale'
import { computed, ref, watch, onBeforeUnmount, onMounted, defineAsyncComponent } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useVerifiedPreview } from '../state/verified-preview'
import { statusLabel as displayStatus } from '../domain/status'
import { actions, createApproval, reviewDigest, validateManualActions } from '../domain/review'
import { useRoute, useRouter } from '../state/navigation'
const props = defineProps<{ collection?: 'inbox' | 'documents' }>()
const store = useWorkspace(),
  { t, formatDate } = useLocale()
const route = useRoute(),
  router = useRouter(),
  requestedJob = computed(() =>
    typeof route.value.query.job === 'string' ? route.value.query.job : undefined
  )
const collectionPath = () =>
  props.collection === 'documents' || ['filed', 'history'].includes(String(route.value.query.from))
    ? '/document-workflow/documents'
    : '/document-workflow/inbox'
const verification = ref<{
  checkedAt: string
  resourceId: string
  sha256: string
  tags: string[]
} | null>(null)
const { reviews, selected, policy, connection } = store
const screen = ref<HTMLElement | null>(null)
watch(selected, () => {
  screen.value?.closest('.dw-content')?.scrollTo?.({ top: 0 })
})
const fieldsDirty = ref(false),
  fieldsBusy = ref(false),
  fieldsUncertain = ref(false)
const ReviewFields = defineAsyncComponent(() => import('../components/ReviewFields.vue'))
function fieldState(value: {
  resourceId: string
  dirty: boolean
  busy: boolean
  uncertain?: boolean
}) {
  if (value.resourceId === active.value?.bundle.source.resourceId) {
    fieldsDirty.value = value.dirty
    fieldsBusy.value = value.busy
    fieldsUncertain.value = value.uncertain === true
  }
}
function addSuggestedTag(tag: string) {
  if (busy.value || job.value?.decision) return
  if (!manual.value) editActions()
  manualTags.value = [
    ...new Set([
      ...manualTags.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      tag
    ])
  ].join(', ')
}
function setReviewTags(value: string) {
  if (
    busy.value ||
    fieldsBusy.value ||
    fieldsUncertain.value ||
    job.value?.decision ||
    policy.value.tags === 'off'
  )
    return
  if (!manual.value) editActions()
  manualTags.value = value
}
async function reformatPDF() {
  if (!job.value?.conversion || !active.value || busy.value || fieldEditsPending.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await store.request('conversion-reformat', {
      id: job.value.conversion.conversionId
    })
    if (result.uncertain) throw new Error(result.error)
    await router.push({
      path: '/document-workflow/details',
      query: { path: result.path, return: 'inbox' }
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'PDF recreation held'
  } finally {
    busy.value = false
  }
}
const freshCloudConsent = ref(false),
  preparingFresh = ref(false)
async function prepareFresh() {
  if (
    !active.value ||
    busy.value ||
    fileTrashState.value.busy ||
    fileTrashState.value.uncertain ||
    fieldsBusy.value ||
    fieldsUncertain.value ||
    fieldEditsPending.value
  )
    return
  busy.value = true
  preparingFresh.value = true
  error.value = ''
  message.value = ''
  try {
    const location = job.value
      ? await store.request('document-location', { id: job.value.id })
      : active.value.bundle.source
    if (
      typeof location.path !== 'string' ||
      typeof location.resourceId !== 'string' ||
      typeof location.etag !== 'string'
    )
      throw new Error('The document location could not be verified')
    const result =
      active.value.bundle.manualReview?.reason === 'original'
        ? await store.request('prepare-original', {
            path: location.path,
            resourceId: location.resourceId,
            etag: location.etag,
            documentSpace: location.space ?? active.value.bundle.source.space
          })
        : await store.prepareDocument(location.path, {
            newReview: true,
            retry: true,
            resourceId: location.resourceId,
            etag: location.etag,
            cloudConsent: freshCloudConsent.value,
            ...(location.space && location.space !== connection.value?.space
              ? { documentSpace: location.space }
              : {})
          })
    if (requestedJob.value)
      await router.push({
        path: collectionPath(),
        query: {
          job: result.id,
          ...(collectionPath() === '/document-workflow/documents' ? { from: 'filed' } : {})
        }
      })
    message.value = 'Ready to review'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Preparation held'
  } finally {
    busy.value = false
    preparingFresh.value = false
  }
}
const fileTrashState = ref({ busy: false, uncertain: false })
async function fileTrashed() {
  const before = navigation.snapshot(),
    resource = active.value?.bundle.source.resourceId
  fileTrashState.value = { busy: false, uncertain: false }
  await store.refresh()
  if (inInbox.value && resource) await navigation.advance(before, resource)
  else await router.push('/document-workflow/documents')
}
const error = ref('')
const message = ref('')
const busy = ref(false)
const active = computed(() => {
  const review = reviews.value[selected.value]
  return review && (!requestedJob.value || store.jobFor(review)?.id === requestedJob.value)
    ? review
    : undefined
})
const pendingFieldDraft = computed(
  () =>
    !!active.value &&
    !!store.fieldDrafts.value[
      JSON.stringify([active.value.bundle.source.resourceId, active.value.bundle.source.sha256])
    ]
)
const fieldEditsPending = computed(() => fieldsDirty.value || pendingFieldDraft.value)
const job = computed(() => (active.value ? store.jobFor(active.value) : undefined))
const processing = useDocumentProcessing({
  source: computed(() =>
    job.value?.decision === 'done' ? undefined : active.value?.bundle.source
  ),
  scope: computed(() =>
    connection.value
      ? JSON.stringify([connection.value.server, connection.value.account, connection.value.space])
      : ''
  ),
  request: (source) =>
    store.request('document-processing', {
      path: source.path,
      resourceId: source.resourceId,
      etag: source.etag,
      ...(source.space ? { documentSpace: source.space } : {})
    })
})
const currentProcessingIssue = computed(() =>
  preparingFresh.value || processing.active.value
    ? null
    : processing.status.value
      ? processing.status.value.processingIssue
      : job.value?.processingIssue
)
const queuedIndices = computed(() =>
  reviews.value
    .map((_, index) => index)
    .filter((index) => store.jobFor(reviews.value[index]!)?.decision !== 'done')
)
const manual = ref(false),
  manualTarget = ref(''),
  manualTags = ref(''),
  manualNeedsDestination = ref(false)
function manualActions() {
  if (!manual.value) return
  if (manualNeedsDestination.value) throw new Error('Choose a destination before filing.')
  return validateManualActions(
    {
      target: manualTarget.value,
      addTags: manualTags.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    },
    active.value?.bundle.manualReview?.reason === 'original'
      ? active.value.bundle.source.path
      : undefined
  )
}
const planning = computed(() => {
  if (job.value?.approval?.actions) return { actions: job.value.approval.actions, error: '' }
  if (!active.value || (active.value.bundle.manualReview && !manualTarget.value.trim()))
    return { actions: null, error: '' }
  try {
    return { actions: actions(active.value, policy.value, manualActions()), error: '' }
  } catch (e) {
    return { actions: null, error: e instanceof Error ? e.message : 'Filing needs attention' }
  }
})
const planned = computed(() => planning.value.actions),
  filingProblem = computed(() => planning.value.error)
function editActions() {
  if (busy.value || job.value?.decision || !active.value) return
  let current
  try {
    current = actions(active.value, policy.value)
    manualNeedsDestination.value = false
  } catch (e) {
    try {
      const existing = actions(active.value, { ...policy.value, move: 'off' })
      if (!existing || !active.value.proposal) return
      const base = active.value.bundle.rules?.root ?? 'Filed'
      current = validateManualActions({
        target:
          policy.value.move === 'off'
            ? existing.target
            : `${base}/${active.value.proposal.folder.value}/${existing.target.split('/').pop()}`,
        addTags: existing.addTags
      })
      manualNeedsDestination.value = true
    } catch {
      manual.value = true
      manualTarget.value = ''
      manualTags.value =
        policy.value.tags === 'off'
          ? ''
          : (active.value.proposal?.tags ?? []).map((tag) => tag.value).join(', ')
      manualNeedsDestination.value = true
      error.value = ''
      return
    }
  }
  if (current) {
    manualTarget.value = current.target
    manualTags.value = current.addTags.join(', ')
    manual.value = true
  }
}
watch(
  () => job.value?.id,
  (id) => {
    manual.value = false
    manualNeedsDestination.value = false
    const draft = id ? store.filingDrafts.value[id] : undefined
    manualTarget.value = draft?.target || ''
    manualTags.value = draft?.tags || ''
    manual.value = !!draft || (!!active.value?.bundle.manualReview && !job.value?.decision)
    manualNeedsDestination.value = !!active.value?.bundle.manualReview && !draft?.target
  },
  { immediate: true }
)
watch([manualTarget, manualTags, manual, manualNeedsDestination], () => {
  const id = job.value?.id
  if (id && manual.value && !manualNeedsDestination.value && !job.value?.decision)
    store.filingDrafts.value[id] = { target: manualTarget.value, tags: manualTags.value }
})
function resetActions() {
  manual.value = false
  manualNeedsDestination.value = false
  if (job.value) delete store.filingDrafts.value[job.value.id]
}
watch(
  () => job.value?.decision,
  (decision) => {
    if (decision) {
      manual.value = false
      if (job.value) delete store.filingDrafts.value[job.value.id]
    }
  },
  { immediate: true }
)
const PdfPreview = defineAsyncComponent(() => import('../components/PdfPreview.vue'))
const destinationBlocked = ref(false),
  checkingDestination = ref(false)
let destinationGeneration = 0
watch(
  () =>
    JSON.stringify([
      planned.value?.target,
      job.value?.id,
      job.value?.decision,
      connection.value?.account
    ]),
  async () => {
    const version = ++destinationGeneration
    destinationBlocked.value = false
    checkingDestination.value = false
    const target = planned.value?.target
    if (
      !connection.value ||
      !job.value ||
      job.value.decision ||
      !target ||
      target === active.value?.bundle.source.path
    )
      return
    checkingDestination.value = true
    try {
      const result = await store.request('files', {
        path: target.split('/').slice(0, -1).join('/'),
        ...(planned.value?.targetSpace ? { documentSpace: planned.value.targetSpace } : {})
      })
      if (version === destinationGeneration)
        destinationBlocked.value = result.files.some((f: { path: string }) => f.path === target)
    } catch {
      /* Missing folders and unavailable listings are rechecked by the filing worker. */
    } finally {
      if (version === destinationGeneration) checkingDestination.value = false
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  destinationGeneration++
})
const verifiedPreview = useVerifiedPreview()
const {
  data: preview,
  busy: previewLoading,
  error: previewError,
  changed: previewChanged
} = verifiedPreview
const resolvedPath = ref<string | null>(null),
  resolvedSpace = ref<string | null>(null),
  resolvedTags = ref<string[] | null>(null)
const usesFilingTarget = computed(() =>
  ['done', 'move_done', 'tags_intent', 'transfer_ready'].includes(job.value?.decision || '')
)
const documentSpace = computed(
  () =>
    resolvedSpace.value ??
    (usesFilingTarget.value
      ? (planned.value?.targetSpace ?? active.value?.bundle.source.space)
      : active.value?.bundle.source.space)
)
const documentPath = computed(
  () =>
    resolvedPath.value ??
    (usesFilingTarget.value ? planned.value?.target : active.value?.bundle.source.path)
)
const inInbox = computed(() => collectionPath().endsWith('/inbox'))
const navigation = useInboxNavigation(
  computed(() => active.value?.bundle.source.resourceId),
  computed(() => busy.value || fieldsBusy.value)
)
watch(
  () => active.value?.bundle.source.resourceId,
  () => {
    fieldsDirty.value = false
    fieldsBusy.value = false
    fieldsUncertain.value = false
    verification.value = null
    message.value = ''
    error.value = ''
  }
)
const retryMonitor = useRetryMonitor({
  key: computed(() =>
    JSON.stringify([
      active.value?.bundle.source.resourceId,
      active.value?.bundle.source.etag,
      connection.value?.account,
      connection.value?.space
    ])
  ),
  blocked: () => busy.value || fieldsBusy.value || fieldEditsPending.value,
  request: (id) => store.request('intake-item', { id }),
  issue: (issue) => {
    if (job.value) job.value.processingIssue = issue
    if (issue) message.value = ''
  },
  ready: async (id) => {
    message.value = ''
    await router.replace({ path: collectionPath(), query: { ...route.value.query, job: id } })
  }
})
async function retryProcessing() {
  if (
    !job.value?.processingIssue?.queueId ||
    busy.value ||
    fieldsBusy.value ||
    fieldEditsPending.value
  )
    return
  busy.value = true
  error.value = ''
  const current = job.value,
    queueId = current.processingIssue!.queueId!
  try {
    const result = await store.request('intake-control', { action: 'retry', ids: [queueId] })
    if (result.affected && job.value?.id === current.id) {
      job.value.processingIssue = null
      retryMonitor.start(queueId, current.source)
    }
    message.value = 'Queued for retry'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Preparation held'
  } finally {
    busy.value = false
  }
}
async function refreshReviews() {
  if (!connection.value || busy.value) return
  busy.value = true
  const resource = active.value?.bundle.source.resourceId
  try {
    if (requestedJob.value) {
      await store.openJob(requestedJob.value)
    } else {
      await store.refresh()
      const index = reviews.value.findIndex(
        (r) => r.bundle.source.resourceId === resource && store.jobFor(r)?.decision !== 'done'
      )
      selected.value = index >= 0 ? index : (queuedIndices.value[0] ?? -1)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Review refresh failed'
  } finally {
    busy.value = false
  }
}
onMounted(async (): Promise<void> => {
  try {
    if (requestedJob.value && !connection.value) await store.connect()
    await refreshReviews()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not open the saved document'
  }
})
watch(requestedJob, () => void refreshReviews())
watch(
  () => connection.value?.account,
  () => {
    if (requestedJob.value && !busy.value) void refreshReviews()
  }
)
watch(selected, () => {
  verification.value = null
})
async function loadPreview() {
  verifiedPreview.reset()
  resolvedPath.value = null
  resolvedSpace.value = null
  resolvedTags.value = null
  if (!active.value || !connection.value) return
  const bundle = active.value.bundle
  await verifiedPreview.load(
    bundle.source.sha256,
    async (current) => {
      const location =
        job.value && ['done', 'conflict'].includes(job.value.decision || '')
          ? await store.request('document-location', { id: job.value.id })
          : null
      if (!current()) return null
      const path = location?.path ?? documentPath.value
      if (location) {
        resolvedSpace.value = location.space
        resolvedTags.value = Array.isArray(location.tags) ? location.tags : null
      }
      resolvedPath.value = path
      if (bundle.manualReview?.reason === 'original') return null
      return store.request('preview', {
        path,
        ...(documentSpace.value && documentSpace.value !== connection.value?.space
          ? { documentSpace: documentSpace.value }
          : {})
      })
    },
    {
      changed:
        'This PDF changed after the suggestion was prepared. Prepare a fresh suggestion to review its current contents.',
      failed: 'Preview failed'
    }
  )
}
watch(
  () =>
    JSON.stringify([active.value?.bundle.source, job.value?.decision, connection.value?.account]),
  () => {
    void loadPreview()
  },
  { immediate: true }
)
async function decide(operation: 'approve' | 'reject' | 'apply' | 'reconcile' | 'file') {
  if (
    !active.value ||
    !job.value ||
    busy.value ||
    fileTrashState.value.busy ||
    fileTrashState.value.uncertain ||
    fieldsBusy.value ||
    (['approve', 'apply', 'file'].includes(operation) && fieldsUncertain.value) ||
    (['approve', 'file'].includes(operation) && (fieldEditsPending.value || previewChanged.value))
  )
    return
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
    await store.refresh()
    if (requestedJob.value || !store.jobs.value.some((value) => value.id === id))
      await store.openJob(id)
    else {
      const index = reviews.value.findIndex((r) => r.bundle.source.resourceId === resourceId)
      if (index >= 0) selected.value = index
    }
    if (operation === 'reconcile' && result.state === 'done' && result.verification) {
      if ((result.verification.originalResourceId ?? result.verification.resourceId) !== resourceId)
        throw new Error('Verification identity did not match this document')
      verification.value = { ...result.verification, tags: result.tags }
    }
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
function chooseManualTarget(target: string) {
  manualTarget.value = target
  manualNeedsDestination.value = false
}
</script>

<template>
  <main ref="screen" class="workflow screen">
    <header class="screen-heading editor-heading">
      <nav v-if="inInbox" class="inbox-navigation" :aria-label="t('Document navigation')">
        <RouterLink
          class="button subtle"
          to="/document-workflow/inbox"
          :aria-label="t('Back to inbox')"
          >{{ t('Inbox') }}</RouterLink
        ><button
          class="icon-button"
          :disabled="!navigation.canPrevious.value"
          :aria-label="t('Previous document')"
          :title="t('Previous document')"
          @click="navigation.move(-1)"
        >
          ‹</button
        ><span v-if="navigation.position.value"
          >{{ navigation.position.value }} / {{ navigation.total.value }}</span
        ><button
          class="icon-button"
          :disabled="!navigation.canNext.value"
          :aria-label="t('Next document')"
          :title="t('Next document')"
          @click="navigation.move(1)"
        >
          ›
        </button>
      </nav>
      <RouterLink
        v-else
        class="icon-button"
        :to="
          route.query.from === 'history'
            ? { path: '/document-workflow/activity', query: { view: 'filing' } }
            : collectionPath()
        "
        :aria-label="
          t(
            route.query.from === 'history'
              ? 'Back to filing history'
              : collectionPath().endsWith('/documents')
                ? 'Back to documents'
                : 'Back to inbox'
          )
        "
        >←</RouterLink
      >
      <h1 :title="documentPath?.split('/').pop()">
        {{ documentPath?.split('/').pop() || t('Document') }}
      </h1>
      <span v-if="job?.decision === 'done'" class="pill">{{ t('Filed') }}</span
      ><button
        v-if="
          active &&
          job &&
          (active.bundle.manualReview?.reason !== 'original' || !!job.decision) &&
          (!job.decision || ['done', 'rejected', 'conflict'].includes(job.decision)) &&
          !['pending', 'running'].includes(job.automation?.state || '')
        "
        class="button"
        :disabled="
          busy ||
          processing.active.value ||
          fileTrashState.busy ||
          fileTrashState.uncertain ||
          fieldsBusy ||
          fieldsUncertain ||
          fieldEditsPending
        "
        :aria-busy="preparingFresh"
        @click="prepareFresh"
      >
        {{
          t(
            preparingFresh
              ? 'Reprocessing…'
              : active.bundle.manualReview?.reason === 'original'
                ? 'New filing review'
                : 'Reprocess'
          )
        }}</button
      ><DocumentTrashButton
        v-if="
          active &&
          !job?.potentialDuplicates?.length &&
          job &&
          (!job.decision || ['done', 'rejected', 'conflict'].includes(job.decision))
        "
        :path="documentPath || active.bundle.source.path"
        :document-space="documentSpace"
        :job="job.id"
        :sha256="active.bundle.source.sha256"
        :disabled="busy || processing.active.value || fieldsBusy || fieldEditsPending"
        @state="fileTrashState = $event"
        @trashed="fileTrashed"
      />
    </header>
    <label
      v-if="
        active && active.bundle.manualReview?.reason !== 'original' && store.cloudProcessing.value
      "
      class="check-label"
      ><input v-model="freshCloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label
    >
    <DocumentProcessingStatus
      :status="processing.status.value"
      :unavailable="processing.unavailable.value"
      :preparing="preparingFresh"
      :current-job="job?.id"
    />
    <ProcessingIssue
      v-if="currentProcessingIssue"
      :issue="currentProcessingIssue"
      :busy="busy || fieldsBusy || fieldEditsPending"
      @retry="retryProcessing"
    />
    <p v-if="error || navigation.error.value" role="alert" class="error">
      {{ t(error || navigation.error.value) }}
    </p>
    <p v-if="message" role="status" class="message">{{ t(message) }}</p>
    <template v-if="active">
      <div class="review-layout">
        <section class="source-panel panel" :aria-label="t('Original document')">
          <p v-if="previewLoading" role="status">{{ t('Loading…') }}</p>
          <div
            v-if="active.bundle.manualReview?.reason === 'original'"
            class="original-file-preview"
          >
            <p>{{ t('Preview is unavailable for this format.') }}</p>
            <RouterLink
              v-if="
                store.fileLocation(
                  documentSpace || active.bundle.source.space,
                  documentPath || active.bundle.source.path
                )
              "
              class="button"
              :to="
                store.fileLocation(
                  documentSpace || active.bundle.source.space,
                  documentPath || active.bundle.source.path
                )!
              "
              >{{ t('Open location in OpenCloud') }}</RouterLink
            >
          </div>
          <PdfPreview
            v-else-if="preview"
            :data="preview"
            :filename="documentPath?.split('/').pop()"
          />
          <div v-else-if="!previewLoading" class="preview-placeholder">
            <p>{{ t(previewError || 'Preview unavailable') }}</p>
            <button class="button" @click="loadPreview">{{ t('Retry') }}</button>
          </div>
        </section>
        <section class="review-plan panel" :aria-label="t('Document details')">
          <section v-if="job?.potentialDuplicates?.length" class="review-step potential-duplicate">
            <h2>{{ t('Potential duplicate') }}</h2>
            <p>{{ t('Matching identifiers and printed dates. Compare before filing.') }}</p>
            <ul>
              <li v-for="match in job.potentialDuplicates" :key="match.id">
                <RouterLink
                  :to="{ path: '/document-workflow/inbox', query: { job: match.id } }"
                  target="_blank"
                  rel="noopener"
                  >{{
                    t('Compare with {name}', { name: match.path.split('/').pop() || match.path })
                  }}</RouterLink
                >
              </li>
            </ul>
            <DocumentTrashButton
              label="Move this copy to Trash"
              v-if="
                job && (!job.decision || ['done', 'rejected', 'conflict'].includes(job.decision))
              "
              :path="documentPath || active.bundle.source.path"
              :document-space="documentSpace"
              :job="job.id"
              :sha256="active.bundle.source.sha256"
              :disabled="busy || processing.active.value || fieldsBusy || fieldEditsPending"
              @state="fileTrashState = $event"
              @trashed="fileTrashed"
            />
          </section>
          <template v-if="active.proposal || active.bundle.manualReview">
            <section v-if="active.bundle.manualReview" class="review-step">
              <div class="step-heading review-retry-heading">
                <h2>{{ t('Manual review') }}</h2>
              </div>
              <p v-if="!preparingFresh && !job?.preparationReview">
                {{
                  t(
                    active.bundle.manualReview.reason === 'original'
                      ? 'Choose a folder and filename. The original file format is kept.'
                      : active.bundle.manualReview.reason === 'rules'
                        ? 'OCR and extraction rules are ready. Choose the filing details yourself.'
                        : active.bundle.manualReview.reason === 'text'
                          ? 'Some pages could not be read automatically. Choose the filing details yourself.'
                          : active.bundle.manualReview.reason === 'capacity'
                            ? 'This document exceeds the model capacity. Choose the filing details yourself.'
                            : active.bundle.manualReview.reason === 'date'
                              ? 'The printed date needs review. Choose the filing details yourself.'
                              : 'The AI details could not be verified. Choose the filing details yourself.'
                  )
                }}
              </p>
              <PreparationReview
                v-if="!preparingFresh && job?.preparationReview"
                :report="job.preparationReview"
              /><template v-if="job && !job.decision"></template>
            </section>
            <section v-if="active.proposal" class="review-step">
              <dl class="facts">
                <template v-for="key in ['issuer', 'date', 'kind'] as const" :key="key"
                  ><dt>{{ t(key === 'issuer' ? 'Sender' : key === 'date' ? 'Date' : 'Type') }}</dt>
                  <dd>{{ active.proposal[key].value }}</dd></template
                >
              </dl>
              <details class="evidence">
                <summary>{{ t('Evidence') }}</summary>
                <div
                  v-for="key in ['issuer', 'date', 'kind', 'folder'] as const"
                  :key="key"
                  class="claim"
                >
                  <strong>{{
                    t(
                      key === 'issuer'
                        ? 'Sender'
                        : key === 'date'
                          ? 'Date'
                          : key === 'kind'
                            ? 'Type'
                            : 'Category'
                    )
                  }}</strong>
                  <blockquote v-for="(item, index) in active.proposal[key].evidence" :key="index">
                    {{ item.quote }} <small>{{ t('Page {number}', { number: item.page }) }}</small>
                  </blockquote>
                </div>
              </details>
            </section>
            <section class="review-step">
              <div class="step-heading">
                <h2>{{ t('Filing') }}</h2>
                <button
                  v-if="job && !job.decision && !active.bundle.manualReview"
                  class="icon-button"
                  :disabled="
                    busy ||
                    processing.active.value ||
                    fileTrashState.busy ||
                    fileTrashState.uncertain ||
                    fieldsBusy
                  "
                  :aria-label="t(manual ? 'Use suggestions' : 'Edit filing')"
                  :title="t(manual ? 'Use suggestions' : 'Edit filing')"
                  @click="manual ? resetActions() : editActions()"
                >
                  {{ manual ? '↶' : '✎' }}
                </button>
              </div>
              <template v-if="manual"
                ><label for="manual-target">{{ t('Folder and filename') }}</label
                ><DestinationPicker
                  :key="job?.id || active.bundle.source.resourceId"
                  :model-value="manualTarget"
                  :root="active.bundle.rules?.root || 'Filed'"
                  :space="
                    planned?.targetSpace ||
                    active.bundle.destinationSpace ||
                    active.bundle.source.space
                  "
                  :filename="active.bundle.source.path.split('/').pop()!"
                  :disabled="
                    busy ||
                    processing.active.value ||
                    fileTrashState.busy ||
                    fileTrashState.uncertain ||
                    fieldsBusy
                  "
                  @update:model-value="chooseManualTarget($event)"
              /></template>
              <dl v-else-if="planned" class="filing suggested-destination">
                <dt>{{ t(job?.decision === 'done' ? 'Filename' : 'Suggested filename') }}</dt>
                <dd class="suggested-filename">
                  {{ (job?.decision === 'done' ? documentPath : planned.target)?.split('/').pop() }}
                </dd>
                <dt>{{ t(job?.decision === 'done' ? 'Folder' : 'Suggested folder') }}</dt>
                <dd class="target">
                  <span v-if="planned.targetSpace"
                    >{{
                      store.spaces.value.find((space) => space.id === planned.targetSpace)?.name ||
                      planned.targetSpace
                    }}
                    / </span
                  >{{
                    (job?.decision === 'done' ? documentPath : planned.target)
                      ?.split('/')
                      .slice(0, -1)
                      .join('/')
                  }}
                </dd>
              </dl>
              <p v-if="filingProblem" role="alert" class="error">{{ t(filingProblem) }}</p>
              <p v-if="destinationBlocked" class="error">{{ t('Destination already exists') }}</p>
              <p v-if="active.ruleAmbiguous" class="error">{{ t('Several filing rules match') }}</p>
              <RouterLink
                v-if="job?.decision === 'done' && documentPath"
                class="button subtle"
                :to="{
                  path: '/document-workflow/details',
                  query: { path: documentPath, return: 'filed', job: job.id, space: documentSpace }
                }"
                >{{ t('Edit details') }}</RouterLink
              >
            </section>
            <ReviewFields
              v-if="connection && job?.decision !== 'done'"
              :key="active.bundle.source.resourceId + active.bundle.source.sha256"
              :path="documentPath || active.bundle.source.path"
              :document-space="documentSpace"
              :resource-id="active.bundle.source.resourceId"
              :sha256="active.bundle.source.sha256"
              :editable-tags="!job?.decision && policy.tags !== 'off'"
              :selected-tags="
                manual
                  ? manualTags
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                  : (planned?.addTags ?? [])
              "
              :tag-options="(active.bundle.rules?.tags ?? []).map((tag) => tag.value)"
              :tag-evidence="active.proposal?.tags"
              :new-tags="
                active.bundle.tagDiscovery?.mode === 'create'
                  ? (active.proposal?.tags ?? [])
                      .map((tag) => tag.value)
                      .filter((tag) => !active.bundle.tagDiscovery!.catalog.includes(tag))
                  : []
              "
              :locked="
                busy ||
                fileTrashState.busy ||
                fileTrashState.uncertain ||
                [
                  'approved',
                  'folders_pending',
                  'move_intent',
                  'move_done',
                  'tags_intent',
                  'copy_intent',
                  'transfer_ready'
                ].includes(job?.decision || '')
              "
              @state="fieldState"
              @tag="addSuggestedTag"
              @tags="setReviewTags"
            />
            <section v-else class="review-step">
              <h2>{{ t('Tags') }}</h2>
              <span v-for="tag in resolvedTags ?? planned?.addTags ?? []" :key="tag" class="tag">{{
                tag
              }}</span>
            </section>
            <section class="decision-actions">
              <p v-if="job?.automation?.state === 'held'" class="error">
                {{ t(job.automation.detail || 'Needs attention') }}
              </p>
              <template v-if="job"
                ><template v-if="job.automation?.state === 'done' && !job.decision"
                  ><span class="pill">{{ t('Processed') }}</span></template
                ><template v-else-if="!job.decision"
                  ><p v-if="previewChanged" class="error">{{ t('Document changed') }}</p>
                  <p v-if="fieldEditsPending" class="error">
                    {{ t('Save field changes before filing') }}
                  </p>
                  <div class="action-buttons">
                    <button
                      class="button primary"
                      :disabled="
                        busy ||
                        processing.active.value ||
                        fileTrashState.busy ||
                        fileTrashState.uncertain ||
                        fieldsBusy ||
                        fieldsUncertain ||
                        fieldEditsPending ||
                        previewChanged ||
                        !planned ||
                        checkingDestination ||
                        destinationBlocked ||
                        (!planned.targetSpace &&
                          planned.target === active.bundle.source.path &&
                          !planned.addTags.length)
                      "
                      @click="decide('file')"
                    >
                      {{ t(busy && !preparingFresh ? 'Saving…' : 'Accept') }}</button
                    ><button
                      class="button subtle"
                      :disabled="
                        busy ||
                        processing.active.value ||
                        fileTrashState.busy ||
                        fileTrashState.uncertain ||
                        fieldsBusy
                      "
                      @click="decide('reject')"
                    >
                      {{ t('Reject') }}
                    </button>
                  </div></template
                ><template
                  v-else-if="
                    ['approved', 'folders_pending', 'move_done', 'transfer_ready'].includes(
                      job.decision
                    )
                  "
                  ><button
                    v-if="job.approval?.automaticAuthorization"
                    class="button"
                    :disabled="
                      busy ||
                      processing.active.value ||
                      fileTrashState.busy ||
                      fileTrashState.uncertain ||
                      fieldsBusy
                    "
                    @click="takeOver"
                  >
                    {{ t('Take over') }}</button
                  ><button
                    v-else
                    class="button primary"
                    :disabled="
                      busy ||
                      processing.active.value ||
                      fileTrashState.busy ||
                      fileTrashState.uncertain ||
                      fieldsBusy ||
                      fieldsUncertain
                    "
                    @click="decide('apply')"
                  >
                    {{ t(busy ? 'Filing…' : 'Continue filing') }}
                  </button></template
                ><template
                  v-else-if="['move_intent', 'tags_intent', 'copy_intent'].includes(job.decision)"
                  ><button
                    class="button"
                    :disabled="
                      busy ||
                      processing.active.value ||
                      fileTrashState.busy ||
                      fileTrashState.uncertain ||
                      fieldsBusy
                    "
                    @click="decide('reconcile')"
                  >
                    {{ t('Verify outcome') }}
                  </button></template
                ><template v-else-if="job.decision === 'done'"
                  ><button
                    class="button"
                    :disabled="
                      busy ||
                      processing.active.value ||
                      fileTrashState.busy ||
                      fileTrashState.uncertain ||
                      fieldsBusy ||
                      fieldsUncertain
                    "
                    @click="decide('reconcile')"
                  >
                    {{ t('Verify file') }}
                  </button>
                  <details v-if="verification">
                    <summary>{{ t('Verification') }}</summary>
                    <p>{{ formatDate(verification.checkedAt) }}</p>
                    <dl class="filing">
                      <template v-if="job?.conversion"
                        ><dt>{{ t('Archived original') }}</dt>
                        <dd>{{ job.conversion.archivePath }}</dd></template
                      >
                      <dt>{{ t('Resource') }}</dt>
                      <dd>{{ verification.resourceId }}</dd>
                      <dt>SHA256</dt>
                      <dd>{{ verification.sha256 }}</dd>
                    </dl>
                  </details></template
                ><template v-else></template></template
              ><button v-else class="button" :disabled="busy || !planned" @click="exportApproval">
                {{ t('Export record') }}
              </button>
            </section>
            <details v-if="active.excluded.length" class="excluded">
              <summary>{{ t('Excluded tags') }}</summary>
              <p v-for="(tag, index) in active.excluded" :key="index">{{ tag.value }}</p>
            </details>
          </template>
          <section v-else-if="!job?.processingIssue && message !== 'Queued for retry'">
            <p>{{ t('Text recognition required') }}</p>
            <RouterLink class="text-link" to="/document-workflow/settings/automation">{{
              t('Processing settings')
            }}</RouterLink>
          </section>
          <details class="technical">
            <summary>{{ t('File information') }}</summary>
            <dl class="filing">
              <dt>{{ t('Original path') }}</dt>
              <dd>{{ active.bundle.source.path }}</dd>
              <template v-if="job?.conversion"
                ><dt>{{ t('Archived original') }}</dt>
                <dd>{{ job.conversion.archivePath }}</dd></template
              >
              <dt>{{ t('Resource') }}</dt>
              <dd>{{ active.bundle.source.resourceId }}</dd>
              <dt>SHA256</dt>
              <dd>{{ active.bundle.source.sha256 }}</dd>
            </dl>
            <template
              v-if="
                job?.conversion &&
                !job.decision &&
                /\.(xlsx|xls|ods)$/i.test(job.conversion.archivePath)
              "
              ><p>
                {{
                  t(
                    'Recreates the PDF with readable spreadsheet layout. Keeps the workbook and previous PDF.'
                  )
                }}
              </p>
              <button
                class="button"
                :disabled="
                  busy ||
                  processing.active.value ||
                  fileTrashState.busy ||
                  fileTrashState.uncertain ||
                  fieldsBusy ||
                  fieldEditsPending
                "
                @click="reformatPDF"
              >
                {{ t(busy ? 'Recreating PDF…' : 'Recreate PDF') }}
              </button></template
            >
            <article v-for="(page, index) in active.bundle.pages" :key="index">
              <h3>{{ t('Page {number}', { number: index + 1 }) }}</h3>
              <pre>{{ page }}</pre>
            </article>
            <p v-if="job?.approval?.automaticAuthorization">
              {{ t('Automatic') }} ·
              {{ formatDate(job.approval.automaticAuthorization.authorizedAt) }}
            </p>
          </details>
        </section>
      </div>
    </template>
    <p v-else-if="busy" role="status">{{ t('Loading…') }}</p>
  </main>
</template>
<style scoped>
.review-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.review-selector label {
  font-size: 12px;
  color: var(--muted);
}
.review-selector select {
  flex: 1;
  min-width: 160px;
}
.review-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 1fr);
  gap: 24px;
  align-items: start;
}
.source-panel {
  padding: 18px;
  position: sticky;
  top: 16px;
}
.source-heading,
.step-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.source-heading h2 {
  margin: 0;
}
.source-name {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.preview-placeholder {
  padding: 48px 12px;
  text-align: center;
}
.review-plan {
  min-width: 0;
  padding: 0 24px;
}
.review-step {
  padding: 22px 0;
  border-bottom: 1px solid var(--line);
}
.review-step h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 15px;
}
.step-number {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--subtle);
  color: var(--accent-text);
  font-size: 12px;
}
.review-step > p {
  font-size: 12px;
}
.facts,
.filing {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 10px;
  margin: 20px 0 12px;
  font-size: 13px;
}
dt {
  color: var(--muted);
  font-size: 12px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.facts dd {
  font-weight: 600;
}
.suggested-destination {
  grid-template-columns: 120px minmax(0, 1fr);
}
.suggested-filename {
  font-weight: 600;
}
.target {
  font-weight: 500;
  color: var(--accent-text);
}
.review-step label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin: 14px 0 6px;
}
.review-step input {
  width: 100%;
}
.text-link {
  display: inline-block;
  color: var(--accent-text);
  font-size: 12px;
  margin-top: 14px;
}
.fine-print {
  font-size: 11px !important;
}
.action-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.decision-actions > .button {
  margin-top: 16px;
}
.technical,
.excluded {
  padding: 14px 0;
}
summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  padding: 6px 0;
}
.evidence {
  margin-top: 12px;
}
.claim {
  margin: 12px 0;
  font-size: 12px;
}
.claim strong {
  text-transform: capitalize;
}
blockquote {
  margin: 6px 0 12px;
  border-left: 2px solid var(--line);
  padding-left: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
blockquote small {
  display: block;
  color: var(--muted);
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  background: var(--subtle);
  padding: 12px;
}
h3 {
  font-size: 13px;
  margin: 20px 0 8px;
}
@media (max-width: 1100px) {
  .review-layout {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 1fr);
    gap: 16px;
  }
  .review-plan {
    padding: 0 16px;
  }
  .review-selector .button {
    padding: 8px;
  }
}
@media (max-width: 850px) {
  .review-layout {
    grid-template-columns: 1fr;
  }
  .source-panel {
    position: static;
  }
  .review-selector select {
    flex-basis: 65%;
  }
  .facts,
  .filing {
    grid-template-columns: 85px minmax(0, 1fr);
  }
}
.potential-duplicate ul {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}
.potential-duplicate li + li {
  margin-top: 8px;
}
.potential-duplicate a {
  color: var(--accent-text);
  text-underline-offset: 3px;
}
.review-plan > .review-step.potential-duplicate:first-child {
  padding-top: 22px;
}
.review-retry-heading {
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.review-plan > .review-step:first-child:has(.review-retry-heading) {
  padding-top: 22px;
}
.review-retry-heading h2 {
  margin: 0;
}
.review-retry-heading .button {
  flex: none;
}
.editor-heading {
  justify-content: start;
  gap: 14px;
}
.editor-heading h1 {
  font-size: 20px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-heading .pill {
  margin-left: auto;
}
.source-panel {
  padding: 16px;
}
.review-plan > .review-step:first-child {
  padding-top: 0;
}
.review-plan .facts {
  margin-top: 0;
}
.decision-actions {
  padding: 18px 0;
}
.step-heading .icon-button {
  width: 30px;
  height: 30px;
  font-size: 17px;
}
@media (max-width: 700px) {
  .editor-heading h1 {
    font-size: 17px;
  }
}
</style>
