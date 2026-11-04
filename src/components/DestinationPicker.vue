<script setup lang="ts">
import { WorkflowError } from '../domain/errors'

// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
import { safePath } from '../domain/review'
const props = defineProps<{
    modelValue: string
    root: string
    space: string
    filename: string
    disabled?: boolean
  }>(),
  emit = defineEmits<{ 'update:modelValue': [string] }>(),
  store = useWorkspace(),
  { t } = useLocale()
const opened = ref(false),
  path = ref(''),
  folders = ref<{ path: string }[]>([]),
  loading = ref(false),
  error = ref(''),
  addingFolder = ref(false),
  folderName = ref('')
let generation = 0,
  alive = true
const newFolderTarget = computed(() => {
  const name = folderName.value.trim().normalize('NFC')
  if (
    !name ||
    name.includes('/') ||
    !(path.value === props.root || path.value.startsWith(props.root + '/'))
  )
    return ''
  try {
    return safePath(
      path.value + '/' + name + '/' + (props.modelValue.split('/').pop() || props.filename)
    )
  } catch {
    return ''
  }
})
function close() {
  opened.value = false
  generation++
  loading.value = false
  addingFolder.value = false
  folderName.value = ''
}
function chooseNew() {
  if (props.disabled || loading.value || error.value || !newFolderTarget.value) return
  emit('update:modelValue', newFolderTarget.value)
  close()
}
async function browse(value: string) {
  if (props.disabled) return
  addingFolder.value = false
  folderName.value = ''
  const version = ++generation
  loading.value = true
  opened.value = true
  error.value = ''
  try {
    if (value !== props.root && !value.startsWith(props.root + '/'))
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Choose a folder inside the document destination'
      )
    const result = await store.request('files', { path: value, documentSpace: props.space })
    if (alive && version === generation) {
      folders.value = (result.files ?? []).filter(
        (f: any) =>
          f.folder &&
          f.path.startsWith(value + '/') &&
          !f.path.slice(value.length + 1).includes('/')
      )
      path.value = value
    }
  } catch (e) {
    if (alive && version === generation)
      error.value = e instanceof Error ? e.message : 'Folder unavailable'
  } finally {
    if (alive && version === generation) loading.value = false
  }
}
function choose() {
  if (props.disabled || loading.value || error.value) return
  emit(
    'update:modelValue',
    path.value + '/' + (props.modelValue.split('/').pop() || props.filename)
  )
  close()
}
watch(() => JSON.stringify([props.root, props.space, props.filename]), close)
onBeforeUnmount(() => {
  alive = false
  generation++
})
function setAddingFolder(value: boolean) {
  addingFolder.value = value
  folderName.value = ''
}
</script>
<template>
  <div class="destination-picker">
    <div class="destination-value">
      <input
        id="manual-target"
        :value="modelValue"
        :disabled="disabled"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      /><button
        type="button"
        class="button"
        :disabled="disabled"
        :aria-expanded="opened"
        @click="opened ? close() : browse(root)"
      >
        {{ t('Choose folder') }}
      </button>
    </div>
    <section v-if="opened" class="folder-picker" :aria-label="t('Choose folder')">
      <div class="folder-path">
        <button
          v-if="path && path !== root"
          type="button"
          class="icon-button"
          :disabled="loading || disabled"
          :aria-label="t('Parent folder')"
          @click="browse(path.split('/').slice(0, -1).join('/'))"
        >
          ↑</button
        ><span>{{ path || root }}</span>
      </div>
      <p v-if="loading" role="status">{{ t('Loading…') }}</p>
      <button
        v-for="folder in folders"
        :key="folder.path"
        type="button"
        class="folder-choice"
        :disabled="loading || disabled"
        @click="browse(folder.path)"
      >
        {{ folder.path.split('/').pop() }}
      </button>
      <div v-if="addingFolder" class="new-folder">
        <label for="destination-folder-name">{{ t('Folder name') }}</label
        ><input
          id="destination-folder-name"
          v-model="folderName"
          :disabled="loading || disabled"
          maxlength="150"
          @keydown.enter.prevent="chooseNew"
          @keydown.esc.prevent="addingFolder = false"
        />
        <p class="fine-print">
          {{ t('The folder will be created when you accept the document.') }}
        </p>
        <div class="picker-actions">
          <button
            type="button"
            class="button primary"
            :disabled="loading || disabled || !!error || !newFolderTarget"
            @click="chooseNew"
          >
            {{ t('Use new folder') }}</button
          ><button type="button" class="button subtle" @click="setAddingFolder(false)">
            {{ t('Cancel') }}
          </button>
        </div>
      </div>
      <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
      <div v-if="!addingFolder" class="picker-actions">
        <button
          type="button"
          class="button"
          :disabled="loading || disabled || !!error"
          @click="setAddingFolder(true)"
        >
          {{ t('New folder') }}</button
        ><button
          type="button"
          class="button primary"
          :disabled="loading || disabled || !!error"
          @click="choose"
        >
          {{ t('Use this folder') }}</button
        ><button type="button" class="button subtle" @click="close">{{ t('Cancel') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.destination-value {
  display: flex;
  gap: 8px;
  align-items: start;
}
.destination-value input {
  min-width: 0;
  flex: 1;
}
.destination-value .button {
  flex-shrink: 0;
}
.folder-picker {
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.folder-path {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  overflow-wrap: anywhere;
}
.folder-choice {
  display: block;
  width: 100%;
  background: none;
  border: 0;
  color: var(--ink);
  text-align: left;
  padding: 9px;
  cursor: pointer;
}
.folder-choice:hover {
  background: var(--surface);
}
.picker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.new-folder {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.new-folder label {
  display: block;
  margin-bottom: 8px;
}
.new-folder input {
  width: 100%;
  max-width: 420px;
}
.new-folder .fine-print {
  margin-top: 8px;
}
</style>
