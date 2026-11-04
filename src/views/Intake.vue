<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, computed, onMounted } from 'vue'
import { useWorkspace, preparationProblem } from '../state/workspace'
import { useLocale } from '../state/locale'
const store = useWorkspace(),
  { t } = useLocale(),
  configuration = ref({
    enabled: false,
    folder: 'Inbox',
    recursive: true,
    intervalSeconds: 30,
    settleSeconds: 10,
    cloudConsent: false
  }),
  error = ref(''),
  message = ref(''),
  busy = ref(false),
  pickerOpen = ref(false),
  pickerPath = ref(''),
  folders = ref<{ path: string }[]>([]),
  destination = ref('Filed'),
  baseline = ref(''),
  configured = ref(false),
  duplicateAction = ref('keep'),
  destinationSpace = ref('')
const automaticInterval = ref(30),
  automatic = computed({
    get: () => configuration.value.intervalSeconds !== 0,
    set: (enabled: boolean) => {
      if (!enabled) {
        automaticInterval.value = configuration.value.intervalSeconds || 30
        configuration.value.intervalSeconds = 0
      } else configuration.value.intervalSeconds = automaticInterval.value
    }
  })
const readiness = computed(() =>
    preparationProblem(store.storedPreferences.value, store.capabilities.value.cloudEnabled)
  ),
  dirty = computed(
    () =>
      !configured.value ||
      JSON.stringify([configuration.value, duplicateAction.value]) !== baseline.value
  )
async function load() {
  busy.value = true
  try {
    if (!store.connection.value) await store.connect()
    const value = await store.request('intake')
    if (!value?.configuration?.folder) throw new Error('Inbox settings unavailable')
    configuration.value = value.configuration
    duplicateAction.value = value.duplicateAction ?? 'keep'
    configured.value = value.configured ?? true
    baseline.value = JSON.stringify([value.configuration, duplicateAction.value])
    destination.value = value.destinationRoot ?? 'Filed'
    destinationSpace.value = value.destinationSpace ?? store.connection.value?.space ?? ''
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load settings'
  } finally {
    busy.value = false
  }
}
async function browse(path: string) {
  busy.value = true
  error.value = ''
  try {
    const value = await store.request('files', { path })
    pickerPath.value = path
    folders.value = value.files.filter(
      (file: any) =>
        file.folder &&
        (destinationSpace.value !== store.connection.value?.space ||
          (file.path !== destination.value && !file.path.startsWith(destination.value + '/')))
    )
    pickerOpen.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Folder unavailable'
  } finally {
    busy.value = false
  }
}
async function save() {
  if (busy.value) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    if (configuration.value.enabled && readiness.value) throw new Error(readiness.value)
    if (
      configuration.value.enabled &&
      store.cloudProcessing.value &&
      !configuration.value.cloudConsent
    )
      throw new Error('Allow cloud processing for this inbox before enabling it')
    await store.request('intake-settings', {
      configuration: JSON.parse(JSON.stringify(configuration.value)),
      duplicateAction: duplicateAction.value
    })
    baseline.value = JSON.stringify([configuration.value, duplicateAction.value])
    configured.value = true
    await store.connect()
    message.value = 'Saved'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    busy.value = false
  }
}
onMounted((): void => {
  void load()
})
function chooseInboxFolder() {
  configuration.value.folder = pickerPath.value
  pickerOpen.value = false
}
</script>
<template>
  <section class="intake-settings">
    <form @submit.prevent="save">
      <label for="intake-folder">{{ t('Inbox folder') }}</label>
      <div class="folder-input">
        <input id="intake-folder" v-model="configuration.folder" /><button
          type="button"
          class="button"
          :disabled="busy"
          @click="browse('')"
        >
          {{ t('Choose') }}
        </button>
      </div>
      <section v-if="pickerOpen" class="folder-picker" :aria-label="t('Choose folder')">
        <div class="folder-path">
          <button
            v-if="pickerPath"
            type="button"
            class="icon-button"
            :aria-label="t('Parent folder')"
            @click="browse(pickerPath.split('/').slice(0, -1).join('/'))"
          >
            ↑</button
          ><span>{{ pickerPath || store.spaceName() }}</span>
        </div>
        <button
          v-for="folder in folders"
          :key="folder.path"
          type="button"
          class="folder-choice"
          @click="browse(folder.path)"
        >
          <span aria-hidden="true">▱ </span>{{ folder.path.split('/').pop() }}
        </button>
        <div class="picker-actions">
          <button
            type="button"
            class="button primary"
            :disabled="!pickerPath || busy"
            @click="chooseInboxFolder"
          >
            {{ t('Use this folder') }}</button
          ><button type="button" class="button subtle" @click="pickerOpen = false">
            {{ t('Cancel') }}
          </button>
        </div>
      </section>
      <label class="check-label"
        ><input v-model="configuration.enabled" type="checkbox" />{{
          t('Process new arrivals')
        }}</label
      ><label class="check-label"
        ><input v-model="configuration.recursive" type="checkbox" />{{
          t('Include subfolders')
        }}</label
      >
      <p v-if="configuration.enabled && readiness" class="error">
        {{ t(readiness) }}
        <RouterLink to="/document-workflow/settings/ai">{{ t('Models') }}</RouterLink>
      </p>
      <label v-if="store.cloudProcessing.value" class="check-label"
        ><input v-model="configuration.cloudConsent" type="checkbox" />{{
          t('Allow cloud processing for this inbox')
        }}</label
      ><label for="duplicate-action">{{ t('Exact duplicates') }}</label
      ><select id="duplicate-action" v-model="duplicateAction" :disabled="busy">
        <option value="keep">{{ t('Keep for review') }}</option>
        <option value="trash">{{ t('Move to OpenCloud Trash') }}</option>
      </select>
      <p class="fine-print">
        {{ t('Only byte-identical files. Separate scans and recurring bills stay separate.') }}
      </p>
      <details class="timing-settings">
        <summary>{{ t('Timing') }}</summary>
        <div class="timing-body">
          <label class="check-label"
            ><input v-model="automatic" type="checkbox" />{{ t('Check automatically') }}</label
          >
          <p v-if="!automatic" class="fine-print manual-check-note">
            {{ t('Use Check now in the Inbox. Automatic checks are off.') }}
          </p>
          <div class="timing-grid">
            <div v-if="automatic" class="timing-field">
              <label for="intake-check-interval">{{ t('Check every (seconds)') }}</label
              ><input
                id="intake-check-interval"
                v-model.number="configuration.intervalSeconds"
                type="number"
                min="0"
                max="86400"
              />
            </div>
            <div class="timing-field">
              <label for="intake-settle-time">{{ t('Upload settling time (seconds)') }}</label
              ><input
                id="intake-settle-time"
                v-model.number="configuration.settleSeconds"
                type="number"
                min="2"
                max="3600"
                aria-describedby="intake-settle-help"
              />
              <p id="intake-settle-help" class="fine-print">
                {{
                  t(
                    'Wait until a file stays unchanged for this long before processing it. This gives uploads and scans time to finish.'
                  )
                }}
              </p>
            </div>
          </div>
        </div>
      </details>
      <div class="settings-footer">
        <button class="button primary" :disabled="busy || !dirty">{{ t('Save') }}</button>
      </div>
    </form>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
    <p v-if="message" role="status" class="message">{{ t(message) }}</p>
  </section>
</template>
<style scoped>
.intake-settings {
  max-width: 900px;
}
label {
  display: block;
  margin: 16px 0 8px;
}
label:first-child {
  margin-top: 0;
}
.intake-settings .check-label {
  align-items: center;
  gap: 10px;
  margin: 14px 0;
}
.intake-settings .check-label input {
  margin: 0;
  flex: none;
}
.folder-input {
  display: flex;
  gap: 10px;
}
.folder-input input {
  min-width: 0;
  flex: 1;
}
.folder-picker {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 16px;
  margin: 16px 0;
}
.folder-path,
.picker-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.folder-path {
  margin-bottom: 12px;
}
.folder-choice {
  display: block;
  width: 100%;
  padding: 10px;
  text-align: left;
  background: transparent;
  border: 0;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.folder-choice:hover {
  background: var(--subtle);
}
.picker-actions {
  margin-top: 12px;
}
.timing-settings {
  margin-top: 24px;
}
.timing-settings > summary {
  width: fit-content;
  max-width: 100%;
  padding: 4px 0;
  cursor: pointer;
  color: var(--accent-text);
  font-weight: 600;
}
.timing-settings > summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 4px;
  border-radius: 2px;
}
.timing-settings > summary:focus:not(:focus-visible) {
  outline: none;
}
.timing-body {
  padding-top: 8px;
}
.timing-body > .check-label {
  margin: 8px 0 18px;
}
.timing-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
}
.timing-field {
  min-width: 0;
}
.timing-field > label {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
}
.timing-field > input {
  display: block;
  width: 100%;
}
.timing-field > .fine-print {
  margin-top: 8px;
  line-height: 1.6;
}
.manual-check-note {
  margin: 0 0 18px !important;
}
.settings-footer {
  margin-top: 24px;
}
@media (max-width: 700px) {
  .timing-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
}
</style>
