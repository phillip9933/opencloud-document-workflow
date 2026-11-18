// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref, watch, type Ref } from 'vue'
import type { Review } from '../domain/review'
import type { DraftJob, Workspace } from './workspace'
import { useVerifiedPreview } from './verified-preview'
interface Options {
  store: Workspace
  active: Ref<Review | undefined>
  job: Ref<DraftJob | undefined>
  planned: Ref<{ target?: string; targetSpace?: string } | null>
}
export function useReviewPreview({ store, active, job, planned }: Options) {
  const { connection } = store
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
  async function loadPreview() {
    verifiedPreview.reset()
    resolvedPath.value = null
    resolvedSpace.value = null
    resolvedTags.value = null
    if (!active.value || !connection.value) return
    const bundle = active.value.bundle
    await verifiedPreview.load(
      bundle.source.sha256,
      async (current, signal) => {
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
        return store.request(
          'preview',
          {
            path,
            ...(documentSpace.value && documentSpace.value !== connection.value?.space
              ? { documentSpace: documentSpace.value }
              : {})
          },
          signal
        )
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
  return {
    preview,
    previewLoading,
    previewError,
    previewChanged,
    documentSpace,
    documentPath,
    resolvedTags,
    loadPreview
  }
}
