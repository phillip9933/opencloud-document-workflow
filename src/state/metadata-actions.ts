// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../domain/errors'
import type { Ref } from 'vue'
import type { Workspace } from './workspace'
import type { DocumentDetail, MetadataMutationResult } from '../domain/document-details'
interface Context {
  store: Workspace
  data: Ref<DocumentDetail | null>
  values: Ref<Record<string, string | number>>
  tags: Ref<string>
  busy: Ref<boolean>
  editing: Ref<boolean>
  error: Ref<string>
  message: Ref<string>
  fileTrashState: Ref<{ busy: boolean; uncertain: boolean }>
  dirty: Ref<boolean>
  saveNeedsCheck: Ref<boolean>
  query(): { path?: unknown; job?: unknown; space?: unknown }
  scope(): string | null
  isAlive(): boolean
  savedValues(): Record<string, string | number>
  changed(): void
  load(options?: { keepDraft?: boolean }): Promise<boolean>
  applyVerifiedMetadata(result?: MetadataMutationResult): boolean
}
function editedFields(detail: DocumentDetail, values: Record<string, string | number>) {
  const fields: Record<string, string | number> = {}
  for (const field of detail.schema.fields) {
    const value = values[field.id]
    if (value === '' || value === undefined) continue
    if (field.type === 'number' && !Number.isFinite(Number(value)))
      throw new WorkflowError('OPERATION_HELD', 'Enter a valid number for ' + field.label)
    fields[field.id] = field.type === 'number' ? Number(value) : value
  }
  return fields
}
export function useMetadataActions(context: Context) {
  const {
    store,
    data,
    values,
    tags,
    busy,
    editing,
    error,
    message,
    fileTrashState,
    dirty,
    saveNeedsCheck,
    query,
    scope,
    isAlive,
    savedValues,
    changed,
    load,
    applyVerifiedMetadata
  } = context
  const routeKey = () => JSON.stringify([query().path, query().job, query().space])
  function startEdit() {
    values.value = savedValues()
    tags.value = ''
    editing.value = true
    message.value = ''
    error.value = ''
  }
  function cancel() {
    values.value = savedValues()
    tags.value = ''
    editing.value = false
    error.value = ''
  }
  async function reload() {
    editing.value = false
    message.value = ''
    await load()
  }
  async function save() {
    if (
      !data.value ||
      busy.value ||
      fileTrashState.value.busy ||
      fileTrashState.value.uncertain ||
      !dirty.value ||
      saveNeedsCheck.value ||
      data.value.pending.length
    )
      return
    busy.value = true
    error.value = ''
    message.value = ''
    let posted = false
    const context = routeKey()
    try {
      const fields = editedFields(data.value, values.value)
      const source = data.value.source
      posted = true
      const result = await store.request('metadata-save', {
        path: source.path,
        ...(typeof query().space === 'string' ? { documentSpace: query().space } : {}),
        resourceId: source.resourceId,
        etag: source.etag,
        sha256: source.sha256,
        version: data.value.record.version,
        fields,
        addTags: [
          ...new Set(
            tags.value
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean)
          )
        ]
      })
      if (!isAlive() || routeKey() !== context) return
      const uncertain = result.uncertain === true
      if (!uncertain && applyVerifiedMetadata(result)) {
        editing.value = false
        saveNeedsCheck.value = false
        message.value = 'Saved'
      } else if (await load({ keepDraft: uncertain })) {
        editing.value = uncertain
        message.value = uncertain ? 'Outcome needs verification' : 'Saved'
        if (!uncertain) changed()
      }
    } catch (e) {
      if (isAlive() && routeKey() === context) {
        error.value = e instanceof Error ? e.message : 'Save held'
        saveNeedsCheck.value = posted
      }
    } finally {
      busy.value = false
    }
  }
  async function reconcile(id: string) {
    if (busy.value) return
    const context = routeKey(),
      pin = scope()
    busy.value = true
    error.value = ''
    message.value = ''
    try {
      const result = await store.request('metadata-reconcile', {
        id,
        ...(typeof query().space === 'string' ? { documentSpace: query().space } : {})
      })
      if (!isAlive() || scope() !== pin || routeKey() !== context) return
      if (await load({ keepDraft: result.uncertain === true })) {
        if (!result.uncertain) {
          editing.value = false
          changed()
        }
        message.value = result.uncertain ? 'Outcome needs verification' : 'Verified'
      }
    } catch (e) {
      if (isAlive() && scope() === pin && routeKey() === context)
        error.value = e instanceof Error ? e.message : 'Verification held'
    } finally {
      busy.value = false
    }
  }

  return { startEdit, cancel, reload, save, reconcile }
}
