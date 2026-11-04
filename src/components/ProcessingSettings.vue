<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, watch, computed } from 'vue'
import { useLocale } from '../state/locale'
import { useWorkspace } from '../state/workspace'
import type { Policy } from '../domain/review'
import {
  editableProcessingPolicy,
  processingMode,
  modeProcessingPolicy
} from '../domain/processing-policy'
const store = useWorkspace()
const { policy, ai } = store
const { t } = useLocale()
const emit = defineEmits<{ saved: [message: string]; error: [message: string] }>()
const draftPolicy = ref<Policy>(editableProcessingPolicy(policy.value))
const processingPreset = ref(processingMode(policy.value))
watch(policy, (value) => {
  draftPolicy.value = editableProcessingPolicy(value)
  processingPreset.value = processingMode(value)
})
const draftDiscovery = ref(ai.value.tagDiscovery ?? 'off')
watch(ai, (value) => {
  draftDiscovery.value = value.tagDiscovery ?? 'off'
})
async function saveProcessing() {
  try {
    const result = await store.savePreferences({
      policy: modeProcessingPolicy(draftPolicy.value, processingPreset.value),
      ai: { ...ai.value, tagDiscovery: draftDiscovery.value }
    })
    emit('saved', result.paused ? 'Saved. Ingestion paused.' : 'Saved')
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Save failed')
  }
}
const features: { key: keyof Policy; label: string; detail: string; choices: string[] }[] = [
  {
    key: 'fields',
    label: 'Custom fields',
    detail:
      'Fill unambiguous extracted fields automatically or leave suggestions for review; existing values are preserved.',
    choices: ['Off', 'Suggest fields', 'Fill fields automatically']
  },
  {
    key: 'rename',
    label: 'Filenames',
    detail: 'Derive a filename from the verified sender, date and document type.',
    choices: ['Keep current name', 'Suggest name', 'Rename automatically']
  },
  {
    key: 'move',
    label: 'Folders',
    detail: 'Suggest a destination using the document’s evidence-backed category.',
    choices: ['Keep current folder', 'Suggest folder', 'Move automatically']
  }
]
const aiEnabled = computed({
  get: () => draftPolicy.value.aiInput !== 'off' && draftPolicy.value.aiOutput !== 'off',
  set: (enabled: boolean) => {
    draftPolicy.value.aiInput = draftPolicy.value.aiOutput = enabled ? 'suggest' : 'off'
  }
})
const ocrEnabled = computed({
  get: () => draftPolicy.value.ocr !== 'off',
  set: (enabled: boolean) => {
    draftPolicy.value.ocr = enabled ? 'automatic' : 'off'
  }
})

function chooseProcessing(value: string) {
  processingPreset.value = value === 'automatic' ? 'automatic' : 'review'
  draftPolicy.value = modeProcessingPolicy(draftPolicy.value, processingPreset.value)
}
const tagMethod = computed({
  get: () =>
    draftPolicy.value.tags === 'off' ? 'disabled' : !aiEnabled.value ? 'off' : draftDiscovery.value,
  set: (value: string) => {
    if (value === 'disabled') draftPolicy.value.tags = 'off'
    else {
      draftPolicy.value.tags = processingPreset.value === 'automatic' ? 'automatic' : 'suggest'
      draftDiscovery.value = value as 'off' | 'existing' | 'create'
    }
  }
})
</script>
<template>
  <section class="panel automation-panel">
    <h2>{{ t('Document processing') }}</h2>
    <label for="processing-mode">{{ t('Processing mode') }}</label
    ><select
      id="processing-mode"
      :value="processingPreset"
      @change="chooseProcessing(($event.target as HTMLSelectElement).value)"
    >
      <option value="review">{{ t('Review first') }}</option>
      <option value="automatic">{{ t('Fully automatic') }}</option>
    </select>
    <p class="mode-description">
      {{
        t(
          processingPreset === 'automatic'
            ? 'Apply names, folders, fields and tags without review. Uncertain results stay in the inbox.'
            : 'Prepare the selected suggestions. Nothing is filed until you accept.'
        )
      }}
    </p>
    <div class="advanced-settings">
      <div class="setting-row">
        <label for="ai-processing">{{ t('AI processing') }}</label
        ><span v-if="processingPreset === 'automatic'" class="processing-state">{{ t('On') }}</span
        ><select
          v-else
          id="ai-processing"
          :value="aiEnabled ? 'on' : 'off'"
          @change="aiEnabled = ($event.target as HTMLSelectElement).value === 'on'"
        >
          <option value="off">{{ t('Off') }}</option>
          <option value="on">{{ t('On') }}</option>
        </select>
      </div>
      <p v-if="!aiEnabled" class="mode-description" role="status">
        {{ t('OCR and extraction rules remain active. AI suggestions are off.') }}
      </p>
      <div class="setting-row">
        <div>
          <label for="ocr">{{ t('OCR') }}</label>
          <p class="step-description">
            {{ t('Read scanned pages when embedded text is missing.') }}
          </p>
        </div>
        <select
          id="ocr"
          :value="ocrEnabled ? 'on' : 'off'"
          @change="ocrEnabled = ($event.target as HTMLSelectElement).value === 'on'"
        >
          <option value="off">{{ t('Off') }}</option>
          <option value="on">{{ t('On') }}</option>
        </select>
      </div>
      <div
        v-for="feature in features"
        :key="feature.key"
        class="setting-row"
        :class="{ 'processing-inactive': !aiEnabled && feature.key !== 'fields' }"
      >
        <label :for="processingPreset === 'review' ? feature.key : undefined"
          >{{ t(feature.label)
          }}<small v-if="feature.key === 'fields'" class="step-description">{{
            t('Match printed labels in extracted text.')
          }}</small></label
        ><span v-if="processingPreset === 'automatic'" class="processing-state">{{
          t('Automated')
        }}</span
        ><select
          v-else
          :id="feature.key"
          :disabled="!aiEnabled && feature.key !== 'fields'"
          :value="draftPolicy[feature.key] === 'off' ? 'off' : 'suggest'"
          @change="
            draftPolicy[feature.key] = ($event.target as HTMLSelectElement).value as
              'off' | 'suggest'
          "
        >
          <option value="off">{{ t(feature.choices[0]!) }}</option>
          <option value="suggest">{{ t(feature.choices[1]!) }}</option>
        </select>
      </div>
    </div>
    <section class="tag-discovery-setting">
      <h3>{{ t('Tags') }}</h3>
      <p class="mode-description">
        {{
          t(
            processingPreset === 'automatic'
              ? 'Tags are applied automatically. Choose how they are selected.'
              : 'Choose which tags to suggest for review, or turn tagging off.'
          )
        }}
      </p>
      <div class="setting-row">
        <label for="tag-discovery">{{ t('Tag selection') }}</label
        ><select id="tag-discovery" v-model="tagMethod" aria-describedby="tag-discovery-help">
          <option v-if="processingPreset === 'review'" value="disabled">{{ t('Off') }}</option>
          <option value="off">{{ t('Matching rules only') }}</option>
          <option v-if="aiEnabled" value="existing">
            {{ t('Matching rules + AI: existing tags') }}
          </option>
          <option v-if="aiEnabled" value="create">
            {{ t('Matching rules + AI: existing and new tags') }}
          </option>
        </select>
      </div>
      <p id="tag-discovery-help" class="mode-description">
        {{
          t(
            'Rules match your saved terms. AI also checks the document’s subject, reusing related tags before proposing new ones.'
          )
        }}
      </p>
    </section>
    <div class="settings-footer">
      <button class="button primary" :aria-label="t('Save processing')" @click="saveProcessing">
        {{ t('Save') }}
      </button>
    </div>
  </section>
</template>
<style scoped src="./settings-controls.css"></style>
<style scoped>
.processing-inactive {
  opacity: 0.5;
}
.processing-state {
  justify-self: end;
  color: var(--muted);
  font-size: 13px;
  padding: 8px 0;
}
.mode-description {
  font-size: 13px;
  max-width: 660px;
  line-height: 1.6;
}
.step-description {
  display: block;
  font-size: 12px !important;
  font-weight: 400 !important;
  max-width: 520px;
  line-height: 1.6;
}
.tag-discovery-setting {
  margin-top: 24px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}
.tag-discovery-setting h3 {
  font-size: 15px;
  margin: 20px 0 8px;
}
.tag-discovery-setting select {
  max-width: 100%;
  width: 100%;
}
.tag-discovery-setting .setting-row {
  margin-top: 16px;
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(0, 2fr);
  align-items: center;
}
@media (max-width: 700px) {
  .tag-discovery-setting .setting-row {
    grid-template-columns: 1fr;
  }
}
</style>
