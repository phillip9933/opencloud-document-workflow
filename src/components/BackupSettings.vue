<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspace } from '../state/workspace'
import { useLocale } from '../state/locale'
const store = useWorkspace(),
  { t, formatDate } = useLocale(),
  status = ref<any>(null),
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  enabled = ref(true),
  frequency = ref(6),
  unit = ref(60),
  amount = ref(28),
  storage = ref(1024),
  space = ref(''),
  folder = ref('Document Workflow Backups'),
  baseline = ref(''),
  pickerOpen = ref(false),
  pickerPath = ref(''),
  folders = ref<{ path: string }[]>([])
let alive = true
const settings = computed(() => ({
    enabled: enabled.value,
    intervalMinutes: frequency.value * unit.value,
    maxSnapshots: amount.value,
    maxMiB: storage.value,
    ...(enabled.value ? { destination: { space: space.value, folder: folder.value } } : {})
  })),
  dirty = computed(() => JSON.stringify(settings.value) !== baseline.value)
function apply(value: any) {
  status.value = value
  const s = value.settings
  if (s) {
    enabled.value = s.enabled
    unit.value = s.intervalMinutes % 1440 === 0 ? 1440 : s.intervalMinutes % 60 === 0 ? 60 : 1
    frequency.value = s.intervalMinutes / unit.value
    amount.value = s.maxSnapshots
    storage.value = s.maxMiB
    space.value = s.destination?.space ?? store.connection.value?.space ?? ''
    folder.value = s.destination?.folder ?? 'Document Workflow Backups'
  }
  baseline.value = JSON.stringify(settings.value)
}
async function load() {
  busy.value = true
  try {
    if (!store.connection.value) await store.connect()
    const result = await store.request('reliability')
    if (alive) apply(result.backups)
  } catch {
    if (alive) error.value = 'Backup settings are unavailable'
  } finally {
    if (alive) busy.value = false
  }
}
async function save() {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await store.request('backup-settings-save', { settings: settings.value })
    if (alive) {
      apply(result)
      message.value = 'Saved'
    }
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    if (alive) busy.value = false
  }
}
async function browse(path: string) {
  busy.value = true
  try {
    const result = await store.request('files', { path, documentSpace: space.value })
    if (alive) {
      folders.value = result.files.filter((f: any) => f.folder)
      pickerPath.value = path
      pickerOpen.value = true
    }
  } catch {
    error.value = 'Folder unavailable'
  } finally {
    if (alive) busy.value = false
  }
}
const state = computed(() =>
  !status.value?.configured
    ? 'Backups not configured'
    : status.value.state === 'disabled'
      ? 'Automatic backups are off'
      : status.value.state === 'held'
        ? 'Backups need attention'
        : status.value.state === 'running'
          ? 'Creating a backup'
          : status.value.lastSuccess
            ? 'Verified backups available'
            : 'Waiting for the first backup'
)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (!busy.value && !dirty.value && !pickerOpen.value) void load()
  }, 30000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  alive = false
})
</script>
<template>
  <section class="panel backup-settings" :aria-label="t('Workflow database backups')">
    <div class="backup-heading">
      <h2>{{ t('Workflow database backups') }}</h2>
    </div>
    <p>
      {{
        t(
          'Includes workflow settings, custom fields and review history for all users of this companion. Original PDFs stay in OpenCloud; app tokens are excluded.'
        )
      }}
    </p>
    <p class="backup-state">
      {{ t(state)
      }}<span v-if="status?.lastSuccess">
        · {{ t('Last verified backup: {time}', { time: formatDate(status.lastSuccess) }) }}</span
      >
    </p>
    <p v-if="status?.storage" class="backup-usage">
      {{
        t('{count} backups · {used} MB used', {
          count: status.storage.count,
          used: (status.storage.bytes / 1048576).toFixed(1)
        })
      }}
    </p>
    <p v-if="status?.reason === 'capacity_hold'" class="warning">
      {{
        t(
          'Backup limit reached. Increase a limit or move older backups using OpenCloud. Existing copies are kept.'
        )
      }}
    </p>
    <p v-if="status?.reason === 'backup_access_required'" class="warning">
      {{ t('Connect an OpenCloud app token for the account that owns this backup destination.') }}
    </p>
    <p v-if="status?.reason === 'backup_upload_held'" class="warning">
      {{
        t(
          'A backup upload needs verification. Its temporary local copy is retained; uploads are not repeated blindly.'
        )
      }}
    </p>
    <p v-if="status?.storageType === 'local'">
      {{
        t(
          'Existing backups are on this server. Choose an OpenCloud folder below for new backups; existing copies are kept.'
        )
      }}
    </p>
    <p v-if="status && !status.canManage">
      {{ t('An OpenCloud administrator manages these instance-wide backups.') }}
    </p>
    <form v-if="status?.configured && status.canManage" @submit.prevent="save">
      <fieldset :disabled="busy">
        <label class="check-label"
          ><input v-model="enabled" type="checkbox" />{{ t('Automatic backups') }}</label
        >
        <div class="backup-limits">
          <label for="backup-frequency"
            >{{ t('Frequency') }}
            <div class="frequency-input">
              <input
                id="backup-frequency"
                v-model.number="frequency"
                type="number"
                min="1"
                required
              /><select v-model.number="unit" :aria-label="t('Frequency unit')">
                <option :value="1">{{ t('Minutes') }}</option>
                <option :value="60">{{ t('Hours') }}</option>
                <option :value="1440">{{ t('Days') }}</option>
              </select>
            </div></label
          ><label for="backup-amount"
            >{{ t('Maximum backups')
            }}<input
              id="backup-amount"
              v-model.number="amount"
              type="number"
              min="1"
              max="1000"
              required /></label
          ><label for="backup-storage"
            >{{ t('Storage limit (MB)')
            }}<input
              id="backup-storage"
              v-model.number="storage"
              type="number"
              min="1"
              max="8192"
              required
          /></label>
        </div>
        <template v-if="enabled"
          ><label for="backup-space">{{ t('Backup Space') }}</label
          ><select id="backup-space" v-model="space" required @change="pickerOpen = false">
            <option v-for="item in store.spaces.value" :key="item.id" :value="item.id">
              {{ item.name }}
            </option></select
          ><label for="backup-folder">{{ t('Backup folder') }}</label>
          <div class="folder-input">
            <input id="backup-folder" v-model="folder" required /><button
              type="button"
              class="button"
              @click="browse('')"
            >
              {{ t('Choose') }}
            </button>
          </div>
          <p class="folder-hint">
            {{
              t(
                'A new folder is created when you save. Anyone with access to this folder can read the backup.'
              )
            }}
          </p>
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
              ><span>{{ pickerPath || store.spaces.value.find((s) => s.id === space)?.name }}</span>
            </div>
            <button
              v-for="item in folders"
              :key="item.path"
              type="button"
              class="folder-choice"
              @click="browse(item.path)"
            >
              {{ item.path.split('/').pop() }}
            </button>
            <div class="picker-actions">
              <button
                type="button"
                class="button primary"
                :disabled="!pickerPath"
                @click="
                  folder = pickerPath
                  pickerOpen = false
                "
              >
                {{ t('Use this folder') }}</button
              ><button type="button" class="button subtle" @click="pickerOpen = false">
                {{ t('Cancel') }}
              </button>
            </div>
          </section></template
        >
        <div class="settings-footer">
          <button
            class="button primary"
            :disabled="busy || !dirty"
            :aria-label="t('Save backup settings')"
          >
            {{ t('Save') }}
          </button>
        </div>
      </fieldset>
    </form>
    <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
    <p v-if="message" role="status">{{ t(message) }}</p>
  </section>
</template>
<style scoped>
.backup-settings {
  max-width: 900px;
}
.backup-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.backup-heading h2 {
  margin: 0;
}
.backup-settings > p {
  font-size: 13px;
  max-width: 760px;
}
.backup-state,
.backup-usage,
.folder-hint {
  font-size: 12px !important;
  color: var(--muted);
}
.backup-limits {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: 18px;
  margin-top: 20px;
}
.backup-settings label:not(.check-label) {
  display: block;
  font-size: 13px;
  margin: 16px 0 8px;
}
.backup-settings input:not([type='checkbox']),
.backup-settings select {
  width: 100%;
  display: block;
  margin-top: 7px;
  min-width: 0;
}
.frequency-input,
.folder-input,
.folder-path,
.picker-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.frequency-input input {
  flex: 1;
}
.frequency-input select {
  flex: 1.3;
}
.folder-input input {
  margin-top: 0 !important;
}
.folder-input {
  margin-bottom: 10px;
}
.backup-settings fieldset {
  border: 0;
  padding: 0;
  margin: 20px 0 0;
  min-width: 0;
}
.folder-picker {
  border: 1px solid var(--line);
  padding: 16px;
  border-radius: 6px;
}
.folder-choice {
  display: block;
  background: none;
  border: 0;
  color: var(--ink);
  padding: 10px;
  width: 100%;
  text-align: left;
  cursor: pointer;
}
.picker-actions {
  margin-top: 12px;
}
@media (max-width: 750px) {
  .backup-limits {
    grid-template-columns: 1fr;
  }
}
</style>
