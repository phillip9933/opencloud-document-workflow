// SPDX-License-Identifier: AGPL-3.0-only
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ProcessingIssueInfo } from '../domain/processing'
export interface DocumentProcessingState {
  state: string
  stage?: string
  job?: string | null
  paused?: boolean
  started?: string
  updated?: string
  processingIssue: ProcessingIssueInfo | null
  source: { resourceId: string; etag: string }
}
export interface ProcessingSource {
  path: string
  resourceId: string
  etag: string
  space?: string
}
// Poll status only. Never reload metadata/preview or replace a user's draft.
export function useDocumentProcessing(options: {
  source: Ref<ProcessingSource | undefined>
  scope: Ref<string>
  request: (source: ProcessingSource) => Promise<DocumentProcessingState>
}) {
  const status = ref<DocumentProcessingState | null>(null),
    unavailable = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined,
    generation = 0,
    alive = true
  const key = computed(() => JSON.stringify([options.scope.value, options.source.value]))
  function restart() {
    clearTimeout(timer)
    const version = ++generation,
      source = options.source.value,
      pin = key.value
    status.value = null
    unavailable.value = false
    if (!source || !options.scope.value) return
    const poll = async () => {
      if (!alive || version !== generation || key.value !== pin) return
      try {
        const result = await options.request(source)
        if (!alive || version !== generation || key.value !== pin) return
        if (result.source?.resourceId !== source.resourceId || result.source.etag !== source.etag) {
          status.value = null
          unavailable.value = true
          return
        }
        status.value = result
        unavailable.value = false
      } catch {
        if (!alive || version !== generation || key.value !== pin) return
        unavailable.value = true
      }
      if (alive && version === generation)
        timer = setTimeout(() => void poll(), unavailable.value ? 5000 : 2500)
    }
    void poll()
  }
  watch(key, restart, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => {
    alive = false
    generation++
    clearTimeout(timer)
  })
  return {
    status,
    unavailable,
    refresh: restart,
    active: computed(
      () =>
        !unavailable.value && ['queued', 'settling', 'running'].includes(status.value?.state ?? '')
    )
  }
}
