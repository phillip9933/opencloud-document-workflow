// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../domain/errors'
import { useMetadataActions } from './metadata-actions'
import { useDocumentProcessing } from './document-processing'
import { useRetryMonitor } from './retry-monitor'
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useInboxNavigation } from './inbox-navigation'
import { useLocale } from './locale'
import { useRoute, useRouter } from './navigation'
import { useWorkspace, withinInbox } from './workspace'
import type { DocumentDetail as Detail, MetadataMutationResult } from '../domain/document-details'
import { useVerifiedPreview } from './verified-preview'
export type DocumentDetailsProps = {
  embedded?: boolean
  path?: string
  space?: string
  folder?: string
  resourceId?: string
  etag?: string
}
export type DocumentDetailsEmit = {
  (
    event: 'changed',
    entry?: {
      path: string
      resourceId: string
      etag: string
      tags: string[]
      fields: Record<string, string | number>
    }
  ): void
  (event: 'state', value: { dirty: boolean; busy: boolean; uncertain: boolean }): void
}
export function useDocumentController(props: DocumentDetailsProps, emit: DocumentDetailsEmit) {
  const route = useRoute(),
    detailRoute = computed(() =>
      props.embedded
        ? {
            ...route.value,
            query: {
              path: props.path,
              space: props.space,
              folder: props.folder,
              return: 'library',
              job: undefined as string | undefined
            }
          }
        : route.value
    )
  const store = useWorkspace(),
    router = useRouter(),
    { t } = useLocale(),
    data = ref<Detail | null>(null),
    values = ref<Record<string, string | number>>({}),
    tags = ref(''),
    error = ref(''),
    message = ref(''),
    busy = ref(false),
    loading = ref(false),
    editing = ref(false),
    saveNeedsCheck = ref(false)
  const tagRemovalState = ref({ busy: false, uncertain: false })
  const preparing = ref(false),
    trashUncertain = ref(false),
    fileTrashState = ref({ busy: false, uncertain: false })
  const canTrash = computed(
    () =>
      props.embedded ||
      ['filed', 'library', 'inbox'].includes(String(detailRoute.value.query.return))
  )
  async function fileTrashed() {
    fileTrashState.value = { busy: false, uncertain: false }
    message.value = 'Moved to OpenCloud Trash'
    if (props.embedded) emit('changed')
    else await router.push('/document-workflow/documents')
  }
  const verifiedPreview = useVerifiedPreview()
  const { data: preview, busy: previewBusy, error: previewError } = verifiedPreview
  const previewOpen = ref(true)
  let generation = 0,
    alive = true
  const scope = () =>
    store.connection.value &&
    JSON.stringify([
      store.connection.value.server,
      store.connection.value.account,
      store.connection.value.space
    ])
  const savedValues = () =>
    Object.fromEntries(
      data.value?.schema.fields.map((field) => [
        field.id,
        data.value!.record.fields[field.id] ?? ''
      ]) ?? []
    )
  const dirty = computed(
    () => JSON.stringify(values.value) !== JSON.stringify(savedValues()) || !!tags.value.trim()
  )
  watch(
    [
      dirty,
      busy,
      loading,
      saveNeedsCheck,
      () => JSON.stringify(fileTrashState.value),
      () => data.value?.pending.length ?? 0,
      () => JSON.stringify(tagRemovalState.value)
    ],
    () =>
      emit('state', {
        dirty: dirty.value,
        busy:
          busy.value || loading.value || fileTrashState.value.busy || tagRemovalState.value.busy,
        uncertain:
          tagRemovalState.value.uncertain ||
          fileTrashState.value.uncertain ||
          saveNeedsCheck.value ||
          !!data.value?.pending.length
      }),
    { immediate: true }
  )
  const navigation = useInboxNavigation(
    computed(() => data.value?.source.resourceId),
    computed(() => busy.value || loading.value || dirty.value)
  )
  const back = computed(() =>
    detailRoute.value.query.return === 'library'
      ? { path: '/document-workflow/documents', query: { folder: detailRoute.value.query.folder } }
      : detailRoute.value.query.return === 'filed'
        ? {
            path: '/document-workflow/documents',
            query: { job: detailRoute.value.query.job, from: 'filed' }
          }
        : detailRoute.value.query.return === 'review'
          ? { path: '/document-workflow/inbox', query: { job: detailRoute.value.query.job } }
          : '/document-workflow/inbox'
  )
  function applyVerifiedMetadata(result?: MetadataMutationResult) {
    const current = data.value,
      source = result?.source,
      record = result?.record
    if (
      result?.state === 'done' &&
      current &&
      source &&
      record &&
      source.path === current.source.path &&
      source.resourceId === current.source.resourceId &&
      source.sha256 === current.source.sha256 &&
      record.version === current.record.version + 1
    ) {
      data.value = { ...current, source, record }
      values.value = savedValues()
      tags.value = ''
      error.value = ''
      emit('changed', {
        path: source.path,
        resourceId: source.resourceId,
        etag: source.etag,
        tags: source.tags,
        fields: record.fields
      })
      return true
    }
    return false
  }
  async function tagRemoved(result?: MetadataMutationResult) {
    if (!applyVerifiedMetadata(result) && (await load())) emit('changed')
  }

  async function verifyLoadedIdentity(detail: Detail, path: string, job: unknown, space: unknown) {
    if (
      props.embedded &&
      ((props.resourceId && detail.source.resourceId !== props.resourceId) ||
        (!data.value && props.etag && detail.source.etag !== props.etag))
    )
      throw new WorkflowError(
        'SOURCE_CHANGED',
        'The source document changed. Refresh its review before editing fields.'
      )
    if (typeof job === 'string') {
      const saved = await store.request('job', { id: job })
      if (saved.job?.source.resourceId !== detail.source.resourceId) {
        const location = await store.request('document-location', { id: job })
        if (
          location.resourceId !== detail.source.resourceId ||
          location.path !== path ||
          location.space !== space
        )
          throw new WorkflowError(
            'OPERATION_HELD',
            'This path now contains a different document. Return to its saved filing record.'
          )
      }
    }
  }
  async function load({ keepDraft = false } = {}) {
    const version = ++generation
    loading.value = true
    try {
      if (!store.connection.value) await store.connect()
      const pin = scope(),
        path = String(detailRoute.value.query.path ?? ''),
        job = detailRoute.value.query.job
      const detail = await store.request('metadata', {
        path,
        ...(typeof detailRoute.value.query.space === 'string'
          ? { documentSpace: detailRoute.value.query.space }
          : {})
      })
      await verifyLoadedIdentity(detail, path, job, detailRoute.value.query.space)
      if (!alive || version !== generation) return false
      if (scope() !== pin)
        throw new WorkflowError('SOURCE_CHANGED', 'The workspace changed. Reopen this document.')
      if (data.value?.source.sha256 !== detail.source.sha256) {
        verifiedPreview.reset()
      }
      data.value = detail
      fileTrashState.value.uncertain = !!detail.trash
      if (detailRoute.value.query.return === 'inbox') {
        const parent = detail.source.path.split('/').slice(0, -1).join('/')
        if (withinInbox(parent, store.inbox.value)) store.folder.value = parent
        await store.refresh()
      }
      if (!alive || version !== generation || scope() !== pin) return false
      if (!keepDraft) {
        values.value = savedValues()
        tags.value = ''
        saveNeedsCheck.value = false
      }
      error.value = ''
      void loadPreview()
      return true
    } catch (e) {
      if (alive && version === generation) {
        if (!keepDraft) data.value = null
        error.value = e instanceof Error ? e.message : 'Could not load document details'
      }
      return false
    } finally {
      if (alive && version === generation) loading.value = false
    }
  }
  watch(
    () =>
      JSON.stringify([
        detailRoute.value.query.path,
        detailRoute.value.query.job,
        detailRoute.value.query.space
      ]),
    () => {
      editing.value = false
      data.value = null
      message.value = ''
      trashUncertain.value = false
      verifiedPreview.reset()
      previewOpen.value = true
      void load()
    },
    { immediate: true }
  )
  onBeforeUnmount(() => {
    alive = false
    generation++
  })
  const { startEdit, cancel, reload, save, reconcile } = useMetadataActions({
    store,
    data,
    values,
    tags,
    busy,
    editing,
    error,
    message,
    fileTrashState,
    dirty,
    saveNeedsCheck,
    query: () => detailRoute.value.query,
    scope,
    isAlive: () => alive,
    savedValues,
    changed: () => emit('changed'),
    load,
    applyVerifiedMetadata
  })
  async function loadPreview() {
    if (preview.value || previewBusy.value || !data.value) return
    if (!/\.pdf$/i.test(data.value.source.path)) return
    const source = data.value.source
    await verifiedPreview.load(
      source.sha256,
      () =>
        store.request('preview', {
          path: source.path,
          ...(typeof detailRoute.value.query.space === 'string'
            ? { documentSpace: detailRoute.value.query.space }
            : {})
        }),
      {
        changed: 'The PDF changed. Reload document details before opening it.',
        failed: 'PDF unavailable'
      }
    )
  }
  const retryMonitor = useRetryMonitor({
    key: computed(() =>
      JSON.stringify([
        data.value?.source.resourceId,
        data.value?.source.etag,
        store.connection.value?.account,
        store.connection.value?.space
      ])
    ),
    blocked: () => busy.value || loading.value || dirty.value,
    request: (id) => store.request('intake-item', { id }),
    issue: (issue) => {
      if (data.value) data.value.processingIssue = issue
      if (issue) message.value = ''
    },
    ready: async (id) => {
      await router.push({ path: '/document-workflow/inbox', query: { job: id } })
    }
  })
  async function retryProcessing() {
    if (!data.value?.processingIssue?.queueId || busy.value || dirty.value) return
    busy.value = true
    error.value = ''
    const current = data.value,
      queueId = current.processingIssue!.queueId!
    try {
      const result = await store.request('intake-control', { action: 'retry', ids: [queueId] })
      if (result.affected && data.value === current) {
        data.value.processingIssue = null
        retryMonitor.start(queueId, current.source)
      }
      message.value = 'Queued for retry'
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Preparation held'
    } finally {
      busy.value = false
    }
  }
  async function prepareOriginal() {
    if (
      !data.value ||
      busy.value ||
      dirty.value ||
      fileTrashState.value.uncertain ||
      fileTrashState.value.busy ||
      data.value.pending.length
    )
      return
    busy.value = true
    error.value = ''
    try {
      const source = data.value.source,
        result = await store.request('prepare-original', {
          path: source.path,
          resourceId: source.resourceId,
          etag: source.etag,
          ...(source.space ? { documentSpace: source.space } : {})
        })
      await store.openJob(result.id)
      await router.push({ path: '/document-workflow/inbox', query: { job: result.id } })
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Manual filing held'
    } finally {
      busy.value = false
    }
  }
  async function reformatPDF() {
    if (
      !data.value?.conversion ||
      busy.value ||
      fileTrashState.value.busy ||
      fileTrashState.value.uncertain ||
      dirty.value
    )
      return
    busy.value = true
    error.value = ''
    try {
      const result = await store.request('conversion-reformat', {
        id: data.value.conversion.conversionId
      })
      if (result.uncertain) throw new WorkflowError('OPERATION_HELD', result.error)
      await load()
      message.value = 'PDF recreated; the workbook and previous PDF are preserved'
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'PDF recreation held'
    } finally {
      busy.value = false
    }
  }
  async function prepare() {
    if (data.value && !/\.pdf$/i.test(data.value.source.path)) {
      error.value = 'Select this file in the Inbox and choose Create PDF copies.'
      return
    }
    if (!data.value || busy.value || dirty.value) return
    busy.value = true
    preparing.value = true
    error.value = ''
    try {
      const result = await store.prepareDocument(data.value.source.path, {
        newReview: true,
        retry: true,
        resourceId: data.value.source.resourceId,
        etag: data.value.source.etag,
        cloudConsent: cloudConsent.value,
        ...(typeof detailRoute.value.query.space === 'string'
          ? { documentSpace: detailRoute.value.query.space }
          : {})
      })
      const filed = ['library', 'filed'].includes(String(detailRoute.value.query.return))
      await router.push({
        path: filed ? '/document-workflow/documents' : '/document-workflow/inbox',
        query: { job: result.id, ...(filed ? { from: 'filed' } : {}) }
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Preparation held'
    } finally {
      busy.value = false
      preparing.value = false
      processing.refresh()
    }
  }
  const processing = useDocumentProcessing({
    source: computed(() => data.value?.source),
    scope: computed(() => scope() ?? ''),
    request: (source) =>
      store.request('document-processing', {
        path: source.path,
        resourceId: source.resourceId,
        etag: source.etag,
        ...(source.space ? { documentSpace: source.space } : {})
      })
  })
  const currentProcessingIssue = computed(() =>
    preparing.value || processing.active.value
      ? null
      : processing.status.value
        ? processing.status.value.processingIssue
        : data.value?.processingIssue
  )
  const cloudConsent = ref(false)
  const duplicate = computed(
    () =>
      store.files.value.find((file) => file.resourceId === data.value?.source.resourceId)?.duplicate
  )
  async function openOriginal() {
    if (!duplicate.value?.job || busy.value) return
    busy.value = true
    error.value = ''
    try {
      const id = duplicate.value.job,
        location = await store.request('document-location', { id })
      await router.push({
        path: '/document-workflow/details',
        query: { path: location.path, job: id, return: 'filed', space: location.space }
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not open original'
    } finally {
      busy.value = false
    }
  }
  async function trashDuplicate() {
    if (!duplicate.value || !data.value || busy.value || dirty.value || data.value.pending.length)
      return
    const id = duplicate.value.id,
      resource = data.value.source.resourceId,
      before = navigation.snapshot(),
      verify = trashUncertain.value || duplicate.value.uncertain
    busy.value = true
    error.value = ''
    trashUncertain.value = true
    try {
      const result = await store.request(verify ? 'duplicate-verify' : 'duplicate-trash', { id })
      if (!alive) return
      if (result.state === 'trashed') {
        busy.value = false
        await store.refresh()
        await navigation.advance(before, resource)
      } else {
        trashUncertain.value = result.uncertain === true
        error.value = result.detail ?? 'Trash outcome needs verification'
      }
    } catch (e) {
      if (alive) error.value = e instanceof Error ? e.message : 'Trash outcome needs verification'
    } finally {
      busy.value = false
    }
  }

  return {
    detailRoute,
    store,
    t,
    data,
    values,
    tags,
    error,
    message,
    busy,
    loading,
    editing,
    saveNeedsCheck,
    tagRemovalState,
    preparing,
    trashUncertain,
    fileTrashState,
    canTrash,
    fileTrashed,
    preview,
    previewBusy,
    previewError,
    dirty,
    navigation,
    back,
    tagRemoved,
    load,
    startEdit,
    cancel,
    reload,
    save,
    reconcile,
    retryProcessing,
    prepareOriginal,
    reformatPDF,
    prepare,
    processing,
    currentProcessingIssue,
    cloudConsent,
    duplicate,
    openOriginal,
    trashDuplicate
  }
}
