<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataMutationResult } from '../domain/document-details'
import { ref, watch, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
const props = defineProps<{
  tag: string
  source: { path: string; resourceId: string; etag: string; sha256: string; space?: string }
  version: number
  disabled?: boolean
}>()
const emit = defineEmits<{
    changed: [result?: MetadataMutationResult]
    state: [value: { busy: boolean; uncertain: boolean }]
  }>(),
  store = useWorkspace(),
  { t } = useLocale(),
  busy = ref(false),
  uncertain = ref(false),
  removed = ref(false),
  error = ref('')
let alive = true
const scope = () =>
  JSON.stringify([
    store.connection.value?.server,
    store.connection.value?.account,
    store.connection.value?.space
  ])
watch([busy, uncertain], () => emit('state', { busy: busy.value, uncertain: uncertain.value }), {
  immediate: true
})
async function remove() {
  if (busy.value || uncertain.value || removed.value || props.disabled) return
  const selected = { ...props.source, version: props.version, tag: props.tag },
    identity = scope()
  busy.value = true
  error.value = ''
  try {
    const result = await store.request('metadata-tag-remove', {
      path: selected.path,
      resourceId: selected.resourceId,
      etag: selected.etag,
      sha256: selected.sha256,
      version: selected.version,
      tag: selected.tag,
      ...(selected.space ? { documentSpace: selected.space } : {})
    })
    if (!alive || scope() !== identity) return
    uncertain.value = result.uncertain === true
    removed.value = result.state === 'done'
    emit('changed', result)
  } catch (e) {
    if (alive && scope() === identity) {
      error.value = e instanceof Error ? e.message : 'Tag removal could not be confirmed'
      emit('changed')
    }
  } finally {
    if (alive) busy.value = false
  }
}
watch(scope, () => {
  error.value = ''
  uncertain.value = false
  removed.value = false
})
onBeforeUnmount(() => {
  alive = false
  emit('state', { busy: false, uncertain: false })
})
</script>
<template>
  <span class="tag-remove"
    ><button
      type="button"
      class="remove-tag"
      :disabled="disabled || busy || uncertain || removed"
      :aria-label="t('Remove tag {tag}', { tag })"
      :title="t('Remove tag {tag}', { tag })"
      @click="remove"
    >
      ×</button
    ><span v-if="error" class="error" role="alert">{{ t(error) }}</span></span
  >
</template>
<style scoped>
.tag-remove {
  display: inline-flex;
  align-items: center;
}
.remove-tag {
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  margin-left: 4px;
  min-width: 24px;
  min-height: 24px;
  font-size: 16px;
  cursor: pointer;
}
.tag-remove .error {
  font-size: 12px;
  margin-left: 8px;
}
</style>
