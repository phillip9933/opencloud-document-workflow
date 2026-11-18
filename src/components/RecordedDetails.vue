<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, onBeforeUnmount } from 'vue'
import { useLocale } from '../state/locale'
const props = defineProps<{ label: string; load: () => Promise<unknown> }>()
const { t } = useLocale()
const text = ref(''),
  busy = ref(false),
  error = ref('')
let generation = 0
async function toggle(event: Event) {
  const version = ++generation
  text.value = ''
  error.value = ''
  busy.value = (event.currentTarget as HTMLDetailsElement).open
  if (!busy.value) return
  try {
    const result = await props.load()
    if (generation === version) text.value = JSON.stringify(result, null, 2)
  } catch (e) {
    if (generation === version)
      error.value = e instanceof Error ? e.message : 'Could not load results'
  } finally {
    if (generation === version) busy.value = false
  }
}
onBeforeUnmount(() => generation++)
</script>
<template>
  <details @toggle="toggle">
    <summary>{{ t(label) }}</summary>
    <p v-if="busy" role="status">{{ t('Loading…') }}</p>
    <p v-if="error" role="alert">{{ t(error) }}</p>
    <pre v-if="text">{{ text }}</pre>
  </details>
</template>
<style scoped>
summary {
  cursor: pointer;
  color: var(--accent-text);
  padding: 8px 0;
}
pre {
  white-space: pre-wrap;
}
</style>
