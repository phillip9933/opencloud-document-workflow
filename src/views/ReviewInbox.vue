<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { filingInProgress, canReviseFiling } from '../domain/decision-state'
import { defineAsyncComponent } from 'vue'
import { useReviewController } from '../state/review-controller'
import type { ReviewInboxProps } from '../state/review-controller'
import DocumentProcessingStatus from '../components/DocumentProcessingStatus.vue'
import ReviewFilingPlan from '../components/ReviewFilingPlan.vue'
import ReviewDecisionActions from '../components/ReviewDecisionActions.vue'
import DocumentTrashButton from '../components/DocumentTrashButton.vue'
import ProcessingIssue from '../components/ProcessingIssue.vue'
import PreparationReview from '../components/PreparationReview.vue'
const ReviewFields = defineAsyncComponent(() => import('../components/ReviewFields.vue'))
const PdfPreview = defineAsyncComponent(() => import('../components/PdfPreview.vue'))
const props = defineProps<ReviewInboxProps>()
const {
  store,
  t,
  formatDate,
  route,
  collectionPath,
  verification,
  policy,
  connection,
  screen,
  fieldsBusy,
  fieldsUncertain,
  fieldState,
  addSuggestedTag,
  setReviewTags,
  reformatPDF,
  freshCloudConsent,
  preparingFresh,
  prepareFresh,
  fileTrashState,
  fileTrashed,
  error,
  message,
  busy,
  active,
  fieldEditsPending,
  job,
  processing,
  currentProcessingIssue,
  manual,
  manualTarget,
  manualTags,
  planned,
  filingProblem,
  editActions,
  resetActions,
  destinationBlocked,
  preview,
  previewLoading,
  previewError,
  previewChanged,
  resolvedTags,
  documentSpace,
  documentPath,
  inInbox,
  navigation,
  retryProcessing,
  loadPreview,
  decisionBlocked,
  acceptDisabled,
  decide,
  takeOver,
  exportApproval,
  chooseManualTarget
} = useReviewController(props)
</script>

<template>
  <main ref="screen" class="workflow screen">
    <header class="screen-heading editor-heading">
      <nav v-if="inInbox" class="inbox-navigation" :aria-label="t('Document navigation')">
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
      <RouterLink
        v-else
        class="icon-button"
        :to="
          route.query.from === 'history'
            ? { path: '/document-workflow/activity', query: { view: 'filing' } }
            : collectionPath()
        "
        :aria-label="
          t(
            route.query.from === 'history'
              ? 'Back to filing history'
              : collectionPath().endsWith('/documents')
                ? 'Back to documents'
                : 'Back to inbox'
          )
        "
        >←</RouterLink
      >
      <h1 :title="documentPath?.split('/').pop()">
        {{ documentPath?.split('/').pop() || t('Document') }}
      </h1>
      <span v-if="job?.decision === 'done'" class="pill">{{ t('Filed') }}</span
      ><button
        v-if="
          active &&
          job &&
          (active.bundle.manualReview?.reason !== 'original' || !!job.decision) &&
          canReviseFiling(job.decision) &&
          !['pending', 'running'].includes(job.automation?.state || '')
        "
        class="button"
        :disabled="
          busy ||
          processing.active.value ||
          fileTrashState.busy ||
          fileTrashState.uncertain ||
          fieldsBusy ||
          fieldsUncertain ||
          fieldEditsPending
        "
        :aria-busy="preparingFresh"
        @click="prepareFresh"
      >
        {{
          t(
            preparingFresh
              ? 'Reprocessing…'
              : active.bundle.manualReview?.reason === 'original'
                ? 'New filing review'
                : 'Reprocess'
          )
        }}</button
      ><DocumentTrashButton
        v-if="active && !job?.potentialDuplicates?.length && job && canReviseFiling(job.decision)"
        :path="documentPath || active.bundle.source.path"
        :document-space="documentSpace"
        :job="job.id"
        :sha256="active.bundle.source.sha256"
        :disabled="busy || processing.active.value || fieldsBusy || fieldEditsPending"
        @state="fileTrashState = $event"
        @trashed="fileTrashed"
      />
    </header>
    <label
      v-if="
        active && active.bundle.manualReview?.reason !== 'original' && store.cloudProcessing.value
      "
      class="check-label"
      ><input v-model="freshCloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label
    >
    <DocumentProcessingStatus
      :status="processing.status.value"
      :unavailable="processing.unavailable.value"
      :preparing="preparingFresh"
      :current-job="job?.id"
    />
    <ProcessingIssue
      v-if="currentProcessingIssue"
      :issue="currentProcessingIssue"
      :busy="busy || fieldsBusy || fieldEditsPending"
      @retry="retryProcessing"
    />
    <p v-if="error || navigation.error.value" role="alert" class="error">
      {{ t(error || navigation.error.value) }}
    </p>
    <p v-if="message" role="status" class="message">{{ t(message) }}</p>
    <template v-if="active">
      <div class="review-layout">
        <section class="source-panel panel" :aria-label="t('Original document')">
          <p v-if="previewLoading" role="status">{{ t('Loading…') }}</p>
          <div
            v-if="active.bundle.manualReview?.reason === 'original'"
            class="original-file-preview"
          >
            <p>{{ t('Preview is unavailable for this format.') }}</p>
            <RouterLink
              v-if="
                store.fileLocation(
                  documentSpace || active.bundle.source.space,
                  documentPath || active.bundle.source.path
                )
              "
              class="button"
              :to="
                store.fileLocation(
                  documentSpace || active.bundle.source.space,
                  documentPath || active.bundle.source.path
                )!
              "
              >{{ t('Open location in OpenCloud') }}</RouterLink
            >
          </div>
          <PdfPreview
            v-else-if="preview"
            :data="preview"
            :filename="documentPath?.split('/').pop()"
          />
          <div v-else-if="!previewLoading" class="preview-placeholder">
            <p>{{ t(previewError || 'Preview unavailable') }}</p>
            <button class="button" @click="loadPreview">{{ t('Retry') }}</button>
          </div>
        </section>
        <section class="review-plan panel" :aria-label="t('Document details')">
          <section v-if="job?.potentialDuplicates?.length" class="review-step potential-duplicate">
            <h2>{{ t('Potential duplicate') }}</h2>
            <p>{{ t('Matching identifiers and printed dates. Compare before filing.') }}</p>
            <ul>
              <li v-for="match in job.potentialDuplicates" :key="match.id">
                <RouterLink
                  :to="{ path: '/document-workflow/inbox', query: { job: match.id } }"
                  target="_blank"
                  rel="noopener"
                  >{{
                    t('Compare with {name}', { name: match.path.split('/').pop() || match.path })
                  }}</RouterLink
                >
              </li>
            </ul>
            <DocumentTrashButton
              label="Move this copy to Trash"
              v-if="job && canReviseFiling(job.decision)"
              :path="documentPath || active.bundle.source.path"
              :document-space="documentSpace"
              :job="job.id"
              :sha256="active.bundle.source.sha256"
              :disabled="busy || processing.active.value || fieldsBusy || fieldEditsPending"
              @state="fileTrashState = $event"
              @trashed="fileTrashed"
            />
          </section>
          <template v-if="active.proposal || active.bundle.manualReview">
            <section v-if="active.bundle.manualReview" class="review-step">
              <div class="step-heading review-retry-heading">
                <h2>{{ t('Manual review') }}</h2>
              </div>
              <p v-if="!preparingFresh && !job?.preparationReview">
                {{
                  t(
                    active.bundle.manualReview.reason === 'original'
                      ? 'Choose a folder and filename. The original file format is kept.'
                      : active.bundle.manualReview.reason === 'rules'
                        ? 'OCR and extraction rules are ready. Choose the filing details yourself.'
                        : active.bundle.manualReview.reason === 'text'
                          ? 'Some pages could not be read automatically. Choose the filing details yourself.'
                          : active.bundle.manualReview.reason === 'capacity'
                            ? 'This document exceeds the model capacity. Choose the filing details yourself.'
                            : active.bundle.manualReview.reason === 'date'
                              ? 'The printed date needs review. Choose the filing details yourself.'
                              : 'The AI details could not be verified. Choose the filing details yourself.'
                  )
                }}
              </p>
              <PreparationReview
                v-if="!preparingFresh && job?.preparationReview"
                :report="job.preparationReview"
              /><template v-if="job && !job.decision"></template>
            </section>
            <section v-if="active.proposal" class="review-step">
              <dl class="facts">
                <template v-for="key in ['issuer', 'date', 'kind'] as const" :key="key"
                  ><dt>{{ t(key === 'issuer' ? 'Sender' : key === 'date' ? 'Date' : 'Type') }}</dt>
                  <dd>{{ active.proposal[key].value }}</dd></template
                >
              </dl>
              <details class="evidence">
                <summary>{{ t('Evidence') }}</summary>
                <div
                  v-for="key in ['issuer', 'date', 'kind', 'folder'] as const"
                  :key="key"
                  class="claim"
                >
                  <strong>{{
                    t(
                      key === 'issuer'
                        ? 'Sender'
                        : key === 'date'
                          ? 'Date'
                          : key === 'kind'
                            ? 'Type'
                            : 'Category'
                    )
                  }}</strong>
                  <blockquote v-for="(item, index) in active.proposal[key].evidence" :key="index">
                    {{ item.quote }} <small>{{ t('Page {number}', { number: item.page }) }}</small>
                  </blockquote>
                </div>
              </details>
            </section>
            <ReviewFilingPlan
              :active="active"
              :job="job"
              :planned="planned"
              :manual="manual"
              :manual-target="manualTarget"
              :document-path="documentPath"
              :document-space="documentSpace"
              :spaces="store.spaces.value"
              :disabled="decisionBlocked"
              :filing-problem="filingProblem"
              :destination-blocked="destinationBlocked"
              @edit="editActions"
              @reset="resetActions"
              @target="chooseManualTarget"
            />
            <ReviewFields
              v-if="connection && job?.decision !== 'done'"
              :key="active.bundle.source.resourceId + active.bundle.source.sha256"
              :path="documentPath || active.bundle.source.path"
              :document-space="documentSpace"
              :resource-id="active.bundle.source.resourceId"
              :sha256="active.bundle.source.sha256"
              :editable-tags="!job?.decision && policy.tags !== 'off'"
              :selected-tags="
                manual
                  ? manualTags
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                  : (planned?.addTags ?? [])
              "
              :tag-options="(active.bundle.rules?.tags ?? []).map((tag) => tag.value)"
              :tag-evidence="active.proposal?.tags"
              :new-tags="
                active.bundle.tagDiscovery?.mode === 'create'
                  ? (active.proposal?.tags ?? [])
                      .map((tag) => tag.value)
                      .filter((tag) => !active.bundle.tagDiscovery!.catalog.includes(tag))
                  : []
              "
              :locked="
                busy ||
                fileTrashState.busy ||
                fileTrashState.uncertain ||
                filingInProgress(job?.decision)
              "
              @state="fieldState"
              @tag="addSuggestedTag"
              @tags="setReviewTags"
            />
            <section v-else class="review-step">
              <h2>{{ t('Tags') }}</h2>
              <span v-for="tag in resolvedTags ?? planned?.addTags ?? []" :key="tag" class="tag">{{
                tag
              }}</span>
            </section>
            <ReviewDecisionActions
              :job="job"
              :disabled="decisionBlocked"
              :accept-disabled="acceptDisabled"
              :fields-uncertain="fieldsUncertain"
              :field-edits-pending="fieldEditsPending"
              :preview-changed="previewChanged"
              :busy="busy"
              :preparing-fresh="preparingFresh"
              :export-disabled="busy || !planned"
              :verification="verification"
              @decide="decide"
              @take-over="takeOver"
              @export="exportApproval"
            />
            <details v-if="active.excluded.length" class="excluded">
              <summary>{{ t('Excluded tags') }}</summary>
              <p v-for="(tag, index) in active.excluded" :key="index">{{ tag.value }}</p>
            </details>
          </template>
          <section v-else-if="!job?.processingIssue && message !== 'Queued for retry'">
            <p>{{ t('Text recognition required') }}</p>
            <RouterLink class="text-link" to="/document-workflow/settings/automation">{{
              t('Processing settings')
            }}</RouterLink>
          </section>
          <details class="technical">
            <summary>{{ t('File information') }}</summary>
            <dl class="filing">
              <dt>{{ t('Original path') }}</dt>
              <dd>{{ active.bundle.source.path }}</dd>
              <template v-if="job?.conversion"
                ><dt>{{ t('Archived original') }}</dt>
                <dd>{{ job.conversion.archivePath }}</dd></template
              >
              <dt>{{ t('Resource') }}</dt>
              <dd>{{ active.bundle.source.resourceId }}</dd>
              <dt>SHA256</dt>
              <dd>{{ active.bundle.source.sha256 }}</dd>
            </dl>
            <template
              v-if="
                job?.conversion &&
                !job.decision &&
                /\.(xlsx|xls|ods)$/i.test(job.conversion.archivePath)
              "
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
                  processing.active.value ||
                  fileTrashState.busy ||
                  fileTrashState.uncertain ||
                  fieldsBusy ||
                  fieldEditsPending
                "
                @click="reformatPDF"
              >
                {{ t(busy ? 'Recreating PDF…' : 'Recreate PDF') }}
              </button></template
            >
            <article v-for="(page, index) in active.bundle.pages" :key="index">
              <h3>{{ t('Page {number}', { number: index + 1 }) }}</h3>
              <pre>{{ page }}</pre>
            </article>
            <p v-if="job?.approval?.automaticAuthorization">
              {{ t('Automatic') }} ·
              {{ formatDate(job.approval.automaticAuthorization.authorizedAt) }}
            </p>
          </details>
        </section>
      </div>
    </template>
    <p v-else-if="busy" role="status">{{ t('Loading…') }}</p>
  </main>
</template>
<style scoped>
.review-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.review-selector label {
  font-size: 12px;
  color: var(--muted);
}
.review-selector select {
  flex: 1;
  min-width: 160px;
}
.review-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 1fr);
  gap: 24px;
  align-items: start;
}
.source-panel {
  padding: 18px;
  position: sticky;
  top: 16px;
}
.source-heading,
.step-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.source-heading h2 {
  margin: 0;
}
.source-name {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.preview-placeholder {
  padding: 48px 12px;
  text-align: center;
}
.review-plan {
  min-width: 0;
  padding: 0 24px;
}
.review-step {
  padding: 22px 0;
  border-bottom: 1px solid var(--line);
}
.review-step h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 15px;
}
.step-number {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--subtle);
  color: var(--accent-text);
  font-size: 12px;
}
.review-step > p {
  font-size: 12px;
}
.facts,
.filing {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
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
.facts dd {
  font-weight: 600;
}
.text-link {
  display: inline-block;
  color: var(--accent-text);
  font-size: 12px;
  margin-top: 14px;
}
.fine-print {
  font-size: 11px !important;
}
.technical,
.excluded {
  padding: 14px 0;
}
summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  padding: 6px 0;
}
.evidence {
  margin-top: 12px;
}
.claim {
  margin: 12px 0;
  font-size: 12px;
}
.claim strong {
  text-transform: capitalize;
}
blockquote {
  margin: 6px 0 12px;
  border-left: 2px solid var(--line);
  padding-left: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
blockquote small {
  display: block;
  color: var(--muted);
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  background: var(--subtle);
  padding: 12px;
}
h3 {
  font-size: 13px;
  margin: 20px 0 8px;
}
@media (max-width: 1100px) {
  .review-layout {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 1fr);
    gap: 16px;
  }
  .review-plan {
    padding: 0 16px;
  }
  .review-selector .button {
    padding: 8px;
  }
}
@media (max-width: 850px) {
  .review-layout {
    grid-template-columns: 1fr;
  }
  .source-panel {
    position: static;
  }
  .review-selector select {
    flex-basis: 65%;
  }
  .facts,
  .filing {
    grid-template-columns: 85px minmax(0, 1fr);
  }
}
.potential-duplicate ul {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}
.potential-duplicate li + li {
  margin-top: 8px;
}
.potential-duplicate a {
  color: var(--accent-text);
  text-underline-offset: 3px;
}
.review-plan > .review-step.potential-duplicate:first-child {
  padding-top: 22px;
}
.review-retry-heading {
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.review-plan > .review-step:first-child:has(.review-retry-heading) {
  padding-top: 22px;
}
.review-retry-heading h2 {
  margin: 0;
}
.review-retry-heading .button {
  flex: none;
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
.editor-heading .pill {
  margin-left: auto;
}
.source-panel {
  padding: 16px;
}
.review-plan > .review-step:first-child {
  padding-top: 0;
}
.review-plan .facts {
  margin-top: 0;
}
.step-heading .icon-button {
  width: 30px;
  height: 30px;
  font-size: 17px;
}
@media (max-width: 700px) {
  .editor-heading h1 {
    font-size: 17px;
  }
}
</style>
