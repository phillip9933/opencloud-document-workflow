<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { useLocale } from '../state/locale'
import type { TagRule } from '../domain/metadata'
defineProps<{ rule: TagRule; open: boolean; usageLabel: string; usageCount: string | number }>()
const emit = defineEmits<{ toggle: []; remove: []; update: [value: Partial<TagRule>] }>()
const { t } = useLocale()
function split(value: string) {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}
</script>
<template>
  <details class="definition-card" :open="open">
    <summary @click.prevent="emit('toggle')">
      <span class="definition-title">{{ rule.tag || t('Tag') }}</span
      ><span class="definition-summary">{{
        rule.terms.length
          ? t(rule.match === 'name' ? 'Name aliases' : 'Contains text')
          : t('Manual selection')
      }}</span
      ><span class="usage-count" :aria-label="usageLabel" :title="usageLabel">{{ usageCount }}</span
      ><span v-if="rule.terms.length" class="definition-preview">{{ rule.terms.join(', ') }}</span>
    </summary>
    <div class="definition-body">
      <div class="definition-fields">
        <label
          >{{ t('Tag')
          }}<input
            :value="rule.tag"
            @input="emit('update', { tag: ($event.target as HTMLInputElement).value })"
        /></label>
        <label
          >{{ t('Matching')
          }}<select
            :value="rule.match ?? 'substring'"
            @change="
              emit('update', {
                match: ($event.target as HTMLSelectElement).value === 'name' ? 'name' : undefined
              })
            "
          >
            <option value="substring">{{ t('Contains text') }}</option>
            <option value="name">{{ t('Name aliases') }}</option></select
          ><small v-if="rule.match === 'name'">{{
            t('Name aliases ignore letter case and character width.')
          }}</small></label
        >
        <label class="definition-wide"
          >{{ t('Matching terms, separated by commas (optional)')
          }}<input
            :value="rule.terms.join(', ')"
            aria-describedby="saved-tags-help"
            @change="emit('update', { terms: split(($event.target as HTMLInputElement).value) })"
        /></label>
      </div>
      <div class="definition-actions">
        <button
          type="button"
          class="icon-button"
          :aria-label="t('Remove tag')"
          @click="emit('remove')"
        >
          ×
        </button>
      </div>
    </div>
  </details>
</template>
<style scoped src="./metadata-definition.css"></style>
