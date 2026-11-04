<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { defineAsyncComponent } from 'vue'
import { useDocumentController } from '../state/document-controller'
import type { DocumentDetailsProps, DocumentDetailsEmit } from '../state/document-controller'
import DocumentProcessingStatus from '../components/DocumentProcessingStatus.vue'
import DocumentMetadataSummary from '../components/DocumentMetadataSummary.vue'
import DocumentMetadataEditor from '../components/DocumentMetadataEditor.vue'
import DocumentTrashButton from '../components/DocumentTrashButton.vue'
import BulkActions from '../components/BulkActions.vue'
import ProcessingIssue from '../components/ProcessingIssue.vue'
const PdfPreview = defineAsyncComponent(() => import('../components/PdfPreview.vue'))
const props = defineProps<DocumentDetailsProps>()
const emit = defineEmits<DocumentDetailsEmit>()
const {
  detailRoute,
  store,
  t,
  data,
  values,
  tags,
  error,
  message,
  busy,
  loading,
  editing,
  saveNeedsCheck,
  tagRemovalState,
  preparing,
  trashUncertain,
  fileTrashState,
  canTrash,
  fileTrashed,
  preview,
  previewBusy,
  previewError,
  dirty,
  navigation,
  back,
  tagRemoved,
  load,
  startEdit,
  cancel,
  reload,
  save,
  reconcile,
  retryProcessing,
  prepareOriginal,
  reformatPDF,
  prepare,
  processing,
  currentProcessingIssue,
  cloudConsent,
  duplicate,
  openOriginal,
  trashDuplicate
} = useDocumentController(props, emit)
</script>
<template>
  <component
    :is="embedded ? 'section' : 'main'"
    :class="embedded ? 'embedded-details' : 'screen document-details'"
  >
    <header v-if="!embedded" class="screen-heading editor-heading">
      <nav
        v-if="detailRoute.query.return === 'inbox'"
        class="inbox-navigation"
        :aria-label="t('Document navigation')"
      >
        <RouterLink
          class="button subtle"
          to="/document-workflow/inbox"
          :aria-label="t('Back to inbox')"
          >{{ t('Inbox') }}</RouterLink
        ><button
          class="icon-button"
          :disabled="!navigation.canPrevious.value"
          :aria-label="t('Previous document')"
          :title="t('Previous document')"
          @click="navigation.move(-1)"
        >
          ‹</button
        ><span v-if="navigation.position.value"
          >{{ navigation.position.value }} / {{ navigation.total.value }}</span
        ><button
          class="icon-button"
          :disabled="!navigation.canNext.value"
          :aria-label="t('Next document')"
          :title="t('Next document')"
          @click="navigation.move(1)"
        >
          ›
        </button>
      </nav>
      <RouterLink v-else class="icon-button" :to="back" :aria-label="t('Back')">←</RouterLink>
      <h1>{{ data?.source.path.split('/').pop() || t('Document') }}</h1>
      <button
        v-if="data && duplicate"
        class="button"
        :disabled="busy || dirty || data.pending.length > 0"
        @click="trashDuplicate"
      >
        {{
          t(
            trashUncertain || duplicate.uncertain
              ? 'Verify Trash outcome'
              : 'Move to OpenCloud Trash'
          )
        }}</button
      ><button
        v-else-if="data && /\.pdf$/i.test(data.source.path)"
        class="button primary"
        :disabled="
          busy ||
          processing.active.value ||
          dirty ||
          loading ||
          fileTrashState.busy ||
          fileTrashState.uncertain ||
          data.pending.length > 0 ||
          saveNeedsCheck
        "
        @click="prepare"
      >
        {{
          t(
            /\.pdf$/i.test(data?.source.path ?? '')
              ? busy
                ? 'Reprocessing…'
                : 'Reprocess'
              : 'Create PDF copy'
          )
        }}</button
      ><DocumentTrashButton
        v-if="canTrash"
        :path="data?.source.path || String(detailRoute.query.path || '')"
        :document-space="
          String(
            detailRoute.query.space || data?.source.space || store.connection.value?.space || ''
          )
        "
        :resource-id="data?.source.resourceId || resourceId"
        :etag="data?.source.etag"
        :sha256="data?.source.sha256"
        :pending-id="data?.trash?.id"
        :job="typeof detailRoute.query.job === 'string' ? detailRoute.query.job : undefined"
        :disabled="busy || processing.active.value || loading || dirty || !!data?.pending.length"
        @state="fileTrashState = $event"
        @trashed="fileTrashed"
      />
    </header>
    <div v-if="embedded && data" class="embedded-tools">
      <button
        v-if="/\.pdf$/i.test(data.source.path)"
        class="button"
        :disabled="
          busy ||
          processing.active.value ||
          dirty ||
          loading ||
          fileTrashState.busy ||
          fileTrashState.uncertain ||
          data.pending.length > 0 ||
          saveNeedsCheck
        "
        @click="prepare"
      >
        {{ t(busy ? 'Reprocessing…' : 'Reprocess') }}</button
      ><DocumentTrashButton
        v-if="canTrash"
        :path="data?.source.path || String(detailRoute.query.path || '')"
        :document-space="
          String(
            detailRoute.query.space || data?.source.space || store.connection.value?.space || ''
          )
        "
        :resource-id="data?.source.resourceId || resourceId"
        :etag="data?.source.etag"
        :sha256="data?.source.sha256"
        :pending-id="data?.trash?.id"
        :job="typeof detailRoute.query.job === 'string' ? detailRoute.query.job : undefined"
        :disabled="busy || processing.active.value || loading || dirty || !!data?.pending.length"
        @state="fileTrashState = $event"
        @trashed="fileTrashed"
      />
    </div>
    <DocumentProcessingStatus
      :status="processing.status.value"
      :filed-job="data?.filedJob"
      :unavailable="processing.unavailable.value"
      :preparing="preparing"
    />
    <ProcessingIssue
      v-if="currentProcessingIssue"
      :issue="currentProcessingIssue"
      :busy="busy || dirty || loading"
      @retry="retryProcessing"
    />
    <p v-if="loading" role="status">{{ t('Loading…') }}</p>
    <p v-if="error || navigation.error.value" class="error" role="alert">
      {{ t(error || navigation.error.value) }}
    </p>
    <p v-if="message" class="message" role="status">{{ t(message) }}</p>
    <label
      v-if="data && /\.pdf$/i.test(data.source.path) && store.cloudProcessing.value"
      class="check-label"
      ><input v-model="cloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label
    >
    <p v-if="duplicate" class="duplicate-notice">
      {{ t('Exact duplicate') }}
      <button v-if="duplicate.job" class="button subtle" :disabled="busy" @click="openOriginal">
        {{ t('Open original') }}
      </button>
    </p>
    <div v-if="data" class="details-layout">
      <section class="panel detail-preview" :aria-label="t('Original document')">
        <p v-if="previewBusy" role="status">{{ t('Loading…') }}</p>
        <div v-else-if="!/\.pdf$/i.test(data.source.path)">
          <h2>{{ t('Original file') }}</h2>
          <p>{{ t('Preview is unavailable for this format.') }}</p>
          <RouterLink
            v-if="
              store.fileLocation(
                String(
                  detailRoute.query.space || data.source.space || store.connection.value?.space
                ),
                data.source.path
              )
            "
            class="button"
            :to="
              store.fileLocation(
                String(
                  detailRoute.query.space || data.source.space || store.connection.value?.space
                ),
                data.source.path
              )!
            "
            >{{ t('Open location in OpenCloud') }}</RouterLink
          >
        </div>
        <PdfPreview
          v-else-if="preview"
          :data="preview"
          :filename="data.source.path.split('/').pop()"
        />
        <p v-else-if="previewError" role="alert" class="error">{{ t(previewError) }}</p>
      </section>
      <div>
        <section
          v-if="data.pending.length"
          class="panel pending-metadata"
          :aria-label="t('Pending verification')"
        >
          <p>{{ t('Outcome needs verification') }}</p>
          <button
            v-for="pending in data.pending"
            :key="pending.id"
            class="button"
            :disabled="busy"
            @click="reconcile(pending.id)"
          >
            {{ t('Verify') }}
          </button>
        </section>
        <DocumentMetadataSummary
          v-if="!editing"
          :data="data"
          :edit-disabled="
            busy || fileTrashState.busy || fileTrashState.uncertain || data.pending.length > 0
          "
          :remove-disabled="
            busy ||
            loading ||
            dirty ||
            fileTrashState.busy ||
            fileTrashState.uncertain ||
            data.pending.length > 0
          "
          @edit="startEdit"
          @tag-state="tagRemovalState = $event"
          @tag-removed="tagRemoved"
        />
        <DocumentMetadataEditor
          v-else
          v-model:values="values"
          v-model:tags="tags"
          :data="data"
          :busy="busy"
          :blocked="fileTrashState.busy || fileTrashState.uncertain"
          :loading="loading"
          :dirty="dirty"
          :save-needs-check="saveNeedsCheck"
          @save="save"
          @cancel="cancel"
          @reload="reload"
        />
        <section
          v-if="
            detailRoute.query.return === 'inbox' && !/\.pdf$/i.test(data.source.path) && !duplicate
          "
          class="original-filing decision-actions"
          :aria-label="t('Filing')"
        >
          <h2>{{ t('Filing') }}</h2>
          <p>
            {{
              t('Choose a folder and filename to file the original. PDF conversion is optional.')
            }}
          </p>
          <button
            class="button primary"
            :disabled="
              busy ||
              processing.active.value ||
              dirty ||
              loading ||
              fileTrashState.busy ||
              fileTrashState.uncertain ||
              data.pending.length > 0
            "
            @click="prepareOriginal"
          >
            {{ t('Choose filing details') }}
          </button>
        </section>
        <details
          v-if="
            detailRoute.query.return === 'inbox' &&
            /\.(jpe?g|png|tiff?|bmp|webp|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|oxps|xps)$/i.test(
              data.source.path
            )
          "
          class="optional-conversion"
        >
          <summary>{{ t('PDF conversion') }}</summary>
          <p>
            {{
              t('Create a PDF copy for OCR and AI review. Manual filing keeps the original format.')
            }}
          </p>
          <BulkActions
            :documents="[{ path: data.source.path, resourceId: data.source.resourceId }]"
            prepare
            hide-edit
            @changed="load"
          />
        </details>
        <details class="document-technical">
          <summary>{{ t('File information') }}</summary>
          <dl>
            <dt>{{ t('Location') }}</dt>
            <dd>{{ data.source.path }}</dd>
            <template v-if="data.conversion"
              ><dt>{{ t('Archived original') }}</dt>
              <dd>{{ data.conversion.archivePath }}</dd></template
            >
            <dt>{{ t('Resource') }}</dt>
            <dd>{{ data.source.resourceId }}</dd>
            <dt>SHA256</dt>
            <dd>{{ data.source.sha256 }}</dd>
            <dt>{{ t('Version') }}</dt>
            <dd>{{ data.record.version }}</dd>
          </dl>
          <template v-if="data.conversion && /\.(xlsx|xls|ods)$/i.test(data.conversion.archivePath)"
            ><p>
              {{
                t(
                  'Recreates the PDF with readable spreadsheet layout. Keeps the workbook and previous PDF.'
                )
              }}
            </p>
            <button
              class="button"
              :disabled="
                busy ||
                fileTrashState.busy ||
                fileTrashState.uncertain ||
                dirty ||
                data.pending.length > 0
              "
              @click="reformatPDF"
            >
              {{ t(busy ? 'Recreating PDF…' : 'Recreate PDF') }}
            </button></template
          >
        </details>
      </div>
    </div>
  </component>
</template>
<style scoped>
.original-filing {
  padding: 22px 0;
  border-top: 1px solid var(--line);
  margin-top: 22px;
}
.original-filing h2,
.detail-preview h2 {
  font-size: 15px;
  margin: 0 0 12px;
}
.original-filing p,
.detail-preview > div > p,
.optional-conversion p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}
.original-filing .primary {
  margin-top: 8px;
}
.optional-conversion {
  margin-top: 18px;
  font-size: 12px;
}
.optional-conversion > summary {
  cursor: pointer;
  color: var(--muted);
  padding: 7px 0;
}
.embedded-details {
  padding: 16px;
  background: var(--raised);
  border-top: 1px solid var(--line);
}
.embedded-tools {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 12px;
}
.embedded-details .saved-details,
.embedded-details .detail-preview,
.embedded-details .metadata-edit {
  margin-top: 0;
}
.document-details {
  max-width: 1200px;
}
.document-details h1 {
  font-size: 25px;
  overflow-wrap: anywhere;
  max-width: 850px;
}
.saved-details,
.metadata-edit,
.pending-metadata,
.detail-preview {
  padding: 24px;
  margin: 22px 0;
}
.document-technical summary {
  cursor: pointer;
  color: var(--accent-text);
  padding: 7px 0;
}
.document-technical {
  font-size: 12px;
  margin-top: 24px;
  color: var(--muted);
}
.document-technical dl {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: 10px;
}
.document-technical dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.document-technical a {
  display: inline-block;
  color: var(--accent-text);
  margin-top: 12px;
}
.pending-metadata .button {
  margin-top: 14px;
}
@media (max-width: 700px) {
  .saved-details,
  .metadata-edit,
  .pending-metadata,
  .detail-preview {
    padding: 18px;
  }
  .document-details h1 {
    font-size: 22px;
  }
}
.details-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.details-layout .detail-preview,
.details-layout .saved-details,
.details-layout .metadata-edit {
  margin: 0;
}
.editor-heading {
  justify-content: start;
  gap: 14px;
}
.editor-heading h1 {
  font-size: 20px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-heading .button.primary {
  margin-left: auto;
}
@media (max-width: 850px) {
  .details-layout {
    grid-template-columns: 1fr;
  }
}
</style>
