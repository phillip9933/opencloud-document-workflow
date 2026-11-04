<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, watch, computed } from 'vue'
import { useRoute } from '../state/navigation'
import { aiTasks, useWorkspace, validateAIConfig } from '../state/workspace'
import GeneralSettings from '../components/GeneralSettings.vue'
import FolderSettings from '../components/FolderSettings.vue'
import OCRLanguages from '../components/OCRLanguages.vue'
import { useLocale } from '../state/locale'
import FilingSettings from '../components/FilingSettings.vue'
import MetadataSettings from './MetadataSettings.vue'
import ReliabilityStatus from '../components/ReliabilityStatus.vue'
import BackupSettings from '../components/BackupSettings.vue'
import type { Policy } from '../domain/review'
import {
  editableProcessingPolicy,
  processingMode,
  modeProcessingPolicy
} from '../domain/processing-policy'
import { discoverLocalModels } from '../domain/local-ai'
import type { LocalModel } from '../domain/local-ai'
const store = useWorkspace()
const { t } = useLocale()
const { policy, ai, connection, capabilities } = store
const route = useRoute()
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
const draft = ref(JSON.parse(JSON.stringify(ai.value)))
watch(ai, (value) => {
  draft.value = JSON.parse(JSON.stringify(value))
})
const message = ref(''),
  error = ref('')
const models = ref<LocalModel[]>([]),
  testing = ref(false),
  providerCustomizing = ref(false)
watch(
  () => draft.value.local.endpoint,
  () => {
    models.value = []
  }
)
async function saveProcessing() {
  try {
    const result = await store.savePreferences({
      policy: modeProcessingPolicy(draftPolicy.value, processingPreset.value),
      ai: { ...ai.value, tagDiscovery: draftDiscovery.value }
    })
    message.value = result.paused ? 'Saved. Ingestion paused.' : 'Saved'
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  }
}
async function testLocal() {
  if (testing.value) return
  testing.value = true
  message.value = ''
  error.value = ''
  try {
    models.value = connection.value
      ? (await store.request('models')).models
      : await discoverLocalModels(draft.value.local.endpoint)
    message.value = 'Connected'
  } catch (e) {
    models.value = []
    error.value = e instanceof Error ? e.message : 'Local connection failed'
  } finally {
    testing.value = false
  }
}
watch(
  () => route.value.params.section,
  () => {
    message.value = ''
    error.value = ''
  }
)
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

async function saveAI() {
  try {
    const result = await store.savePreferences({
      policy: policy.value,
      ai: validateAIConfig(JSON.parse(JSON.stringify(draft.value)))
    })
    error.value = ''
    message.value = result.paused ? 'Saved. Ingestion paused.' : 'Saved'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Invalid settings'
    message.value = ''
  }
}
const providerPreset = computed(() =>
  new Set(Object.values(draft.value.tasks)).size === 1 &&
  Object.values(draft.value.modelOverrides).every((value) => !String(value).trim())
    ? draft.value.tasks.facts
    : 'custom'
)
function chooseProvider(value: string) {
  providerCustomizing.value = value === 'custom'
  if (['off', 'local', 'cloud'].includes(value))
    for (const task of aiTasks) {
      draft.value.tasks[task.id] = value
      draft.value.modelOverrides[task.id] = ''
    }
}
const section = computed(() =>
  ['folders', 'ingestion', 'filing'].includes(String(route.value.params.section))
    ? 'folders'
    : ['ai', 'automation', 'processing'].includes(String(route.value.params.section))
      ? 'processing'
      : ['reliability', 'system'].includes(String(route.value.params.section))
        ? 'system'
        : String(route.value.params.section || 'general')
)
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
  <main class="screen settings-screen">
    <header class="screen-heading">
      <h1>{{ t('Settings') }}</h1>
    </header>
    <nav class="settings-tabs" :aria-label="t('Settings sections')">
      <RouterLink
        :aria-current="['general', 'appearance'].includes(section) ? 'page' : undefined"
        to="/document-workflow/settings"
        >{{ t('General') }}</RouterLink
      ><RouterLink
        :aria-current="section === 'folders' ? 'page' : undefined"
        to="/document-workflow/settings/folders"
        >{{ t('Folders') }}</RouterLink
      ><RouterLink
        :aria-current="section === 'processing' ? 'page' : undefined"
        to="/document-workflow/settings/processing"
        >{{ t('Processing') }}</RouterLink
      ><RouterLink
        :aria-current="section === 'metadata' ? 'page' : undefined"
        to="/document-workflow/settings/metadata"
        >{{ t('Fields & tags') }}</RouterLink
      ><RouterLink
        :aria-current="section === 'system' ? 'page' : undefined"
        to="/document-workflow/settings/system"
        >{{ t('System') }}</RouterLink
      >
    </nav>
    <GeneralSettings v-if="section === 'general' || section === 'appearance'" />
    <FolderSettings v-else-if="section === 'folders'" />
    <MetadataSettings v-else-if="section === 'metadata'" />
    <template v-else-if="section === 'system'"><ReliabilityStatus /><BackupSettings /></template>
    <template v-else>
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
            ><span v-if="processingPreset === 'automatic'" class="processing-state">{{
              t('On')
            }}</span
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
      <OCRLanguages />
      <details
        class="panel settings-disclosure model-section"
        :open="route.params.section === 'ai'"
      >
        <summary>{{ t('AI models') }}</summary>
        <form class="model-settings" @submit.prevent="saveAI">
          <div class="model-body">
            <label for="ai-provider">{{ t('Provider') }}</label
            ><select
              id="ai-provider"
              :value="providerCustomizing ? 'custom' : providerPreset"
              @change="chooseProvider(($event.target as HTMLSelectElement).value)"
            >
              <option value="off">{{ t('Off') }}</option>
              <option value="local">{{ t('Local AI') }}</option>
              <option value="cloud">{{ t('Cloud AI') }}</option>
              <option value="custom">{{ t('Custom') }}</option>
            </select>
            <section
              v-if="providerCustomizing || Object.values(draft.tasks).includes('local')"
              class="provider-fields"
            >
              <label for="local-endpoint">{{ t('Local endpoint') }}</label
              ><input id="local-endpoint" v-model="draft.local.endpoint" type="url" /><label
                for="local-model"
                >{{ t('Local model') }}</label
              >
              <div class="model-input">
                <input id="local-model" v-model="draft.local.model" list="local-models" /><datalist
                  id="local-models"
                >
                  <option v-for="model in models" :key="model.name" :value="model.name" /></datalist
                ><button type="button" class="button" :disabled="testing" @click="testLocal">
                  {{ t('Check') }}
                </button>
              </div>
            </section>
            <section v-if="Object.values(draft.tasks).includes('cloud')" class="provider-fields">
              <p v-if="!capabilities.cloudEnabled" class="warning">
                {{ t('Cloud provider is not configured') }}
              </p>
              <label for="cloud-endpoint">{{ t('Cloud endpoint') }}</label
              ><input id="cloud-endpoint" v-model="draft.cloud.endpoint" type="url" /><label
                for="cloud-model"
                >{{ t('Cloud model') }}</label
              ><input id="cloud-model" v-model="draft.cloud.model" />
            </section>
            <section
              v-if="providerCustomizing || providerPreset === 'custom'"
              class="advanced-settings task-routing"
            >
              <h3>{{ t('Task routing') }}</h3>
              <div v-for="task in aiTasks" :key="task.id" class="setting-row">
                <label :for="`task-${task.id}`">{{ t(task.label) }}</label>
                <div class="task-controls">
                  <select :id="`task-${task.id}`" v-model="draft.tasks[task.id]">
                    <option value="off">{{ t('Off') }}</option>
                    <option value="local">{{ t('Local AI') }}</option>
                    <option value="cloud">{{ t('Cloud AI') }}</option></select
                  ><input
                    v-model="draft.modelOverrides[task.id]"
                    :aria-label="t('Model for {task}', { task: t(task.label) })"
                    :disabled="draft.tasks[task.id] === 'off'"
                    :placeholder="t('Default model')"
                  />
                </div>
              </div>
            </section>
          </div>
          <div class="settings-footer">
            <button class="button primary">{{ t('Save') }}</button>
          </div>
        </form>
      </details>
      <details class="panel settings-disclosure capacity-section">
        <summary>{{ t('Processing capacity') }}</summary>
        <div class="capacity-body"><FilingSettings mode="capacity" /></div>
      </details>
    </template>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
    <p v-if="message" role="status" class="message">{{ t(message) }}</p>
  </main>
</template>
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
.screen.settings-screen {
  --settings-content-width: 900px;
  max-width: 980px;
}
.settings-screen > .screen-heading,
.settings-screen > .settings-tabs,
.settings-screen > :deep(.panel),
.settings-screen > :deep(.folder-settings),
.settings-screen > :deep(.error),
.settings-screen > :deep(.message) {
  width: 100%;
  max-width: var(--settings-content-width);
  min-width: 0;
}
.settings-screen > :deep(.panel) {
  padding: 24px;
  margin-bottom: 22px;
}
.screen-heading h1 {
  margin: 0;
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
label {
  display: block;
  margin: 16px 0 8px;
  font-size: 13px;
}
label:first-child {
  margin-top: 0;
}
.automation-panel > select,
.model-body > select {
  display: block;
  width: 100%;
  max-width: 360px;
}
.settings-disclosure > summary {
  cursor: pointer;
  color: var(--ink);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  padding: 0;
}
.settings-disclosure > summary::marker {
  color: var(--muted);
}
.settings-disclosure > summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 5px;
  border-radius: 2px;
}
.settings-disclosure > summary:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
.model-settings,
.capacity-body {
  margin-top: 20px;
  border-top: 1px solid var(--line);
  padding-top: 20px;
}
.model-body {
  min-width: 0;
}
.capacity-body :deep(.filing-settings) {
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  border-radius: 0;
}
.provider-fields {
  margin-top: 20px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.provider-fields input {
  width: 100%;
}
.model-input {
  display: flex;
  gap: 10px;
  align-items: center;
}
.model-input input {
  flex: 1;
  min-width: 0;
}
.advanced-settings {
  margin-top: 20px;
  border-top: 1px solid var(--line);
  padding-top: 4px;
}
.setting-row {
  padding: 16px 0;
  gap: 24px;
}
.setting-row > div {
  min-width: 0;
}
.setting-row label {
  margin: 0;
}
.task-routing {
  padding-top: 20px;
}
.task-routing h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin: 0 0 8px;
}
.task-routing .setting-row:first-of-type {
  border-top: 0;
}
.automation-panel > .settings-footer,
.model-settings > .settings-footer {
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
@media (max-width: 700px) {
  .settings-screen > :deep(.panel) {
    padding: 20px;
  }
  .setting-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
  .setting-row > select {
    width: 100%;
  }
  .tag-discovery-setting .setting-row {
    grid-template-columns: 1fr;
  }
  .task-controls {
    width: 100%;
    justify-content: flex-start;
  }
  .task-controls select {
    flex: 1;
    min-width: 120px;
  }
  .task-controls input {
    flex: 1;
    min-width: 140px;
  }
}
</style>
