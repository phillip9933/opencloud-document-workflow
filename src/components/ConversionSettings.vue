<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, onMounted } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
const store = useWorkspace(),
  { t } = useLocale(),
  archive = ref('Archive'),
  available = ref(false),
  busy = ref(false),
  error = ref(''),
  saved = ref(false)
onMounted(async () => {
  try {
    const settings = await store.request('conversion-settings')
    archive.value = settings.archive
    available.value = settings.available
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load conversion settings'
  }
})
async function save() {
  busy.value = true
  error.value = ''
  saved.value = false
  try {
    await store.request('conversion-settings-save', { archive: archive.value })
    saved.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <details class="conversion-settings">
    <summary>{{ t('PDF conversion') }}</summary>
    <p>
      {{
        t(
          'Create PDF copies from images and Office documents using the Inbox selection. Originals move here only after their PDF is verified.'
        )
      }}
    </p>
    <form @submit.prevent="save">
      <label for="conversion-archive">{{ t('Originals archive') }}</label
      ><input id="conversion-archive" v-model="archive" required />
      <p class="fine-print">
        {{ t('A folder in the Inbox Space, outside the watched Inbox. Subfolders are preserved.') }}
      </p>
      <button class="button" :disabled="busy">{{ t('Save') }}</button
      ><span v-if="saved" role="status">{{ t('Saved') }}</span>
    </form>
    <p v-if="!available">{{ t('The conversion service is not configured') }}</p>
    <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
  </details>
</template>
<style scoped>
.conversion-settings {
  border-top: 1px solid var(--line);
  margin-top: 24px;
  padding-top: 20px;
}
.conversion-settings > summary {
  font-weight: 600;
  cursor: pointer;
  color: var(--ink);
}
p {
  font-size: 13px;
  line-height: 1.6;
  margin: 14px 0;
}
label {
  display: block;
  font-size: 13px;
  margin: 16px 0 8px;
}
input {
  width: 100%;
}
form > span {
  margin-left: 12px;
  font-size: 13px;
}
</style>
