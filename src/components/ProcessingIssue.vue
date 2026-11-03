<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {useLocale} from '../state/locale'
import type {ProcessingIssueInfo} from '../domain/processing'
defineProps<{issue:ProcessingIssueInfo;busy?:boolean}>()
defineEmits<{retry:[]}>()
const {t}=useLocale()
</script>
<template><section class="processing-issue" role="status" :aria-label="t('Needs attention')"><h2>{{ t('Needs attention') }}</h2><p>{{ t(issue.message) }}</p><p>{{ t(issue.nextStep) }}</p><div class="issue-actions"><button v-if="issue.retryable" class="button" :disabled="busy" @click="$emit('retry')">{{ t('Retry processing') }}</button><RouterLink v-if="issue.settings" class="button subtle" :to="issue.settings">{{ t(issue.settings.endsWith('folders')?'Folder settings':issue.settings.endsWith('activity')?'Activity':issue.settings.endsWith('inbox')?'Inbox':'Processing settings') }}</RouterLink></div></section></template>
<style scoped>.processing-issue{border-left:3px solid var(--warning-border);background:var(--warning-bg);padding:16px 20px;border-radius:6px;margin:0 0 20px}.processing-issue h2{font-size:14px;margin:0 0 8px}.processing-issue p{font-size:13px;line-height:1.5;margin:6px 0}.issue-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}</style>
