<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { canContinueFiling, needsFilingVerification } from '../domain/decision-state'
import { useLocale } from '../state/locale'
import type { DraftJob } from '../state/workspace'
defineProps<{
  job?: DraftJob
  disabled: boolean
  acceptDisabled: boolean
  fieldsUncertain: boolean
  fieldEditsPending: boolean
  previewChanged: boolean
  busy: boolean
  preparingFresh: boolean
  exportDisabled: boolean
  verification: { checkedAt: string; resourceId: string; sha256: string } | null
}>()
const emit = defineEmits<{
  decide: [action: 'file' | 'reject' | 'apply' | 'reconcile']
  takeOver: []
  export: []
}>()
const { t, formatDate } = useLocale()
</script>
<template>
  <section class="decision-actions">
    <p v-if="job?.automation?.state === 'held'" class="error">
      {{ t(job.automation.detail || 'Needs attention') }}
    </p>
    <template v-if="job"
      ><template v-if="job.automation?.state === 'done' && !job.decision"
        ><span class="pill">{{ t('Processed') }}</span></template
      ><template v-else-if="!job.decision"
        ><p v-if="previewChanged" class="error">{{ t('Document changed') }}</p>
        <p v-if="fieldEditsPending" class="error">
          {{ t('Save field changes before filing') }}
        </p>
        <div class="action-buttons">
          <button class="button primary" :disabled="acceptDisabled" @click="emit('decide', 'file')">
            {{ t(busy && !preparingFresh ? 'Saving…' : 'Accept') }}</button
          ><button class="button subtle" :disabled="disabled" @click="emit('decide', 'reject')">
            {{ t('Reject') }}
          </button>
        </div></template
      ><template v-else-if="canContinueFiling(job.decision)"
        ><button
          v-if="job.approval?.automaticAuthorization"
          class="button"
          :disabled="disabled"
          @click="emit('takeOver')"
        >
          {{ t('Take over') }}</button
        ><button
          v-else
          class="button primary"
          :disabled="disabled || fieldsUncertain"
          @click="emit('decide', 'apply')"
        >
          {{ t(busy ? 'Filing…' : 'Continue filing') }}
        </button></template
      ><template v-else-if="needsFilingVerification(job.decision)"
        ><button class="button" :disabled="disabled" @click="emit('decide', 'reconcile')">
          {{ t('Verify outcome') }}
        </button></template
      ><template v-else-if="job.decision === 'done'"
        ><button
          class="button"
          :disabled="disabled || fieldsUncertain"
          @click="emit('decide', 'reconcile')"
        >
          {{ t('Verify file') }}
        </button>
        <details v-if="verification">
          <summary>{{ t('Verification') }}</summary>
          <p>{{ formatDate(verification.checkedAt) }}</p>
          <dl class="filing">
            <template v-if="job?.conversion"
              ><dt>{{ t('Archived original') }}</dt>
              <dd>{{ job.conversion.archivePath }}</dd></template
            >
            <dt>{{ t('Resource') }}</dt>
            <dd>{{ verification.resourceId }}</dd>
            <dt>SHA256</dt>
            <dd>{{ verification.sha256 }}</dd>
          </dl>
        </details></template
      ><template v-else></template></template
    ><button v-else class="button" :disabled="exportDisabled" @click="emit('export')">
      {{ t('Export record') }}
    </button>
  </section>
</template>
<style scoped>
.decision-actions {
  padding: 18px 0;
}
.action-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.decision-actions > .button {
  margin-top: 16px;
}
summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  padding: 6px 0;
}
.filing {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 10px;
  margin: 20px 0 12px;
  font-size: 13px;
}
dt {
  color: var(--muted);
  font-size: 12px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 850px) {
  .filing {
    grid-template-columns: 85px minmax(0, 1fr);
  }
}
</style>
