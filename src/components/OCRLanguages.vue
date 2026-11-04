<script setup lang="ts">
import { WorkflowError } from '../domain/errors'

// SPDX-License-Identifier: AGPL-3.0-only
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
const store = useWorkspace(),
  { t, locale } = useLocale(),
  installed = ref<string[]>([]),
  selected = ref<string[]>([]),
  baseline = ref('[]'),
  catalog = ref<any>(null),
  search = ref(''),
  managing = ref(false),
  busy = ref(false),
  error = ref(''),
  message = ref('')
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined
const primary = computed({
    get: () => selected.value[0] ?? '',
    set: (value: string) => {
      selected.value = [value, ...selected.value.filter((code) => code !== value)]
    }
  }),
  dirty = computed(() => JSON.stringify(selected.value) !== baseline.value)
function name(code: string) {
  try {
    return new Intl.DisplayNames([locale.value], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
const packs = computed(
  () =>
    catalog.value?.packs.filter(
      (p: any) =>
        !p.installed &&
        `${name(p.code)} ${p.code}`.toLowerCase().includes(search.value.toLowerCase())
    ) ?? []
)
async function load() {
  try {
    const result = await store.request('ocr-languages')
    if (!alive) return
    if (!Array.isArray(result.installed) || !Array.isArray(result.selected))
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'OCR language list unavailable')
    installed.value = result.installed
    if (!dirty.value) {
      selected.value = result.selected
      baseline.value = JSON.stringify(result.selected)
    }
    error.value = ''
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'OCR unavailable'
  }
}
async function manage() {
  managing.value = !managing.value
  if (managing.value) await refreshCatalog()
}
async function refreshCatalog() {
  try {
    const result = await store.request('ocr-packs')
    if (!alive) return
    catalog.value = result
    if (result.installation.state === 'installing')
      timer = setTimeout(() => void refreshCatalog(), 1500)
    else if (result.installation.state === 'installed') {
      await load()
      message.value = 'Language installed'
    } else if (result.installation.state === 'held') error.value = result.installation.message
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'OCR unavailable'
  }
}
async function install(code: string) {
  if (busy.value || catalog.value?.installation.state === 'installing') return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    catalog.value = await store.request('ocr-pack-install', { code })
    await refreshCatalog()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Installation failed'
  } finally {
    busy.value = false
  }
}
async function save() {
  if (busy.value || !dirty.value) return
  busy.value = true
  error.value = ''
  try {
    await store.request('ocr-settings', { languages: [...selected.value] })
    baseline.value = JSON.stringify(selected.value)
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
onBeforeUnmount(() => {
  alive = false
  clearTimeout(timer)
})
</script>
<template>
  <section class="panel ocr-language-settings">
    <div class="section-heading">
      <h2>{{ t('OCR languages') }}</h2>
    </div>
    <p>
      {{ t('Languages used to read scanned pages. AI model languages are configured separately.') }}
    </p>
    <div class="language-choices">
      <label v-for="code in installed" :key="code" class="check-label"
        ><input v-model="selected" :value="code" type="checkbox" :disabled="busy" />{{
          name(code)
        }}</label
      >
    </div>
    <p v-if="!installed.length">{{ t('No OCR languages available') }}</p>
    <label v-if="selected.length > 1" class="primary-language"
      >{{ t('Primary language')
      }}<select v-model="primary" :aria-label="t('Primary OCR language')" :disabled="busy">
        <option v-for="code in selected" :key="code" :value="code">{{ name(code) }}</option>
      </select></label
    >
    <div class="settings-footer">
      <button class="button primary" :disabled="busy || !dirty" @click="save">
        {{ t('Save languages') }}</button
      ><button
        class="button subtle manage-languages"
        :disabled="busy"
        :aria-expanded="managing"
        aria-controls="ocr-language-manager"
        @click="manage"
      >
        {{ t('Manage languages') }}
        <span aria-hidden="true" :class="{ expanded: managing }">▾</span>
      </button>
    </div>
    <section v-if="managing" id="ocr-language-manager" class="language-manager">
      <h3>{{ t('Add OCR languages') }}</h3>
      <p v-if="catalog && !catalog.canManage">
        {{ t('An OpenCloud administrator can install language packs here.') }}
      </p>
      <p v-else-if="catalog && !catalog.enabled">
        {{ t('Language installation needs a writable OCR data folder on the companion.') }}
      </p>
      <template v-else-if="catalog"
        ><p>
          {{
            t(
              'Official Tesseract packs are installed on this server and available to all workspaces.'
            )
          }}
        </p>
        <input
          v-model="search"
          type="search"
          :aria-label="t('Search languages')"
          :placeholder="t('Search languages')"
        />
        <p v-if="catalog.installation.state === 'installing'" role="status">
          {{ t('Installing {language}…', { language: name(catalog.installation.code) }) }}
        </p>
        <div class="pack-list">
          <div v-for="pack in packs" :key="pack.code" class="pack-row">
            <span>{{ name(pack.code) }}</span
            ><small>{{ (pack.bytes / 1048576).toFixed(1) }} MB</small
            ><button
              class="button"
              :disabled="busy || catalog.installation.state === 'installing'"
              :aria-label="t('Install {language}', { language: name(pack.code) })"
              @click="install(pack.code)"
            >
              {{ t('Install') }}
            </button>
          </div>
        </div></template
      >
    </section>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
    <p v-if="message" role="status">{{ t(message) }}</p>
  </section>
</template>
<style scoped>
.panel.ocr-language-settings {
  width: 100%;
  max-width: var(--settings-content-width, 900px);
  padding: 24px;
  margin-bottom: 22px;
  min-width: 0;
}
.ocr-language-settings > .settings-footer {
  justify-content: flex-start;
  align-items: center;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
.ocr-language-settings > .settings-footer .button {
  max-width: 100%;
}
.manage-languages {
  display: inline-flex;
  align-items: center;
}
.manage-languages span {
  display: inline-block;
  margin-left: 6px;
}
.manage-languages span.expanded {
  transform: rotate(180deg);
}
.manage-languages:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.manage-languages:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
.section-heading {
  display: flex;
  align-items: center;
  gap: 16px;
}
.section-heading h2 {
  margin: 0;
}
.ocr-language-settings > p {
  font-size: 13px;
  line-height: 1.6;
  max-width: 720px;
}
.language-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 24px;
  margin: 20px 0;
}
.language-choices .check-label {
  align-items: center;
  margin: 0;
  gap: 9px;
}
.language-choices .check-label input {
  margin: 0;
}
.primary-language {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 0;
  font-size: 13px;
}
.primary-language select {
  max-width: 320px;
  min-width: 0;
}
.language-manager {
  border-top: 1px solid var(--line);
  padding-top: 20px;
  margin-top: 24px;
}
.language-manager h3 {
  font-size: 14px;
  color: var(--ink);
  margin: 0;
}
.language-manager p {
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 12px;
}
.language-manager > input {
  width: 100%;
  margin: 14px 0;
}
.pack-list {
  max-height: 350px;
  overflow: auto;
}
.pack-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 16px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.pack-row > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.pack-row small {
  color: var(--muted);
}
@media (max-width: 700px) {
  .panel.ocr-language-settings {
    padding: 20px;
  }
}
@media (max-width: 450px) {
  .pack-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 12px;
  }
  .pack-row small {
    grid-column: 1;
    grid-row: 2;
  }
  .pack-row .button {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
}
</style>
