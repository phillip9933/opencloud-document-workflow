<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue'
import { useLocale } from '../state/locale'
import type { PreparationReview } from '../domain/preparation'
const props = defineProps<{ report: PreparationReview }>(),
  { t } = useLocale()
const labels = {
  issuer: 'Sender',
  date: 'Date',
  kind: 'Type',
  folder: 'Category',
  tags: 'Tags',
  document: 'AI response'
}
const messages = {
  missing: 'No supported value was found.',
  shape: 'The AI response has an unexpected format.',
  quote: 'The quotation could not be matched to the document.',
  literal: 'The proposed value does not match its quoted text.',
  date: 'A complete, unambiguous printed date is needed.',
  category: 'The category lacks supporting document text.',
  value: 'The proposed value could not be verified.'
}
const facts = computed(() =>
  (['issuer', 'date', 'kind', 'folder'] as const).flatMap((key) =>
    props.report.verified[key] ? [{ key, claim: props.report.verified[key]! }] : []
  )
)
</script>
<template>
  <div class="preparation-review">
    <template v-if="facts.length"
      ><h3>{{ t('Extracted details') }}</h3>
      <dl>
        <template v-for="fact in facts" :key="fact.key"
          ><dt>{{ t(labels[fact.key]) }}</dt>
          <dd>{{ fact.claim.value }}</dd></template
        >
      </dl>
      <details>
        <summary>{{ t('Evidence') }}</summary>
        <div v-for="fact in facts" :key="fact.key">
          <strong>{{ t(labels[fact.key]) }}</strong>
          <blockquote v-for="(e, index) in fact.claim.evidence" :key="index">
            {{ e.quote }} <small>{{ t('Page {number}', { number: e.page }) }}</small>
          </blockquote>
        </div>
      </details></template
    >
    <ul v-if="report.issues.length" class="preparation-issues">
      <li v-for="issue in report.issues" :key="issue.field">
        <strong>{{ t(labels[issue.field]) }}</strong> — {{ t(messages[issue.code]) }}
      </li>
    </ul>
  </div>
</template>
<style scoped>
.preparation-review {
  margin-top: 18px;
  font-size: 13px;
}
.preparation-review h3 {
  font-size: 13px;
  margin: 0 0 10px;
}
.preparation-review dl {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 9px;
  margin: 0;
}
.preparation-review dt {
  color: var(--muted);
}
.preparation-review dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.preparation-issues {
  list-style: none;
  padding: 0;
  margin: 16px 0 0;
  display: grid;
  gap: 10px;
}
.preparation-issues li {
  border-left: 2px solid var(--warning-border);
  padding-left: 10px;
  color: var(--ink);
  line-height: 1.6;
}
.preparation-review summary {
  color: var(--muted);
  cursor: pointer;
  padding: 12px 0 0;
}
.preparation-review details > div {
  margin-top: 12px;
}
.preparation-review blockquote {
  margin: 6px 0;
  border-left: 2px solid var(--line);
  padding-left: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preparation-review small {
  color: var(--muted);
}
</style>
