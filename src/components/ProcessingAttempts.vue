<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, onBeforeUnmount, watch } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
import { processingKind, processingRecordStatus } from '../domain/processing'
const props = defineProps<{ id: string }>(),
  store = useWorkspace(),
  { t, formatDate } = useLocale(),
  data = ref<any>(null),
  busy = ref(false),
  error = ref(''),
  opened = ref(false)
let alive = true,
  generation = 0
async function load() {
  if (busy.value) return
  const n = ++generation,
    pin = JSON.stringify(store.connection.value)
  busy.value = true
  error.value = ''
  try {
    const result = await store.request('intake-history', { id: props.id })
    if (alive && n === generation && pin === JSON.stringify(store.connection.value))
      data.value = result
  } catch (e) {
    if (alive && n === generation)
      error.value = e instanceof Error ? e.message : 'Could not load results'
  } finally {
    if (alive && n === generation) busy.value = false
  }
}
function toggle(event: Event) {
  opened.value = (event.target as HTMLDetailsElement).open
  if (opened.value) void load()
}
watch(
  () => props.id,
  () => {
    generation++
    data.value = null
    busy.value = false
    if (opened.value) void load()
  }
)
onBeforeUnmount(() => {
  alive = false
  generation++
})
</script>
<template>
  <details class="processing-attempts" @toggle="toggle">
    <summary>{{ t('Attempt history') }}</summary>
    <p v-if="busy" role="status">{{ t('Loading…') }}</p>
    <p v-if="error" class="error" role="alert">
      {{ t(error) }} <button class="button subtle" @click="load">{{ t('Retry') }}</button>
    </p>
    <template v-if="data"
      ><details>
        <summary>{{ t('Queue record') }}</summary>
        <pre>{{ JSON.stringify(data.document, null, 2) }}</pre>
      </details>
      <p v-if="!data.attempts.length && !data.events.length">{{ t('No recorded results yet') }}</p>
      <article v-for="(attempt, index) in data.attempts" :key="attempt.id + ':' + index">
        <time>{{ formatDate(attempt.created) }}</time> · {{ t(processingKind(attempt.kind)) }} ·
        {{ t(processingRecordStatus(attempt.state)) }}
        <details>
          <summary>{{ t('Recorded result') }}</summary>
          <pre>{{ JSON.stringify(attempt.result, null, 2) }}</pre>
        </details>
      </article>
      <details v-if="data.events.length">
        <summary>{{ t('Filing events') }}</summary>
        <article v-for="event in data.events" :key="event.seq">
          <time>{{ formatDate(event.created) }}</time> · {{ t(event.kind.replaceAll('_', ' ')) }}
          <pre>{{ JSON.stringify(event.detail, null, 2) }}</pre>
        </article>
      </details></template
    >
  </details>
</template>
<style scoped>
.processing-attempts {
  font-size: 12px;
  max-width: 600px;
  margin-top: 8px;
}
summary {
  cursor: pointer;
  color: var(--accent-text);
}
article {
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
</style>
