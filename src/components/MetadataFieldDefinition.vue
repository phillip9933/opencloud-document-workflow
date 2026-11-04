<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { useLocale } from '../state/locale'
import type { FieldDefinition } from '../domain/metadata'
defineProps<{
  field: FieldDefinition
  open: boolean
  usageLabel: string
  usageCount: string | number
}>()
const emit = defineEmits<{ toggle: []; remove: []; update: [value: Partial<FieldDefinition>] }>()
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
      <span class="definition-title">{{ field.label || field.id }}</span
      ><span class="definition-summary">{{
        t(({ text: 'Text', number: 'Number', date: 'Date', choice: 'Choice' } as const)[field.type])
      }}</span
      ><span class="usage-count" :aria-label="usageLabel" :title="usageLabel">{{
        usageCount
      }}</span>
    </summary>
    <div class="definition-body">
      <div class="definition-fields">
        <label
          >{{ t('Stable ID')
          }}<input
            :value="field.id"
            @input="emit('update', { id: ($event.target as HTMLInputElement).value })"
            placeholder="invoice_number"
        /></label>
        <label
          >{{ t('Label')
          }}<input
            :value="field.label"
            @input="emit('update', { label: ($event.target as HTMLInputElement).value })"
        /></label>
        <label
          >{{ t('Type')
          }}<select
            :value="field.type"
            @input="
              emit('update', {
                type: ($event.target as HTMLInputElement).value as FieldDefinition['type']
              })
            "
          >
            <option value="text">{{ t('Text') }}</option>
            <option value="number">{{ t('Number') }}</option>
            <option value="date">{{ t('Date') }}</option>
            <option value="choice">{{ t('Choice') }}</option>
          </select></label
        >
        <label
          >{{ t('Printed labels, separated by commas')
          }}<input
            :value="field.aliases.join(', ')"
            @change="emit('update', { aliases: split(($event.target as HTMLInputElement).value) })"
        /></label>
        <label v-if="field.type === 'choice'" class="definition-wide"
          >{{ t('Choices, separated by commas')
          }}<input
            :value="field.choices.join(', ')"
            @change="emit('update', { choices: split(($event.target as HTMLInputElement).value) })"
        /></label>
      </div>
      <p class="field-hint">
        {{
          t(
            'Printed labels match text such as Invoice number: 123. Keep a field’s ID unchanged after saving document values.'
          )
        }}
      </p>
      <div class="definition-actions">
        <button
          type="button"
          class="icon-button"
          :aria-label="t('Remove field')"
          @click="emit('remove')"
        >
          ×
        </button>
      </div>
    </div>
  </details>
</template>
<style scoped src="./metadata-definition.css"></style>
