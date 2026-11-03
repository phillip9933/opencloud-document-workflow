<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed} from 'vue'
import ProcessingProgress from './ProcessingProgress.vue'
import {useLocale} from '../state/locale'
import type {DocumentProcessingState} from '../state/document-processing'
const props=defineProps<{status:DocumentProcessingState|null;unavailable?:boolean;preparing?:boolean;currentJob?:string}>(),{t}=useLocale()
const active=computed(()=>props.preparing||['queued','settling','running'].includes(props.status?.state??''))
const item=computed(()=>({state:props.preparing&&!['queued','running','settling'].includes(props.status?.state??'')?'running':props.status?.state,stage:props.status?.stage??'reading'}))
const ready=computed(()=>props.status?.state==='prepared'&&!props.status.processingIssue&&props.status.job&&props.status.job!==props.currentJob)
</script>
<template><section v-if="active||ready||unavailable" class="document-processing" role="status" aria-live="polite" :aria-label="t('Document processing')"><template v-if="unavailable"><h2>{{ t('Live processing status unavailable') }}</h2><p>{{ t('Reconnecting to check the current status…') }}</p></template><template v-else-if="active"><h2>{{ t(status?.paused&&status.state!=='running'?'Processing paused':item.state==='running'?'Processing document':'Waiting to process') }}</h2><ProcessingProgress :item="item" stage-only /><p>{{ t(status?.paused&&status.state!=='running'?'Resume processing in Activity to continue.':'This page updates automatically. Larger documents can take several minutes.') }}</p></template><template v-else-if="ready"><h2>{{ t('Ready to review') }}</h2><RouterLink class="button" :to="{path:'/document-workflow/inbox',query:{job:status!.job}}">{{ t('Open review') }}</RouterLink></template></section></template>
<style scoped>.document-processing{border:1px solid var(--line);border-left:3px solid var(--accent-text);background:var(--raised);padding:16px 20px;border-radius:6px;margin:0 0 20px}.document-processing h2{font-size:14px;margin:0 0 9px}.document-processing p{font-size:13px;color:var(--muted);line-height:1.5;margin:9px 0 0}.document-processing .button{margin-top:5px}</style>
