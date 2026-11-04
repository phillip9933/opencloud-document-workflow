<script setup lang="ts">
import { WorkflowError } from '../domain/errors'

// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../state/workspace'
import type { IntakeSummary } from '../state/workspace'
import { useRouter } from '../state/navigation'
import { useLocale } from '../state/locale'
import IntakeStatus from './IntakeStatus.vue'
import ProcessingAttempts from './ProcessingAttempts.vue'
import QueueTotals from './QueueTotals.vue'
import ProcessingProgress from './ProcessingProgress.vue'
import { processingMode } from '../domain/processing-policy'
import { processingStatus, processingProgress } from '../domain/processing'
const emit = defineEmits<{ summary: [value: IntakeSummary] }>()
const store = useWorkspace(),
  router = useRouter(),
  { t, locale } = useLocale(),
  queue = ref<any[]>([]),
  nextCursor = ref<string | null>(null),
  enabled = ref(false),
  paused = ref(false),
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  selection = ref<string[]>([])
const counts = ref<IntakeSummary>({
  total: 0,
  waiting: 0,
  running: 0,
  attention: 0,
  ready: 0,
  completed: 0,
  cancelled: 0,
  duplicates: 0,
  superseded: 0,
  retryable: 0,
  cancellable: 0
})
const includeHistory = ref(false)
const bulk = ref({ waiting: 0, running: 0, retryable: 0, cancellable: 0 }),
  retryable = computed(() => counts.value.retryable + bulk.value.retryable),
  cancellable = computed(() => counts.value.cancellable + bulk.value.cancellable)
const checking = computed(() => !!store.intakeHealth.value?.manualCheck),
  allSelected = computed(
    () => queue.value.length > 0 && queue.value.every((item) => selection.value.includes(item.id))
  )
const columns = ['Document', 'Status', 'Stage', 'Attempts'] as const,
  sortColumn = ref<(typeof columns)[number] | null>(null),
  sortDescending = ref(false),
  sorting = ref(false),
  cloudConsent = ref(false)
const sortedQueue = computed(() => {
  if (!sortColumn.value) return queue.value
  const compare = (a: string, b: string) =>
      a.localeCompare(b, locale.value, { numeric: true, sensitivity: 'base' }),
    column = sortColumn.value
  return [...queue.value].sort((a, b) => {
    let order = 0
    if (column === 'Document')
      order = compare(a.path.split('/').pop(), b.path.split('/').pop()) || compare(a.path, b.path)
    if (column === 'Status')
      order = compare(
        t(processingStatus({ ...a, automatic: a.automation })),
        t(processingStatus({ ...b, automatic: b.automation }))
      )
    if (column === 'Stage') {
      const x = processingProgress({ ...a, automatic: a.automation }),
        y = processingProgress({ ...b, automatic: b.automation })
      order = x.step - y.step || compare(t(x.label), t(y.label))
    }
    if (column === 'Attempts') order = Number(a.attempts) - Number(b.attempts)
    return order
      ? sortDescending.value
        ? -order
        : order
      : String(a.id).localeCompare(String(b.id))
  })
})
async function sortBy(column: (typeof columns)[number]) {
  if (sorting.value || busy.value) return
  sortDescending.value = sortColumn.value === column ? !sortDescending.value : false
  sortColumn.value = column
  sorting.value = true
  try {
    const seen = new Set<string>()
    while (nextCursor.value) {
      if (seen.has(nextCursor.value))
        throw new WorkflowError('OPERATION_HELD', 'Could not load history')
      seen.add(nextCursor.value)
      if (!(await load(true))) break
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load history'
  } finally {
    sorting.value = false
  }
}
function canReprocess(item: any) {
  if (item.historical && !item.job) return false
  return (
    /\.pdf$/i.test(item.path) &&
    ![
      'settling',
      'queued',
      'running',
      'duplicate',
      'trashed',
      'removed',
      'superseded',
      'restored'
    ].includes(item.state) &&
    (!item.decision || ['done', 'rejected', 'conflict'].includes(item.decision))
  )
}
const selectedRows = computed(() => queue.value.filter((row) => selection.value.includes(row.id))),
  selectedRetry = computed(() =>
    selectedRows.value.filter(
      (row) =>
        !row.historical &&
        (row.retryable ??
          (!row.decision &&
            (['failed', 'cancelled'].includes(row.state) || row.automation?.state === 'held')))
    )
  ),
  selectedCancel = computed(() =>
    selectedRows.value.filter(
      (row) =>
        !row.historical &&
        row.decision !== 'done' &&
        row.automation?.state !== 'done' &&
        (['settling', 'queued', 'running', 'failed'].includes(row.state) ||
          (row.state === 'prepared' &&
            ['pending', 'running', 'held'].includes(row.automation?.state)))
    )
  )
async function reprocess(item: any) {
  return reprocessItems([item])
}
async function reprocessItems(items = selectedRows.value.filter(canReprocess)) {
  if (busy.value || sorting.value || !items.length || items.some((item) => !canReprocess(item)))
    return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const inputs = []
    for (const item of items) {
      const source = item.job
        ? await store.request('document-location', { id: item.job })
        : { path: item.path, resourceId: item.resource, etag: item.etag }
      if (
        typeof source.path !== 'string' ||
        typeof source.resourceId !== 'string' ||
        typeof source.etag !== 'string'
      )
        throw new WorkflowError('OPERATION_HELD', 'The document location could not be verified')
      inputs.push({
        path: source.path,
        resourceId: source.resourceId,
        etag: source.etag,
        ...(source.space ? { documentSpace: source.space } : {}),
        newReview: true,
        retry: true,
        cloudConsent: cloudConsent.value
      })
    }
    const result = await store.request('operation-start', {
      id: crypto.randomUUID(),
      kind: 'prepare',
      items: inputs
    })
    selection.value = []
    await router.push({ path: '/document-workflow/activity', query: { operation: result.id } })
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Preparation held'
  } finally {
    busy.value = false
  }
}
let lastRefresh = 0,
  alive = true,
  pages = 1,
  timer: ReturnType<typeof setInterval> | undefined
async function load(more = false) {
  if (busy.value) return false
  busy.value = true
  try {
    let cursor = more ? nextCursor.value : null,
      rows: any[] = [],
      r: any
    for (let page = 0; page < (more ? 1 : pages); page++) {
      r = await store.request('intake', {
        currentInbox: true,
        includeHistory: includeHistory.value,
        ...(cursor ? { cursor } : {})
      })
      if (!alive) return false
      rows.push(...r.queue)
      cursor = r.nextCursor ?? null
      if (!cursor) break
    }
    queue.value = more
      ? [...queue.value, ...rows.filter((row) => !queue.value.some((old) => old.id === row.id))]
      : rows
    if (more) pages++
    nextCursor.value = cursor
    enabled.value = r.configuration.enabled
    paused.value = r.paused === true
    bulk.value = r.bulkPreparation ?? { waiting: 0, running: 0, retryable: 0, cancellable: 0 }
    if (r.summary) {
      counts.value = r.summary
      emit('summary', {
        ...r.summary,
        total: includeHistory.value ? (r.historicalTotal ?? r.summary.total) : r.summary.total
      })
    }
    selection.value = selection.value.filter((id) => queue.value.some((row) => row.id === id))
    store.intakeSummary.value = r.summary ?? null
    store.intakePaused.value = paused.value
    store.intakeQueue.value = queue.value
    store.intakeHealth.value = r.health
    store.intakeSessionAttached.value = r.sessionAttached === true
    error.value = ''
    return true
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Could not load history'
    return false
  } finally {
    busy.value = false
  }
}
async function run(operation: string, body: Record<string, unknown> = {}) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await store.request(
      operation,
      operation === 'intake-control' ? { ...body, currentInbox: true } : body
    )
    if (!alive) return
    if (operation === 'intake-control') {
      selection.value = []
      message.value =
        body.action === 'retry'
          ? t('Queued {count} documents for retry', { count: result.affected })
          : body.action === 'cancel'
            ? t('Cancelled {count} processing jobs. Uploaded files are kept.', {
                count: result.affected
              })
            : body.action === 'pause'
              ? t('Pausing after the current document')
              : t('Processing resumed')
    }
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Processing held'
    return
  } finally {
    busy.value = false
  }
  if (alive) await load()
}
function manage(action: string, selected = false) {
  const ids = (action === 'retry' ? selectedRetry.value : selectedCancel.value).map((row) => row.id)
  if (selected && !ids.length) return
  return run('intake-control', { action, ...(selected ? { ids } : {}) })
}
function selectPage() {
  selection.value = allSelected.value
    ? selection.value.filter((id) => !queue.value.some((row) => row.id === id))
    : [...new Set([...selection.value, ...queue.value.map((row) => row.id)])]
}
async function open(item: any) {
  try {
    if (
      !item.job ||
      (!item.decision &&
        ['failed', 'settling', 'queued', 'running', 'cancelled'].includes(item.state))
    ) {
      await router.push({
        path: '/document-workflow/details',
        query: { path: item.path, return: 'inbox' }
      })
      return
    }
    await store.openJob(item.job)
    await router.push({
      path: item.decision === 'done' ? '/document-workflow/documents' : '/document-workflow/inbox',
      query: { job: item.job }
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not open document'
  }
}
watch(includeHistory, () => {
  pages = 1
  selection.value = []
  void load()
})
onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (!busy.value && (checking.value || Date.now() - lastRefresh >= 10000)) {
      lastRefresh = Date.now()
      void load()
    }
  }, 1000)
})
onBeforeUnmount(() => {
  alive = false
  clearInterval(timer)
})
</script>
<template>
  <section>
    <p class="queue-help">
      {{ t('Counts show current inbox work. Past imports remain in history.') }}
    </p>
    <div class="queue-header">
      <QueueTotals :summary="counts" />
      <div class="queue-actions" :aria-label="t('Processing controls')">
        <button
          class="button"
          :disabled="busy || (!enabled && paused && !bulk.waiting && !bulk.running)"
          @click="manage(paused ? 'resume' : 'pause')"
        >
          {{ t(paused ? 'Resume' : 'Pause') }}</button
        ><button class="button" :disabled="busy || !retryable" @click="manage('retry')">
          {{ t('Retry all') }} <span v-if="retryable">({{ retryable }})</span></button
        ><button class="button subtle" :disabled="busy || !cancellable" @click="manage('cancel')">
          {{ t('Cancel all') }}
        </button>
      </div>
    </div>
    <p v-if="bulk.waiting || bulk.running" role="status">
      {{
        t('Batch preparation: {waiting} waiting · {running} processing', {
          waiting: bulk.waiting,
          running: bulk.running
        })
      }}
    </p>
    <p class="queue-help">
      {{
        t(
          'Pause finishes the current document. Cancel keeps uploads. Retry skips filing decisions that need individual review.'
        )
      }}
    </p>
    <div class="history-toolbar">
      <IntakeStatus
        :enabled="enabled"
        :attached="store.intakeSessionAttached.value"
        :health="store.intakeHealth.value"
      /><button
        class="button"
        :disabled="busy || !enabled || paused || checking"
        @click="run('intake-scan')"
      >
        {{ t(checking ? 'Checking…' : 'Check now') }}
      </button>
    </div>
    <label v-if="store.cloudProcessing.value" class="check-label"
      ><input v-model="cloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label
    >
    <p v-if="sorting" role="status">{{ t('Loading…') }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
    <div v-if="selection.length" class="selection-actions">
      <span>{{ t('{count} selected', { count: selection.length }) }}</span
      ><button
        class="button"
        :disabled="busy || !selectedRetry.length"
        @click="manage('retry', true)"
      >
        {{ t('Retry selected') }}</button
      ><button
        class="button subtle"
        :disabled="busy || !selectedCancel.length"
        @click="manage('cancel', true)"
      >
        {{ t('Cancel selected') }}</button
      ><button
        class="button"
        :disabled="
          busy || !selectedRows.some(canReprocess) || (store.cloudProcessing.value && !cloudConsent)
        "
        @click="reprocessItems()"
      >
        {{ t('Reprocess selected') }}
      </button>
    </div>
    <label class="check-label"
      ><input v-model="includeHistory" type="checkbox" :disabled="busy" />{{
        t('Include past imports')
      }}</label
    >
    <section class="panel document-list">
      <table v-if="queue.length">
        <thead>
          <tr>
            <th class="selection-column">
              <input
                type="checkbox"
                :checked="allSelected"
                :aria-label="t('Select all shown documents')"
                @change="selectPage"
              />
            </th>
            <th
              v-for="column in columns"
              :key="column"
              :aria-sort="
                sortColumn === column ? (sortDescending ? 'descending' : 'ascending') : 'none'
              "
            >
              <button class="column-sort" :disabled="busy || sorting" @click="sortBy(column)">
                {{ t(column)
                }}<span v-if="sortColumn === column" aria-hidden="true">{{
                  sortDescending ? '↓' : '↑'
                }}</span>
              </button>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in sortedQueue" :key="item.id">
            <td>
              <input
                v-model="selection"
                type="checkbox"
                :value="item.id"
                :aria-label="t('Select {name}', { name: item.path })"
              />
            </td>
            <td>
              <button
                v-if="
                  (!item.historical || item.job) &&
                  !['duplicate', 'trashed', 'removed'].includes(item.state)
                "
                class="document-link"
                @click="open(item)"
              >
                {{ item.path.split('/').pop() }}</button
              ><span v-else>{{ item.path.split('/').pop() }}</span
              ><small class="source-folder">{{
                item.path.split('/').slice(0, -1).join('/')
              }}</small>
              <details v-if="item.automation?.detail || item.detail">
                <summary>{{ t('Details') }}</summary>
                {{ t(item.automation?.detail || item.detail) }}
              </details>
              <ProcessingAttempts :id="item.id" />
            </td>
            <td>
              {{
                t(
                  item.historical
                    ? 'Past import'
                    : processingStatus({ ...item, automatic: item.automation })
                )
              }}
            </td>
            <td>
              <span v-if="item.historical">{{
                t(processingStatus({ ...item, automatic: item.automation }))
              }}</span
              ><ProcessingProgress v-else :item="item" stage-only />
            </td>
            <td>{{ item.attempts }}</td>
            <td>
              <div class="row-actions">
                <button
                  v-if="canReprocess(item)"
                  class="button"
                  :disabled="busy || sorting || (store.cloudProcessing.value && !cloudConsent)"
                  @click="reprocess(item)"
                >
                  {{ t('Reprocess') }}</button
                ><button
                  v-if="!item.historical && item.state === 'duplicate'"
                  class="button"
                  :disabled="busy || paused"
                  @click="run(item.trash ? 'duplicate-verify' : 'duplicate-trash', { id: item.id })"
                >
                  {{ t(item.trash ? 'Verify Trash outcome' : 'Move to OpenCloud Trash') }}</button
                ><button
                  v-if="
                    !item.historical && ['duplicate', 'trashed'].includes(item.state) && item.job
                  "
                  class="button subtle"
                  :disabled="busy"
                  @click="open(item)"
                >
                  {{ t('Open original') }}</button
                ><button
                  v-if="
                    !item.historical &&
                    (item.retryable ??
                      (!item.decision &&
                        (['failed', 'cancelled'].includes(item.state) ||
                          item.automation?.state === 'held')))
                  "
                  class="button"
                  :disabled="busy"
                  @click="run('intake-retry', { id: item.id })"
                >
                  {{ t('Retry') }}</button
                ><button
                  v-if="
                    !item.historical &&
                    item.state === 'prepared' &&
                    !item.decision &&
                    !item.retryable &&
                    item.proposalState !== 'needs_ocr' &&
                    item.proposalState !== 'needs_details' &&
                    item.automation?.state !== 'done' &&
                    processingMode(store.policy.value) === 'automatic'
                  "
                  class="button"
                  :disabled="busy || paused"
                  @click="run('automation-run', { id: item.job, retry: true })"
                >
                  {{ t('Run automatic rules') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">
        {{ t(includeHistory ? 'No processing history' : 'No current inbox processing') }}
      </p>
      <button v-if="nextCursor" class="button" :disabled="busy" @click="load(true)">
        {{ t('Load more') }}
      </button>
    </section>
  </section>
</template>
<style scoped>
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.column-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.column-sort:hover {
  text-decoration: underline;
}
.queue-header,
.queue-actions,
.selection-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.queue-header {
  justify-content: space-between;
  margin-top: 20px;
}
.queue-counts {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin: 0;
}
.queue-counts > div {
  display: flex;
  flex-direction: column-reverse;
  gap: 5px;
}
.queue-counts dt {
  font-size: 12px;
  color: var(--muted);
}
.queue-counts dd {
  font-size: 23px;
  font-weight: 600;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.queue-help {
  font-size: 12px;
  color: var(--muted);
  margin: 14px 0 0;
}
.history-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.history-toolbar .intake-health {
  flex: 1;
}
.selection-actions {
  margin: 0 0 14px;
  font-size: 13px;
}
.selection-column {
  width: 36px;
}
.document-list td {
  vertical-align: middle;
}
.document-list input[type='checkbox'] {
  width: 16px;
  height: 16px;
}
.source-folder {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
details {
  font-size: 12px;
  max-width: 400px;
  margin-top: 8px;
}
summary {
  cursor: pointer;
  color: var(--muted);
}
@media (max-width: 700px) {
  .document-list th:nth-child(3),
  .document-list td:nth-child(3) {
    display: table-cell;
  }
}
</style>
