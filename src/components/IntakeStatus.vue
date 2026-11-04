<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue'
import { useLocale } from '../state/locale'
const { t, formatDate } = useLocale()
import type { IntakeHealth, IntakeRecord } from '../state/workspace'
const props = defineProps<{
  enabled: boolean
  attached: boolean
  health?: IntakeHealth
  queue?: IntakeRecord[]
}>()
const state = computed(
  () =>
    props.health?.state ??
    (!props.enabled ? 'paused' : props.attached ? 'starting' : 'waiting_for_session')
)
const title = computed(() =>
  props.health?.manualCheck === 'settling'
    ? 'Waiting for uploads to finish…'
    : props.health?.manualCheck
      ? 'Checking inbox and preparing documents'
      : props.enabled && props.health?.manualOnly && ['ready', 'starting'].includes(state.value)
        ? 'Manual checks only'
        : {
            paused: 'Automatic preparation paused',
            pausing: 'Pausing after the current document',
            waiting_for_session: 'Waiting for OpenCloud sign-in',
            running: 'Checking inbox and preparing documents',
            resuming: 'Reconnecting background processing',
            held: 'Inbox check needs attention',
            ready: 'Background preparation ready',
            starting: 'Waiting for the first inbox check'
          }[state.value]
)
const attention = computed(() => props.queue?.filter((item) => item.state === 'failed').length ?? 0)
</script>
<template>
  <section
    class="intake-health"
    :class="{ attention: state === 'held' || state === 'waiting_for_session' }"
    :aria-label="t('Background status')"
  >
    <strong role="status">{{ t(title || 'Processing') }}</strong>
    <p v-if="state === 'held' && health?.message">{{ t(health.message) }}</p>
    <p v-else-if="state === 'waiting_for_session'">{{ t('Sign in to reconnect processing') }}</p>
    <p v-if="health?.lastSuccess" class="last-check">
      {{ t('Last check: {time}', { time: formatDate(health.lastSuccess) }) }}
    </p>
    <p v-if="attention">{{ t('{count} need attention', { count: attention }) }}</p>
  </section>
</template>
<style scoped>
.intake-health {
  margin: 16px 0;
  padding: 12px 14px;
  border-left: 3px solid var(--success-border);
  background: var(--subtle);
  border-radius: 4px;
}
.intake-health.attention {
  border-color: var(--warning-border);
  background: var(--warning-bg);
}
.intake-health strong {
  font-size: 13px;
}
.intake-health p {
  font-size: 12px;
  margin: 7px 0 0;
}
.last-check {
  color: var(--muted);
  font-size: 11px !important;
}
</style>
