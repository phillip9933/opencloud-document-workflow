<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue'
import type { IntakeSummary } from '../state/workspace'
import { useLocale } from '../state/locale'
const props = defineProps<{ summary: IntakeSummary }>(),
  { t } = useLocale()
const stats = computed(() => [
  { label: 'Waiting', value: props.summary.waiting },
  { label: 'Processing', value: props.summary.running },
  { label: 'Ready to review', value: props.summary.ready },
  { label: 'Completed', value: props.summary.completed },
  { label: 'Needs attention', value: props.summary.attention },
  ...(props.summary.cancelled ? [{ label: 'Cancelled', value: props.summary.cancelled }] : []),
  ...(props.summary.duplicates ? [{ label: 'Duplicates', value: props.summary.duplicates }] : [])
])
</script>
<template>
  <dl class="queue-counts" :aria-label="t('Processing totals')">
    <div v-for="stat in stats" :key="stat.label">
      <dt>{{ t(stat.label) }}</dt>
      <dd>{{ stat.value }}</dd>
    </div>
  </dl>
</template>
<style scoped>
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
</style>
