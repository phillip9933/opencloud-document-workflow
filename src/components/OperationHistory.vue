<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useLocale } from '../state/locale'
import { processingKind, processingRecordStatus } from '../domain/processing'
import RecordedDetails from './RecordedDetails.vue'
import ProcessingProgress from './ProcessingProgress.vue'
defineProps<{ embedded?: boolean }>()
const { t, formatDate } = useLocale()
import { useRouter, useRoute } from '../state/navigation'
import { useWorkspace, withinInbox } from '../state/workspace'
const store = useWorkspace(),
  router = useRouter(),
  route = useRoute(),
  operations = ref<any[]>([]),
  listPages = ref<(string | null)[]>([null]),
  nextListPage = ref<string | null>(null),
  active = ref<any>(null),
  cursors = ref<(string | null)[]>([null]),
  error = ref('')
let alive = true,
  generation = 0,
  refreshing = false,
  timer: ReturnType<typeof setInterval> | undefined
let listGeneration = 0
async function load(pages = listPages.value) {
  const version = ++listGeneration
  try {
    const value = await store.request('operations', pages.at(-1) ? { cursor: pages.at(-1) } : {})
    if (alive && version === listGeneration) {
      operations.value = value.operations ?? []
      nextListPage.value = value.nextCursor ?? null
      listPages.value = pages
    }
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Could not load operations'
  }
}
async function open(id: string, pages: (string | null)[] = [null]) {
  const version = ++generation
  try {
    const value = await store.request('operation', {
      id,
      ...(pages.at(-1) ? { cursor: pages.at(-1) } : {})
    })
    if (alive && version === generation) {
      active.value = value
      cursors.value = pages
    }
  } catch (e) {
    if (alive && version === generation)
      error.value = e instanceof Error ? e.message : 'Could not load results'
  }
}
function progress(item: any) {
  return {
    state: item.state === 'done' ? 'prepared' : item.state === 'held' ? 'failed' : item.state,
    stage: item.result?.stage,
    reviewState:
      item.state === 'done'
        ? item.result?.manualReview === 'object'
          ? 'needs_details'
          : item.result?.proposal === 'object'
            ? 'needs_review'
            : 'needs_ocr'
        : null
  }
}
async function inspect(item: any) {
  try {
    const id = item.input.id ?? (active.value?.kind === 'prepare' ? item.result?.id : null)
    if (id) {
      await store.openJob(id)
      const path = item.result?.bundle?.source?.path ?? item.input.path,
        filed = active.value?.kind === 'prepare' && path && !withinInbox(path, store.inbox.value)
      await router.push({
        path: filed ? '/document-workflow/documents' : '/document-workflow/inbox',
        query: { job: id, ...(filed ? { from: 'filed' } : {}) }
      })
    } else
      await router.push({ path: '/document-workflow/details', query: { path: item.input.path } })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not open the document'
  }
}
async function retryHeld() {
  try {
    await store.request('operation-retry', { id: active.value.id })
    await open(active.value.id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not retry held documents'
  }
}
async function resume() {
  try {
    await store.request('operation-resume', { id: active.value.id })
    await open(active.value.id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not resume queued work'
  }
}
async function poll() {
  if (refreshing || !alive) return
  refreshing = true
  const id = active.value?.id ?? null,
    version = generation
  try {
    await Promise.all([
      load(),
      id
        ? store
            .request('operation', {
              id,
              ...(cursors.value.at(-1) ? { cursor: cursors.value.at(-1) } : {})
            })
            .then((value) => {
              if (alive && version === generation && active.value?.id === id) active.value = value
            })
        : Promise.resolve()
    ])
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Could not load results'
  } finally {
    refreshing = false
  }
}
watch(
  () => route.value.query.operation,
  (value) => {
    if (typeof value === 'string') void open(value)
  }
)
onMounted((): void => {
  void load()
  if (typeof route.value.query.operation === 'string') void open(route.value.query.operation)
  timer = setInterval(() => {
    void poll()
  }, 5000)
})
onBeforeUnmount(() => {
  alive = false
  generation++
  clearInterval(timer)
})
async function verifyConversion(item: any) {
  try {
    item.result = await store.request('conversion-verify', { id: item.result.id })
    if (item.result.state === 'done') item.state = 'done'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Verification held'
  }
}
async function finishArchive(item: any) {
  try {
    item.result = await store.request('conversion-archive', { id: item.result.id })
    if (item.result.state === 'done') item.state = 'done'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Archive held'
  }
}
</script>
<template>
  <section class="panel operation-history">
    <div v-if="!embedded" class="list-heading">
      <h2>{{ t('Batch history') }}</h2>
      <button class="button" @click="load()">{{ t('Refresh') }}</button>
    </div>
    <ul>
      <li v-for="operation in operations" :key="operation.id">
        <button class="button subtle" @click="open(operation.id)">
          {{ formatDate(operation.created) }} · {{ t(processingKind(operation.kind)) }} ·
          {{ t(processingRecordStatus(operation.state)) }}
        </button>
      </li>
    </ul>
    <div v-if="listPages.length > 1 || nextListPage" class="actions">
      <button
        class="button"
        :disabled="listPages.length === 1"
        @click="load(listPages.slice(0, -1))"
      >
        {{ t('Previous page') }}
      </button>
      <button class="button" :disabled="!nextListPage" @click="load([...listPages, nextListPage])">
        {{ t('Next page') }}
      </button>
    </div>
    <p v-if="!operations.length" class="empty-state">{{ t('No batch history') }}</p>
    <section v-if="active">
      <div class="list-heading">
        <h3>
          {{ t(processingKind(active.kind)) }} · {{ t(processingRecordStatus(active.state)) }}
        </h3>
        <button class="button" @click="open(active.id)">{{ t('Refresh') }}</button>
      </div>
      <button
        v-if="
          active.kind === 'prepare' &&
          ['completed', 'held', 'paused'].includes(active.state) &&
          (active.counts?.held ?? active.items.some((i: any) => i.state === 'held'))
        "
        class="button"
        @click="retryHeld"
      >
        {{ t('Retry held documents') }}</button
      ><button
        v-if="active.counts?.queued ?? active.items.some((i: any) => i.state === 'queued')"
        class="button"
        @click="resume"
      >
        {{ t('Resume queued documents') }}
      </button>
      <nav v-if="cursors.length > 1 || active.nextCursor" class="actions">
        <button
          class="button"
          :disabled="cursors.length < 2"
          @click="open(active.id, cursors.slice(0, -1))"
        >
          {{ t('Previous page') }}</button
        ><button
          class="button"
          :disabled="!active.nextCursor"
          @click="open(active.id, [...cursors, active.nextCursor])"
        >
          {{ t('Next page') }}
        </button>
      </nav>
      <article v-for="item in active.items" :key="active.id + ':' + item.position">
        <button class="document-link" @click="inspect(item)">
          {{
            item.input.path?.split('/').pop() || item.input.id?.slice(0, 12) || t('Document')
          }}</button
        ><span class="pill">{{ t(processingRecordStatus(item.state)) }}</span
        ><ProcessingProgress v-if="active.kind === 'prepare'" :item="progress(item)" stage-only />
        <p v-if="item.result?.error || item.result?.detail">
          {{ t(item.result.error || item.result.detail) }}
        </p>
        <button
          v-if="active.kind === 'convert' && item.state === 'held' && item.result?.id"
          class="button"
          @click="verifyConversion(item)"
        >
          {{ t('Verify conversion') }}</button
        ><button
          v-if="
            active.kind === 'convert' &&
            item.state === 'held' &&
            item.result?.id &&
            item.result.phase === 'upload' &&
            item.result.pdfResourceId
          "
          class="button"
          @click="finishArchive(item)"
        >
          {{ t('Finish archiving original') }}
        </button>
        <RecordedDetails
          label="Recorded result"
          :load="
            async () =>
              (await store.request('operation-result', { id: active.id, position: item.position }))
                .result
          "
        />
      </article>
    </section>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
  </section>
</template>
<style scoped>
summary {
  cursor: pointer;
  color: var(--accent-text);
  padding: 8px 0;
}
h3 {
  font-size: 14px;
}
article {
  padding: 12px 0;
  border-top: 1px solid var(--line);
  font-size: 12px;
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
}
ul {
  padding-left: 12px;
  list-style: none;
}
</style>
