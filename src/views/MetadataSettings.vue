<script setup lang="ts">
import { WorkflowError } from '../domain/errors'

// SPDX-License-Identifier: AGPL-3.0-only
import MetadataFieldDefinition from '../components/MetadataFieldDefinition.vue'
import MetadataTagDefinition from '../components/MetadataTagDefinition.vue'
import { ref, onMounted, nextTick, onBeforeUnmount, watch, useId } from 'vue'
import { useLocale } from '../state/locale'
import { useWorkspace } from '../state/workspace'
import { defaultMetadataSchema, validateMetadataSchema } from '../domain/metadata'
import type { MetadataUsage } from '../domain/metadata-usage'
import type { MetadataSchema, TagRule } from '../domain/metadata'
const tab = ref<'fields' | 'tags'>('fields'),
  fieldTab = ref<HTMLButtonElement>(),
  tagTab = ref<HTMLButtonElement>(),
  editingField = ref<MetadataSchema['fields'][number] | null>(null),
  editingTag = ref<TagRule | null>(null),
  busy = ref(true)
async function switchTab(value: 'fields' | 'tags', focus = false) {
  tab.value = value
  if (focus) {
    await nextTick()
    ;(value === 'fields' ? fieldTab.value : tagTab.value)?.focus()
  }
}
const removalDialog = ref<HTMLDialogElement | null>(null),
  removalTitle = useId(),
  removal = ref<{
    kind: 'field' | 'tag'
    item: MetadataSchema['fields'][number] | TagRule
    name: string
    count: number | null
  } | null>(null),
  checkingRemoval = ref(false)
const definitionKeys = new WeakMap<object, string>()
function rememberDefinitions() {
  for (const field of schema.value.fields) definitionKeys.set(field, field.id)
  for (const tag of schema.value.tags) definitionKeys.set(tag, tag.tag)
}
const usage = ref<MetadataUsage | null>(null),
  usageLoading = ref(false),
  usageError = ref(false)
let alive = true,
  usageGeneration = 0
const store = useWorkspace(),
  { t } = useLocale(),
  schema = ref<MetadataSchema>(defaultMetadataSchema()),
  error = ref(''),
  message = ref('')
onMounted(async () => {
  try {
    if (!store.connection.value) await store.connect()
    schema.value = await store.request('metadata-schema')
    rememberDefinitions()
    void loadUsage()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Connection failed'
  } finally {
    busy.value = false
  }
})
async function loadUsage() {
  const generation = ++usageGeneration,
    pin = JSON.stringify(store.connection.value)
  usage.value = null
  usageLoading.value = true
  usageError.value = false
  try {
    const result = await store.request('metadata-usage')
    if (
      !result ||
      !['fields', 'tags'].every(
        (key) =>
          result[key] &&
          typeof result[key] === 'object' &&
          !Array.isArray(result[key]) &&
          Object.values(result[key]).every(
            (value) => Number.isSafeInteger(value) && Number(value) >= 0
          )
      )
    )
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Counts unavailable')
    if (alive && generation === usageGeneration && pin === JSON.stringify(store.connection.value))
      usage.value = result
  } catch {
    if (alive && generation === usageGeneration) usageError.value = true
  } finally {
    if (alive && generation === usageGeneration) usageLoading.value = false
  }
}
watch(
  () =>
    JSON.stringify([
      store.connection.value?.server,
      store.connection.value?.account,
      store.connection.value?.space
    ]),
  () => {
    usageGeneration++
    usage.value = null
    usageLoading.value = false
    removalDialog.value?.close()
    removal.value = null
  }
)
onBeforeUnmount(() => {
  alive = false
  usageGeneration++
})
function usageLabel(count: number | undefined) {
  return usage.value
    ? t(count === 1 ? '1 document' : '{count} documents', { count: count ?? 0 })
    : t(usageLoading.value ? 'Loading…' : 'Counts unavailable')
}
function addField() {
  let n = schema.value.fields.length + 1
  while (schema.value.fields.some((f) => f.id === `field_${n}`)) n++
  const field: MetadataSchema['fields'][number] = {
    id: `field_${n}`,
    label: '',
    type: 'text' as const,
    aliases: [],
    choices: []
  }
  schema.value.fields.push(field)
  editingField.value = schema.value.fields.at(-1)!
}
function addTag() {
  schema.value.tags.push({ tag: '', terms: [] })
  editingTag.value = schema.value.tags.at(-1)!
}
async function removeDefinition(
  kind: 'field' | 'tag',
  item: MetadataSchema['fields'][number] | TagRule
) {
  if (busy.value || checkingRemoval.value) return
  checkingRemoval.value = true
  const pin = JSON.stringify(store.connection.value)
  await loadUsage()
  checkingRemoval.value = false
  if (!alive || pin !== JSON.stringify(store.connection.value)) return
  const key =
      definitionKeys.get(item) ??
      (kind === 'field' ? (item as MetadataSchema['fields'][number]).id : (item as TagRule).tag),
    count = usage.value
      ? kind === 'field'
        ? (usage.value.fields[key] ?? 0)
        : (usage.value.tags[key] ?? 0)
      : null
  removal.value = {
    kind,
    item,
    name: kind === 'field' ? (item as MetadataSchema['fields'][number]).label || key : key,
    count
  }
  if (count === 0) {
    confirmRemoval()
    return
  }
  await nextTick()
  removalDialog.value?.showModal()
}
function cancelRemoval() {
  removalDialog.value?.close()
  removal.value = null
}
function confirmRemoval() {
  if (!removal.value) return
  const { kind, item } = removal.value
  if (kind === 'field') {
    const at = schema.value.fields.indexOf(item as MetadataSchema['fields'][number])
    if (at >= 0) schema.value.fields.splice(at, 1)
  } else {
    const at = schema.value.tags.indexOf(item as TagRule)
    if (at >= 0) schema.value.tags.splice(at, 1)
  }
  cancelRemoval()
}
async function save() {
  if (busy.value) return
  busy.value = true
  try {
    schema.value = await store.request('metadata-schema-save', {
      schema: validateMetadataSchema(JSON.parse(JSON.stringify(schema.value)))
    })
    rememberDefinitions()
    message.value = 'Saved'
    error.value = ''
    editingField.value = null
    editingTag.value = null
    void loadUsage()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
  <p v-if="message" class="message" role="status">{{ t(message) }}</p>
  <div class="metadata-tabs" role="tablist" :aria-label="t('Fields & tags')">
    <button
      id="metadata-fields-tab"
      ref="fieldTab"
      type="button"
      role="tab"
      :aria-selected="tab === 'fields'"
      aria-controls="metadata-fields-panel"
      :tabindex="tab === 'fields' ? 0 : -1"
      @click="switchTab('fields')"
      @keydown.right.prevent="switchTab('tags', true)"
      @keydown.left.prevent="switchTab('tags', true)"
      @keydown.home.prevent="switchTab('fields', true)"
      @keydown.end.prevent="switchTab('tags', true)"
    >
      {{ t('Fields') }}</button
    ><button
      id="metadata-tags-tab"
      ref="tagTab"
      type="button"
      role="tab"
      :aria-selected="tab === 'tags'"
      aria-controls="metadata-tags-panel"
      :tabindex="tab === 'tags' ? 0 : -1"
      @click="switchTab('tags')"
      @keydown.right.prevent="switchTab('fields', true)"
      @keydown.left.prevent="switchTab('fields', true)"
      @keydown.home.prevent="switchTab('fields', true)"
      @keydown.end.prevent="switchTab('tags', true)"
    >
      {{ t('Tags') }}
    </button>
  </div>
  <p class="usage-help">
    {{ t('Counts show saved usage in Inbox and Documents.') }}
    <span v-if="usageError"
      >{{ t('Counts unavailable') }}
      <button type="button" class="button subtle" @click="loadUsage">{{ t('Retry') }}</button></span
    >
  </p>
  <fieldset :disabled="busy || checkingRemoval" class="metadata-editor">
    <section
      v-show="tab === 'fields'"
      id="metadata-fields-panel"
      class="panel metadata-panel"
      role="tabpanel"
      aria-labelledby="metadata-fields-tab"
    >
      <div class="metadata-heading">
        <h2>{{ t('Custom fields') }}</h2>
        <button type="button" class="button" @click="addField">{{ t('Add field') }}</button>
      </div>
      <p class="section-description">
        {{
          t(
            'Add details such as invoice number or due date. Enter them on documents, or match printed labels to extract values automatically.'
          )
        }}
      </p>

      <MetadataFieldDefinition
        v-for="(field, i) in schema.fields"
        :key="i"
        :field="field"
        :open="editingField === field"
        :usage-label="usageLabel(usage?.fields[field.id])"
        :usage-count="usage ? (usage.fields[field.id] ?? 0) : usageLoading ? '…' : '—'"
        @toggle="editingField = editingField === field ? null : field"
        @update="Object.assign(field, $event)"
        @remove="removeDefinition('field', field)"
      />
    </section>
    <section
      v-show="tab === 'tags'"
      id="metadata-tags-panel"
      class="panel metadata-panel"
      role="tabpanel"
      aria-labelledby="metadata-tags-tab"
    >
      <div class="metadata-heading">
        <h2>{{ t('Saved tags') }}</h2>
        <button type="button" class="button" @click="addTag">{{ t('Add tag') }}</button>
      </div>
      <p id="saved-tags-help" class="section-description">
        {{
          t(
            'Reusable tags for manual selection or keyword matching, without AI. Leave terms blank for manual use. Example: “guarantee” → Warranty.'
          )
        }}
      </p>
      <MetadataTagDefinition
        v-for="(rule, i) in schema.tags"
        :key="i"
        :rule="rule"
        :open="editingTag === rule"
        :usage-label="usageLabel(usage?.tags[rule.tag])"
        :usage-count="usage ? (usage.tags[rule.tag] ?? 0) : usageLoading ? '…' : '—'"
        @toggle="editingTag = editingTag === rule ? null : rule"
        @update="Object.assign(rule, $event)"
        @remove="removeDefinition('tag', rule)"
      />
    </section>
  </fieldset>
  <button type="button" class="button primary" :disabled="busy || checkingRemoval" @click="save">
    {{ t('Save') }}
  </button>
  <dialog
    ref="removalDialog"
    class="remove-definition-dialog"
    :aria-labelledby="removalTitle"
    @cancel="cancelRemoval"
  >
    <h2 :id="removalTitle">{{ t(removal?.kind === 'field' ? 'Remove field?' : 'Remove tag?') }}</h2>
    <p class="removal-name">{{ removal?.name }}</p>
    <p>
      {{
        removal?.count === null
          ? t('Usage could not be checked. This item may be used by documents.')
          : t(removal?.count === 1 ? 'Used by 1 document.' : 'Used by {count} documents.', {
              count: removal?.count ?? 0
            })
      }}
    </p>
    <p>
      {{
        t(
          'This removes the definition from settings. Existing document tags and saved field values are kept.'
        )
      }}
    </p>
    <footer>
      <button type="button" class="button danger" @click="confirmRemoval">{{ t('Remove') }}</button
      ><button type="button" class="button subtle" autofocus @click="cancelRemoval">
        {{ t('Cancel') }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.remove-definition-dialog {
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 24px;
  max-width: 440px;
  width: calc(100% - 40px);
  box-sizing: border-box;
}
.remove-definition-dialog::backdrop {
  background: #0008;
}
.remove-definition-dialog h2 {
  font-size: 18px;
  margin: 0 0 16px;
}
.remove-definition-dialog p {
  font-size: 13px;
  line-height: 1.6;
}
.removal-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.remove-definition-dialog footer {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.button.danger {
  color: var(--danger-ink);
  border-color: var(--danger-ink);
  background: var(--danger-bg);
}
.metadata-panel {
  padding: 24px;
  margin-bottom: 22px;
}
.metadata-tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 20px;
  border-bottom: 1px solid var(--line);
}
.metadata-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  padding: 12px 16px;
  cursor: pointer;
}
.metadata-tabs button[aria-selected='true'] {
  color: var(--ink);
  border-color: var(--accent-text);
  font-weight: 600;
}
.metadata-tabs span {
  margin-left: 8px;
  font-size: 12px;
  color: var(--muted);
}
.metadata-editor {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.metadata-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.metadata-heading h2 {
  margin: 0;
}
.metadata-heading .button {
  flex: none;
}
.usage-help {
  font-size: 12px;
  color: var(--muted);
  margin: -8px 0 20px;
}
.metadata-panel > .section-description {
  font-size: 13px;
  max-width: 780px;
  margin: 8px 0 20px;
}
@media (max-width: 700px) {
  .metadata-panel {
    padding: 20px;
  }
}
</style>
