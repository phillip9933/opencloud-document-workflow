<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue'
import TagPicker from './TagPicker.vue'
import { useLocale } from '../state/locale'
import type { DocumentDetail } from '../domain/document-details'
const props = defineProps<{
  data: DocumentDetail
  values: Record<string, string | number>
  tags: string
  busy: boolean
  blocked: boolean
  loading: boolean
  dirty: boolean
  saveNeedsCheck: boolean
}>()
const emit = defineEmits<{
  'update:values': [values: Record<string, string | number>]
  'update:tags': [tags: string]
  save: []
  cancel: []
  reload: []
}>()
const { t } = useLocale()
const saveDisabled = computed(
  () =>
    props.busy ||
    props.blocked ||
    !props.dirty ||
    props.saveNeedsCheck ||
    props.data.pending.length > 0
)
function submit() {
  if (!saveDisabled.value) emit('save')
}
function setField(id: string, value: string | number) {
  if (props.busy || props.blocked) return
  emit('update:values', { ...props.values, [id]: value })
}
function inputField(id: string, event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
  const number = target instanceof HTMLInputElement && target.type === 'number'
  setField(
    id,
    number && target.value !== '' && Number.isFinite(target.valueAsNumber)
      ? target.valueAsNumber
      : target.value
  )
}
function useTag(value: string | number) {
  if (props.busy || props.blocked || props.loading) return
  emit('update:tags', [...new Set([...selectedTags.value, String(value)])].join(', '))
}
const selectedTags = computed(() =>
  props.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
)
const suggestedTags = computed(() =>
  props.data.suggestions.tags.filter(
    (tag) =>
      !props.data.source.tags.includes(String(tag.value)) &&
      !selectedTags.value.includes(String(tag.value))
  )
)
const savedTags = computed(() =>
  props.data.schema.tags.filter(
    (tag) =>
      !props.data.source.tags.includes(tag.tag) &&
      !selectedTags.value.includes(tag.tag) &&
      !suggestedTags.value.some((suggestion) => suggestion.value === tag.tag)
  )
)
</script>
<template>
  <form
    class="panel metadata-edit"
    :aria-label="t('Edit document details')"
    @submit.prevent="submit"
  >
    <p v-if="saveNeedsCheck" class="error">
      {{ t('Verify the last save before continuing') }}
    </p>
    <div class="metadata-edit-grid">
      <section>
        <div v-for="field in data.schema.fields" :key="field.id" class="metadata-field">
          <label :for="`field-${field.id}`">{{ field.label }}</label
          ><select
            v-if="field.type === 'choice'"
            :id="`field-${field.id}`"
            :value="values[field.id]"
            @change="inputField(field.id, $event)"
            :disabled="busy || blocked"
          >
            <option value="">—</option>
            <option v-for="choice in field.choices" :key="choice">
              {{ choice }}
            </option></select
          ><input
            v-else
            :id="`field-${field.id}`"
            :value="values[field.id]"
            @input="inputField(field.id, $event)"
            :disabled="busy || blocked"
            :type="field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'"
            :step="field.type === 'number' ? 'any' : undefined"
          />
          <details
            v-if="
              data.suggestions.fields[field.id] &&
              String(data.suggestions.fields[field.id].value) !== String(values[field.id])
            "
            class="metadata-suggestion"
          >
            <summary>{{ t('Suggestion') }}</summary>
            <button
              type="button"
              class="button subtle"
              :disabled="busy || blocked"
              @click="setField(field.id, data.suggestions.fields[field.id].value)"
            >
              {{ data.suggestions.fields[field.id].value }}
            </button>
            <blockquote
              v-for="(quote, index) in data.suggestions.fields[field.id].evidence"
              :key="index"
            >
              {{ quote.quote }}
              <small>{{ t('Page {number}', { number: quote.page }) }}</small>
            </blockquote>
          </details>
        </div>
      </section>
      <section class="edit-tags">
        <div class="tag-list">
          <span v-for="tag in data.source.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>
        <label for="extra-tags">{{ t('Tags to add') }}</label
        ><TagPicker
          id="extra-tags"
          :model-value="tags"
          @update:model-value="emit('update:tags', $event)"
          :disabled="busy || blocked"
          :options="savedTags.map((tag) => tag.tag)"
        />
        <details v-if="suggestedTags.length" class="metadata-suggestion">
          <summary>{{ t('Suggestions') }}</summary>
          <div v-for="tag in suggestedTags" :key="tag.value">
            <button
              type="button"
              class="button tag-choice"
              :aria-label="t('Add tag {tag}', { tag: tag.value })"
              :disabled="busy || blocked"
              @click="useTag(tag.value)"
            >
              {{ tag.value }}
            </button>
            <blockquote v-for="(quote, index) in tag.evidence" :key="index">
              {{ quote.quote }}
              <small>{{ t('Page {number}', { number: quote.page }) }}</small>
            </blockquote>
          </div>
        </details>
      </section>
    </div>
    <footer class="metadata-actions">
      <button class="button primary" :disabled="saveDisabled" type="submit">
        {{ t('Save') }}</button
      ><button type="button" class="button subtle" :disabled="busy" @click="emit('cancel')">
        {{ t('Cancel') }}</button
      ><button
        v-if="saveNeedsCheck"
        type="button"
        class="button"
        :disabled="busy"
        @click="emit('reload')"
      >
        {{ t('Reload') }}
      </button>
    </footer>
  </form>
</template>
<style scoped>
.tag-choice {
  padding: 5px 9px;
  font-size: 12px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.metadata-edit-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
  margin-top: 0;
}
.metadata-field {
  margin-bottom: 22px;
}
.metadata-field label,
.edit-tags label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 7px;
}
.metadata-field input,
.metadata-field select,
.edit-tags input {
  width: 100%;
}
.edit-tags label {
  margin-top: 20px;
}
.metadata-suggestion {
  font-size: 12px;
  margin-top: 10px;
}
.metadata-suggestion summary {
  cursor: pointer;
  color: var(--accent-text);
  padding: 7px 0;
}
.metadata-suggestion .button {
  white-space: normal;
  text-align: left;
}
.metadata-suggestion blockquote {
  border-left: 2px solid var(--line);
  padding-left: 12px;
  margin: 8px 0 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.metadata-suggestion blockquote small {
  display: block;
  color: var(--muted);
}
.metadata-actions {
  position: sticky;
  bottom: -1px;
  background: var(--surface);
  border-top: 1px solid var(--line);
  padding: 18px 0 0;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  z-index: 2;
}
@media (max-width: 700px) {
  .metadata-actions {
    padding-bottom: 8px;
  }
}
</style>
