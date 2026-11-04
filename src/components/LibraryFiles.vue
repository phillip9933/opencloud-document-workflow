<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useRoute } from '../state/navigation'
import { useLocale } from '../state/locale'
import {
  filterLibrary,
  libraryFacets,
  libraryTree,
  libraryFormats,
  libraryFormat,
  libraryAncestors
} from '../domain/library'
import type { LibraryEntry } from '../domain/library'
const DocumentDetails = defineAsyncComponent(() => import('../views/DocumentDetails.vue'))
const store = useWorkspace(),
  route = useRoute(),
  { t } = useLocale(),
  entries = ref<LibraryEntry[]>([]),
  root = ref(''),
  space = ref(''),
  search = ref(''),
  tags = ref<string[]>([]),
  format = ref(''),
  layout = ref<'list' | 'folders'>('list'),
  expandedFolders = ref(new Set<string>()),
  collapsedFiltered = ref(new Set<string>()),
  opened = ref(''),
  loading = ref(false),
  error = ref(''),
  shownCount = ref(50)
const detailState = ref({ dirty: false, busy: false, uncertain: false }),
  locked = computed(
    () => detailState.value.dirty || detailState.value.busy || detailState.value.uncertain
  ),
  scope = () =>
    JSON.stringify([
      store.connection.value?.server,
      store.connection.value?.account,
      store.connection.value?.space
    ])
let generation = 0,
  alive = true,
  refreshPending = false
const filter = computed(() => ({ search: search.value, tags: tags.value, format: format.value })),
  filtered = computed(() =>
    filterLibrary(entries.value, filter.value).sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
    )
  ),
  filtering = computed(() => !!search.value.trim() || !!tags.value.length || !!format.value),
  facets = computed(() => libraryFacets(entries.value, filter.value))
const formats = computed(
  () =>
    new Set(
      filterLibrary(entries.value, { ...filter.value, format: '' }).map((entry) =>
        libraryFormat(entry.path)
      )
    )
)
const rows = computed(() =>
  layout.value === 'folders'
    ? libraryTree(
        entries.value,
        filtered.value,
        root.value,
        expandedFolders.value,
        filtering.value,
        collapsedFiltered.value
      )
    : filtered.value.map((entry) => ({ entry, depth: 0, expanded: false }))
)
const shown = computed(() => rows.value.slice(0, shownCount.value))
async function load() {
  if (locked.value) return
  const version = ++generation
  loading.value = true
  error.value = ''
  try {
    if (!store.connection.value) await store.connect()
    const pin = scope(),
      initial = await store.request('library-files'),
      next: LibraryEntry[] = [...(initial.files ?? [])],
      pending: string[] = next.filter((file) => file.folder).map((file) => file.path),
      seen = new Set<string>()
    const valid = () => alive && version === generation && scope() === pin
    if (!valid()) return
    while (pending.length) {
      const batch = pending.splice(0, 4).filter((path) => !seen.has(path))
      batch.forEach((path) => seen.add(path))
      const results = await Promise.allSettled(
        batch.map((path) => store.request('library-files', { path }))
      )
      if (!valid()) return
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
        const value = result.value
        if (value.root !== initial.root || value.space !== initial.space)
          throw new Error('The filing destination changed. Refresh documents.')
        for (const entry of value.files ?? []) {
          next.push(entry)
          if (entry.folder && !seen.has(entry.path)) pending.push(entry.path)
        }
      }
    }
    if (!valid()) return
    const openedResource = entries.value.find((entry) => entry.path === opened.value)?.resourceId
    entries.value = [...new Map(next.map((entry) => [entry.path, entry])).values()]
    if (openedResource)
      opened.value = entries.value.find((entry) => entry.resourceId === openedResource)?.path ?? ''
    root.value = initial.root ?? ''
    space.value = initial.space ?? ''
    if (
      typeof route.value.query.folder === 'string' &&
      route.value.query.folder.startsWith(root.value + '/')
    ) {
      layout.value = 'folders'
      expandedFolders.value = new Set([
        ...libraryAncestors(route.value.query.folder + '/file', root.value)
      ])
    }
    if (opened.value && !entries.value.some((entry) => entry.path === opened.value)) {
      opened.value = ''
      detailState.value = { dirty: false, busy: false, uncertain: false }
    }
  } catch (e) {
    if (alive && version === generation) {
      error.value = e instanceof Error ? e.message : 'Folder unavailable'
    }
  } finally {
    if (alive && version === generation) loading.value = false
  }
}
function toggle(entry: LibraryEntry) {
  if (locked.value) {
    error.value = 'Save or discard your changes before opening another document.'
    return
  }
  if (entry.folder) {
    const set = filtering.value ? new Set(collapsedFiltered.value) : new Set(expandedFolders.value)
    set.has(entry.path) ? set.delete(entry.path) : set.add(entry.path)
    if (filtering.value) collapsedFiltered.value = set
    else expandedFolders.value = set
    return
  }
  opened.value = opened.value === entry.path ? '' : entry.path
  detailState.value = { dirty: false, busy: false, uncertain: false }
  error.value = ''
}
function toggleTag(tag: string) {
  if (!locked.value)
    tags.value = tags.value.includes(tag)
      ? tags.value.filter((value) => value !== tag)
      : [...tags.value, tag]
}
function clear() {
  if (locked.value) return
  search.value = ''
  tags.value = []
  format.value = ''
}
function editorState(path: string, state: typeof detailState.value) {
  if (opened.value === path) detailState.value = state
}
function refreshAfterChange(updated?: {
  path: string
  resourceId: string
  etag: string
  tags: string[]
  fields: Record<string, string | number>
}) {
  if (updated) {
    const entry = entries.value.find(
      (value) =>
        value.path === opened.value &&
        value.path === updated.path &&
        value.resourceId === updated.resourceId
    )
    if (entry) {
      Object.assign(entry, {
        etag: updated.etag,
        tags: [...updated.tags],
        fields: { ...updated.fields }
      })
      return
    }
  }
  refreshPending = true
  if (!locked.value) {
    refreshPending = false
    void load()
  }
}
watch(locked, (value) => {
  if (!value && refreshPending) {
    refreshPending = false
    void load()
  }
})
watch(
  () => JSON.stringify(filter.value),
  () => {
    shownCount.value = 50
    collapsedFiltered.value = new Set()
    if (!locked.value && opened.value && !filtered.value.some((file) => file.path === opened.value))
      opened.value = ''
  }
)
watch(layout, () => (shownCount.value = 50))
watch(
  () =>
    JSON.stringify([
      store.connection.value?.server,
      store.connection.value?.account,
      store.connection.value?.space
    ]),
  () => {
    generation++
    entries.value = []
    opened.value = ''
    detailState.value = { dirty: false, busy: false, uncertain: false }
    search.value = ''
    tags.value = []
    format.value = ''
    void load()
  },
  { immediate: true }
)
function refreshVisible() {
  if (document.visibilityState === 'hidden' || loading.value) return
  if (locked.value) {
    refreshPending = true
    return
  }
  void load()
}
let refreshTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  window.addEventListener('focus', refreshVisible)
  document.addEventListener('visibilitychange', refreshVisible)
  refreshTimer = setInterval(refreshVisible, 60000)
})
onBeforeUnmount(() => {
  alive = false
  generation++
  clearInterval(refreshTimer)
  window.removeEventListener('focus', refreshVisible)
  document.removeEventListener('visibilitychange', refreshVisible)
})
</script>
<template>
  <section class="document-browser" :aria-label="t('Documents')">
    <div class="browser-toolbar">
      <input
        v-model="search"
        :disabled="locked"
        type="search"
        maxlength="200"
        :aria-label="t('Search documents')"
        :placeholder="t('Search names, folders, tags or fields')"
      /><select v-model="format" :disabled="locked" :aria-label="t('File format')">
        <option value="">{{ t('All formats') }}</option>
        <option
          v-for="type in libraryFormats.filter((value) => formats.has(value) || value === format)"
          :key="type"
          :value="type"
        >
          {{ t(type) }}
        </option>
      </select>
      <details v-if="facets.length" class="tag-filter">
        <summary class="button">
          {{ t('Filter by tags') }}<span v-if="tags.length"> ({{ tags.length }})</span
          ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </summary>
        <div class="facet-tags" role="group" :aria-label="t('Filter by tags')">
          <label v-for="facet in facets" :key="facet.tag"
            ><input
              type="checkbox"
              :aria-label="t('Filter by tag {tag}', { tag: facet.tag })"
              :checked="tags.includes(facet.tag)"
              :disabled="locked"
              @change="toggleTag(facet.tag)"
            /><span>{{ facet.tag }}</span
            ><small>{{ facet.count }}</small></label
          >
        </div>
      </details>
      <button v-if="filtering" class="button subtle" :disabled="locked" @click="clear">
        {{ t('Clear filters') }}
      </button>
    </div>
    <p v-if="loading" role="status">{{ t('Loading documents…') }}</p>
    <p v-if="error" role="alert" class="error">
      {{ t(error) }}
      <button v-if="!locked" class="button subtle" @click="load">{{ t('Retry') }}</button>
    </p>
    <section v-if="entries.length || !loading" class="panel document-list">
      <header class="list-toolbar">
        <span v-if="!loading" class="result-count">{{
          t(filtered.length === 1 ? '1 document' : '{count} documents', { count: filtered.length })
        }}</span>
        <div class="view-toggle" role="group" :aria-label="t('Document view')">
          <button
            class="icon-button"
            :aria-pressed="layout === 'list'"
            :aria-label="t('List')"
            :title="t('List')"
            :disabled="locked"
            @click="layout = 'list'"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1" />
            </svg></button
          ><button
            class="icon-button"
            :aria-pressed="layout === 'folders'"
            :aria-label="t('Folders')"
            :title="t('Folders')"
            :disabled="locked"
            @click="layout = 'folders'"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <path d="M3 5h6l2 3h10v11H3z" />
            </svg>
          </button>
        </div>
      </header>
      <table v-if="shown.length">
        <thead>
          <tr>
            <th>{{ t('Document') }}</th>
            <th>{{ t('Tags') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in shown" :key="row.entry.path"
            ><tr :class="{ 'expanded-document': opened === row.entry.path }">
              <td>
                <button
                  class="document-link browser-entry"
                  :style="{ paddingInlineStart: row.depth * 20 + 'px' }"
                  :aria-expanded="row.entry.folder ? row.expanded : opened === row.entry.path"
                  :disabled="locked && opened !== row.entry.path"
                  @click="toggle(row.entry)"
                >
                  <svg
                    class="entry-chevron"
                    :class="{ open: row.entry.folder ? row.expanded : opened === row.entry.path }"
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    aria-hidden="true"
                  >
                    <path
                      d="m6 3 5 5-5 5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                    /></svg
                  >{{ row.entry.path.split('/').pop() }}</button
                ><small v-if="!row.entry.folder && layout === 'list'" class="browser-path">{{
                  row.entry.path.split('/').slice(0, -1).join('/')
                }}</small>
              </td>
              <td>
                <span v-for="tag in row.entry.tags" :key="tag" class="tag">{{ tag }}</span>
              </td>
            </tr>
            <tr v-if="!row.entry.folder && opened === row.entry.path" class="expanded-content">
              <td colspan="2">
                <DocumentDetails
                  :key="row.entry.resourceId + String(row.entry.etag)"
                  embedded
                  :path="row.entry.path"
                  :space="space"
                  :folder="root"
                  :resource-id="row.entry.resourceId"
                  :etag="row.entry.etag"
                  @state="editorState(row.entry.path, $event)"
                  @changed="refreshAfterChange"
                />
              </td></tr
          ></template>
        </tbody>
      </table>
      <p v-else-if="!loading && !error" class="empty-state">
        {{ t(filtering ? 'No matches' : 'No documents') }}
      </p>
    </section>
    <button
      v-if="rows.length > shownCount"
      class="button show-more"
      :disabled="locked"
      @click="shownCount += 50"
    >
      {{ t('Load more') }}
    </button>
  </section>
</template>
<style scoped>
.entry-chevron {
  flex: none;
  margin-right: 8px;
  vertical-align: middle;
  transition: transform 0.15s;
}
.entry-chevron.open {
  transform: rotate(90deg);
}
.browser-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.browser-toolbar > input {
  flex: 1;
  min-width: 180px;
}
.browser-toolbar > select {
  max-width: 200px;
}
.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
}
.view-toggle {
  display: flex;
  gap: 4px;
}
.view-toggle .icon-button[aria-pressed='true'] {
  background: var(--subtle);
  border-color: var(--accent-text);
  color: var(--accent-text);
}
.tag-filter {
  position: relative;
}
.tag-filter > summary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  white-space: nowrap;
}
.tag-filter > summary::-webkit-details-marker {
  display: none;
}
.tag-filter[open] > summary > svg {
  transform: rotate(180deg);
}
.tag-filter[open] > summary {
  border-color: var(--accent-text);
  color: var(--accent-text);
}
.facet-tags {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 5;
  width: 280px;
  max-width: calc(100vw - 48px);
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--input-border);
  background: var(--surface);
  box-shadow: 0 8px 24px #0002;
  border-radius: 7px;
  padding: 8px;
}
.facet-tags label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
}
.facet-tags label:hover {
  background: var(--subtle);
}
.facet-tags input {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--accent);
}
.facet-tags span {
  flex: 1;
  overflow-wrap: anywhere;
}
.facet-tags small {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.result-count {
  font-size: 12px;
  color: var(--muted);
}
.document-list table {
  width: 100%;
}
.browser-entry {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  white-space: normal;
  text-align: left;
  overflow-wrap: anywhere;
}
.folder-caret {
  display: inline-block;
  width: 20px;
  color: var(--muted);
}
.browser-path {
  overflow-wrap: anywhere;
}
.document-list td {
  vertical-align: middle;
}
.document-list .expanded-content > td {
  padding: 0;
}
.expanded-document {
  background: var(--subtle);
}
.show-more {
  margin-top: 16px;
}
@media (max-width: 700px) {
  .browser-toolbar > input {
    flex-basis: 100%;
  }
  .browser-toolbar > select {
    flex: 1;
  }
  .document-list th,
  .document-list td {
    padding: 12px;
  }
  .list-toolbar {
    padding: 10px 12px;
  }
}
</style>
