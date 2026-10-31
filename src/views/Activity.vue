<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import OperationHistory from '../components/OperationHistory.vue'
import IngestionHistory from '../components/IngestionHistory.vue'
import {ref,onMounted} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
import {useRoute} from '../state/navigation'
const store=useWorkspace(),route=useRoute(),{t,formatDate}=useLocale(),events=ref<{seq:number;job:string;kind:string;detail:unknown;created:string}[]>([]),error=ref(''),nextCursor=ref<string|null>(null)
async function refresh(more=false){try{const result=await store.request('activity',more?{cursor:nextCursor.value}:{});events.value=more?[...events.value,...result.events]:result.events;nextCursor.value=result.nextCursor;error.value=''}catch(e){error.value=e instanceof Error?e.message:'Could not load activity'}}
onMounted(async()=>{try{if(!store.connection.value)await store.connect();await refresh()}catch(e){error.value=e instanceof Error?e.message:'Could not connect workspace'}})
</script>
<template><main class="screen"><header class="screen-heading"><h1>{{ t('Activity') }}</h1><button v-if="route.query.view==='events'" class="button" @click="refresh()">{{ t('Refresh') }}</button></header><nav class="settings-tabs" :aria-label="t('Activity sections')"><RouterLink :aria-current="!route.query.view?'page':undefined" to="/document-workflow/activity">{{ t('Processing') }}</RouterLink><RouterLink :aria-current="route.query.view==='operations'?'page':undefined" to="/document-workflow/activity?view=operations">{{ t('Bulk operations') }}</RouterLink><RouterLink :aria-current="route.query.view==='events'?'page':undefined" to="/document-workflow/activity?view=events">{{ t('Events') }}</RouterLink></nav><p v-if="error" role="alert" class="error">{{ t(error) }}</p><OperationHistory v-if="route.query.view==='operations'" /><section v-else-if="route.query.view==='events'" class="panel activity-list"><p v-if="!events.length" class="empty-state">{{ t('No recorded activity') }}</p><article v-for="event in events" :key="event.seq"><time>{{ formatDate(event.created) }}</time><strong>{{ t(event.kind.replaceAll('_',' ')) }}</strong><details><summary>{{ t('Details') }}</summary><pre>{{ JSON.stringify(event.detail,null,2) }}</pre></details></article><button v-if="nextCursor" class="button" @click="refresh(true)">{{ t('Load more') }}</button></section><IngestionHistory v-else /></main></template>
