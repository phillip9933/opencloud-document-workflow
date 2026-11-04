<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import FiledDocuments from '../components/FiledDocuments.vue'
import OperationHistory from '../components/OperationHistory.vue'
import IngestionHistory from '../components/IngestionHistory.vue'
import { ref, onMounted, watch } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
import { useRoute } from '../state/navigation'
const batchesOpen = ref(false)
const store = useWorkspace(),
  route = useRoute(),
  { t, formatDate } = useLocale(),
  events = ref<{ seq: number; job: string; kind: string; detail: unknown; created: string }[]>([]),
  error = ref(''),
  nextCursor = ref<string | null>(null),
  queueTotal = ref<number | null>(null)
async function refresh(more = false) {
  try {
    const result = await store.request('activity', more ? { cursor: nextCursor.value } : {})
    events.value = more ? [...events.value, ...result.events] : result.events
    nextCursor.value = result.nextCursor
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load activity'
  }
}
onMounted(async () => {
  try {
    if (!store.connection.value) await store.connect()
    if (route.value.query.view === 'events') await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not connect workspace'
  }
})
watch(
  () => route.value.query.view,
  (value) => {
    if (value === 'events') void refresh()
  }
)
watch(
  () => [route.value.query.view, route.value.query.operation],
  () => {
    if (route.value.query.view === 'operations' || route.value.query.operation)
      batchesOpen.value = true
  },
  { immediate: true }
)
</script>
<template>
  <main class="screen">
    <header class="screen-heading">
      <h1>
        {{ t('Activity') }}
        <small
          v-if="(!route.query.view || route.query.view === 'operations') && queueTotal !== null"
          class="queue-total"
          >{{ t('{count} processing records', { count: queueTotal }) }}</small
        >
      </h1>
      <button v-if="route.query.view === 'events'" class="button" @click="refresh()">
        {{ t('Refresh') }}
      </button>
    </header>
    <nav class="settings-tabs" :aria-label="t('Activity sections')">
      <RouterLink
        :aria-current="!route.query.view || route.query.view === 'operations' ? 'page' : undefined"
        to="/document-workflow/activity"
        >{{ t('Processing') }}</RouterLink
      ><RouterLink
        :aria-current="route.query.view === 'filing' ? 'page' : undefined"
        to="/document-workflow/activity?view=filing"
        >{{ t('Filing history') }}</RouterLink
      ><RouterLink
        :aria-current="route.query.view === 'events' ? 'page' : undefined"
        to="/document-workflow/activity?view=events"
        >{{ t('Events') }}</RouterLink
      >
    </nav>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
    <FiledDocuments v-if="route.query.view === 'filing'" />
    <section v-else-if="route.query.view === 'events'" class="panel activity-list">
      <p v-if="!events.length" class="empty-state">{{ t('No recorded activity') }}</p>
      <article v-for="event in events" :key="event.seq">
        <time>{{ formatDate(event.created) }}</time
        ><strong>{{ t(event.kind.replaceAll('_', ' ')) }}</strong>
        <details>
          <summary>{{ t('Details') }}</summary>
          <pre>{{ JSON.stringify(event.detail, null, 2) }}</pre>
        </details>
      </article>
      <button v-if="nextCursor" class="button" @click="refresh(true)">{{ t('Load more') }}</button>
    </section>
    <template v-else
      ><IngestionHistory @summary="queueTotal = $event.total" />
      <details
        class="processing-batches"
        :open="batchesOpen"
        @toggle="batchesOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>{{ t('Batch history') }}</summary>
        <p class="queue-help">
          {{
            t('Recorded preparation, filing, conversion and metadata jobs for groups of documents.')
          }}
        </p>
        <OperationHistory v-if="batchesOpen" embedded /></details
    ></template>
  </main>
</template>

<style scoped>
.processing-batches {
  margin-top: 24px;
}
.processing-batches > summary {
  font-weight: 600;
  cursor: pointer;
  padding: 12px 0;
}
.queue-help {
  font-size: 12px;
  color: var(--muted);
}
.queue-total {
  font-size: 14px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 14px;
  white-space: nowrap;
}
</style>
