// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../domain/errors'
import { onBeforeUnmount, ref } from 'vue'
import { pdfHash } from '../domain/source'

/** Only the latest, hash-verified request may replace the displayed document. */
export function useVerifiedPreview() {
  const data = ref<Blob | null>(null),
    busy = ref(false),
    error = ref(''),
    changed = ref(false)
  let generation = 0,
    alive = true
  function reset() {
    generation++
    data.value = null
    busy.value = false
    error.value = ''
    changed.value = false
  }
  async function load(
    expectedHash: string,
    resolve: (current: () => boolean) => Promise<Blob | null>,
    messages: { changed: string; failed: string }
  ) {
    if (!alive) return
    reset()
    const version = generation,
      current = () => alive && version === generation
    busy.value = true
    try {
      const blob = await resolve(current)
      if (!current() || !blob) return
      const hash = await pdfHash(blob)
      if (!current()) return
      if (hash !== expectedHash) {
        changed.value = true
        throw new WorkflowError('SOURCE_CHANGED', messages.changed)
      }
      data.value = blob
    } catch (cause) {
      if (current()) error.value = cause instanceof Error ? cause.message : messages.failed
    } finally {
      if (current()) busy.value = false
    }
  }
  onBeforeUnmount(() => {
    alive = false
    generation++
  })
  return { data, busy, error, changed, reset, load }
}
