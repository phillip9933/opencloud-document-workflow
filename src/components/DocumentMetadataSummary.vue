<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue'
import DocumentTagRemove from './DocumentTagRemove.vue'
import { useLocale } from '../state/locale'
import type { DocumentDetail, MetadataMutationResult } from '../domain/document-details'
const props = defineProps<{
  data: DocumentDetail
  editDisabled: boolean
  removeDisabled: boolean
}>()
const emit = defineEmits<{
  edit: []
  tagState: [state: { busy: boolean; uncertain: boolean }]
  tagRemoved: [result?: MetadataMutationResult]
}>()
const { t } = useLocale()
const populated = computed(() =>
  props.data.schema.fields.filter((field) => props.data.record.fields[field.id] !== undefined)
)
</script>
<template>
  <section class="panel saved-details" :aria-label="t('Document details')">
    <div class="details-heading">
      <h2>{{ t('Fields') }}</h2>
      <button
        class="icon-button"
        :disabled="editDisabled"
        :aria-label="t('Edit details')"
        :title="t('Edit details')"
        @click="emit('edit')"
      >
        ✎
      </button>
    </div>
    <dl v-if="populated.length" class="metadata-values">
      <div v-for="field in populated" :key="field.id">
        <dt>{{ field.label }}</dt>
        <dd>{{ data.record.fields[field.id] }}</dd>
      </div>
    </dl>
    <p v-else class="empty-value">—</p>
    <div class="saved-tags">
      <h3>{{ t('Tags') }}</h3>
      <div v-if="data.source.tags.length" class="tag-list">
        <span v-for="tag in data.source.tags" :key="tag" class="tag"
          >{{ tag
          }}<DocumentTagRemove
            :tag="tag"
            :source="data.source"
            :version="data.record.version"
            :disabled="removeDisabled"
            @state="emit('tagState', $event)"
            @changed="emit('tagRemoved', $event)"
        /></span>
      </div>
      <p v-else class="empty-value">—</p>
    </div>
  </section>
</template>
<style scoped>
.details-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.details-heading h2 {
  margin: 0;
}
.metadata-values {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  margin: 26px 0;
}
.metadata-values dt {
  font-size: 12px;
  color: var(--muted);
}
.metadata-values dd {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}
.saved-tags {
  border-top: 1px solid var(--line);
  padding-top: 20px;
  margin-top: 24px;
}
.saved-tags h3 {
  font-size: 13px;
  margin: 0 0 12px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.empty-value {
  color: var(--muted);
}
@media (max-width: 700px) {
  .details-heading {
    align-items: start;
  }
}
</style>
