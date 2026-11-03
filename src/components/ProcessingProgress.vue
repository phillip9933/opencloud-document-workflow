<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed} from 'vue'
import {processingProgress} from '../domain/processing'
import type {ProcessingItem} from '../domain/processing'
import {useLocale} from '../state/locale'
const props=defineProps<{item:ProcessingItem;stageOnly?:boolean}>(),{t}=useLocale(),progress=computed(()=>props.item.progress??processingProgress(props.item))
</script>
<template><span class="processing-progress" :class="{attention:progress.attention,cancelled:progress.cancelled}"><span class="step">{{ progress.step }} / {{ progress.total }}</span><span>{{ t(progress.label) }}<small v-if="progress.attention&&!stageOnly">{{ t('Needs attention') }}</small></span></span></template>
<style scoped>.processing-progress{display:inline-flex;gap:9px;align-items:baseline;font-size:12px}.step{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--muted)}small{display:block;font-size:11px;color:var(--warning-text);margin-top:4px}.cancelled{color:var(--muted)}</style>
