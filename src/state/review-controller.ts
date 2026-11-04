// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../domain/errors'
import { useReviewDecisions } from './review-decisions'
import { useDocumentProcessing } from './document-processing'
import { useRetryMonitor } from './retry-monitor'
import { useInboxNavigation } from './inbox-navigation'
import { useLocale } from './locale'
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue'
import { useWorkspace } from './workspace'
import { useVerifiedPreview } from './verified-preview'
import { useFilingDraft } from './filing-draft'
import { useRoute, useRouter } from './navigation'
export type ReviewInboxProps = { collection?: 'inbox' | 'documents' }
export function useReviewController(props: ReviewInboxProps) {
  const store = useWorkspace(),
    { t, formatDate } = useLocale()
  const route = useRoute(),
    router = useRouter(),
    requestedJob = computed(() =>
      typeof route.value.query.job === 'string' ? route.value.query.job : undefined
    )
  const collectionPath = () =>
    props.collection === 'documents' ||
    ['filed', 'history'].includes(String(route.value.query.from))
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
      if (result.uncertain) throw new WorkflowError('OPERATION_HELD', result.error)
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
        throw new WorkflowError('OPERATION_HELD', 'The document location could not be verified')
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
        ? JSON.stringify([
            connection.value.server,
            connection.value.account,
            connection.value.space
          ])
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
  const {
    manual,
    manualTarget,
    manualTags,
    manualActions,
    planned,
    filingProblem,
    editActions,
    resetActions,
    chooseManualTarget
  } = useFilingDraft({ store, active, job, policy, busy, error })

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
  const decisionBlocked = computed(
    () =>
      busy.value ||
      processing.active.value ||
      fileTrashState.value.busy ||
      fileTrashState.value.uncertain ||
      fieldsBusy.value
  )
  const acceptDisabled = computed(
    () =>
      decisionBlocked.value ||
      fieldsUncertain.value ||
      fieldEditsPending.value ||
      previewChanged.value ||
      !planned.value ||
      checkingDestination.value ||
      destinationBlocked.value ||
      (!planned.value.targetSpace &&
        planned.value.target === active.value?.bundle.source.path &&
        !planned.value.addTags.length)
  )
  const { decide, takeOver, exportApproval } = useReviewDecisions({
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
  })

  return {
    store,
    t,
    formatDate,
    route,
    collectionPath,
    verification,
    policy,
    connection,
    screen,
    fieldsBusy,
    fieldsUncertain,
    fieldState,
    addSuggestedTag,
    setReviewTags,
    reformatPDF,
    freshCloudConsent,
    preparingFresh,
    prepareFresh,
    fileTrashState,
    fileTrashed,
    error,
    message,
    busy,
    active,
    fieldEditsPending,
    job,
    processing,
    currentProcessingIssue,
    manual,
    manualTarget,
    manualTags,
    planned,
    filingProblem,
    editActions,
    resetActions,
    destinationBlocked,
    preview,
    previewLoading,
    previewError,
    previewChanged,
    resolvedTags,
    documentSpace,
    documentPath,
    inInbox,
    navigation,
    retryProcessing,
    loadPreview,
    decisionBlocked,
    acceptDisabled,
    decide,
    takeOver,
    exportApproval,
    chooseManualTarget
  }
}
