<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import DestinationPicker from './DestinationPicker.vue'
import { useLocale } from '../state/locale'
import type { Review } from '../domain/review'
import type { DraftJob } from '../state/workspace'
defineProps<{
  active: Review
  job?: DraftJob
  planned: { target: string; targetSpace?: string; addTags: string[] } | null
  manual: boolean
  manualTarget: string
  documentPath?: string
  documentSpace?: string
  spaces: { id: string; name: string }[]
  disabled: boolean
  filingProblem: string
  destinationBlocked: boolean
}>()
const emit = defineEmits<{ edit: []; reset: []; target: [value: string] }>()
const { t } = useLocale()
</script>
<template>
  <section class="review-step">
    <div class="step-heading">
      <h2>{{ t('Filing') }}</h2>
      <button
        v-if="job && !job.decision && !active.bundle.manualReview"
        class="icon-button"
        :disabled="disabled"
        :aria-label="t(manual ? 'Use suggestions' : 'Edit filing')"
        :title="t(manual ? 'Use suggestions' : 'Edit filing')"
        @click="manual ? emit('reset') : emit('edit')"
      >
        {{ manual ? '↶' : '✎' }}
      </button>
    </div>
    <template v-if="manual"
      ><label for="manual-target">{{ t('Folder and filename') }}</label
      ><DestinationPicker
        :key="job?.id || active.bundle.source.resourceId"
        :model-value="manualTarget"
        :root="active.bundle.rules?.root || 'Filed'"
        :space="
          planned?.targetSpace || active.bundle.destinationSpace || active.bundle.source.space
        "
        :filename="active.bundle.source.path.split('/').pop()!"
        :disabled="disabled"
        @update:model-value="emit('target', $event)"
    /></template>
    <dl v-else-if="planned" class="filing suggested-destination">
      <dt>{{ t(job?.decision === 'done' ? 'Filename' : 'Suggested filename') }}</dt>
      <dd class="suggested-filename">
        {{ (job?.decision === 'done' ? documentPath : planned.target)?.split('/').pop() }}
      </dd>
      <dt>{{ t(job?.decision === 'done' ? 'Folder' : 'Suggested folder') }}</dt>
      <dd class="target">
        <span v-if="planned.targetSpace"
          >{{
            spaces.find((space) => space.id === planned.targetSpace)?.name || planned.targetSpace
          }}
          / </span
        >{{
          (job?.decision === 'done' ? documentPath : planned.target)
            ?.split('/')
            .slice(0, -1)
            .join('/')
        }}
      </dd>
    </dl>
    <p v-if="filingProblem" role="alert" class="error">{{ t(filingProblem) }}</p>
    <p v-if="destinationBlocked" class="error">{{ t('Destination already exists') }}</p>
    <p v-if="active.ruleAmbiguous" class="error">{{ t('Several filing rules match') }}</p>
    <RouterLink
      v-if="job?.decision === 'done' && documentPath"
      class="button subtle"
      :to="{
        path: '/document-workflow/details',
        query: { path: documentPath, return: 'filed', job: job.id, space: documentSpace }
      }"
      >{{ t('Edit details') }}</RouterLink
    >
  </section>
</template>
<style scoped>
.review-step h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 15px;
}
.step-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.step-heading .icon-button {
  width: 30px;
  height: 30px;
  font-size: 17px;
}
.review-step > p {
  font-size: 12px;
}
.filing {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
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
.suggested-filename {
  font-weight: 600;
}
.target {
  font-weight: 500;
  color: var(--accent-text);
}
label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin: 14px 0 6px;
}
@media (max-width: 850px) {
  .filing {
    grid-template-columns: 85px minmax(0, 1fr);
  }
}
</style>
