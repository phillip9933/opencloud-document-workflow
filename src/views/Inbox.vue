<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed,ref,onMounted,onBeforeUnmount} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useRoute,useRouter} from '../state/navigation'
import {useLocale} from '../state/locale'
import {processingProgress,processingStatus} from '../domain/processing'
import type {DraftFile} from '../state/workspace'
import ProcessingProgress from '../components/ProcessingProgress.vue'
import QueueTotals from '../components/QueueTotals.vue'
import BulkActions from '../components/BulkActions.vue'
import ReviewInbox from './ReviewInbox.vue'
const store=useWorkspace(),route=useRoute(),router=useRouter(),{t,locale}=useLocale(),search=store.inboxSearch,selection=ref<string[]>([]),busy=ref(false),error=ref('')
type SortColumn='Document'|'Folder'|'Status'|'Stage'|'Tags'
const sortColumn=ref<SortColumn>('Document'),sortDescending=ref(false),columns:SortColumn[]=['Document','Folder','Status','Stage','Tags']
function sortBy(column:SortColumn){if(sortColumn.value===column)sortDescending.value=!sortDescending.value;else{sortColumn.value=column;sortDescending.value=false}}
function sortValue(file:DraftFile,column:SortColumn):string|number{if(column==='Stage')return(file.progress??processingProgress(file)).step;if(column==='Status')return t(processingStatus(file));if(column==='Tags')return file.tags.join(', ');const parts=file.path.split('/');return column==='Document'?parts.at(-1)!:parts.slice(0,-1).join('/')}
const requestedJob=computed(()=>typeof route.value.query.job==='string'),rows=computed(()=>{
 const collator=new Intl.Collator(locale.value,{numeric:true,sensitivity:'base'}),compare=(a:DraftFile,b:DraftFile)=>{const left=sortValue(a,sortColumn.value),right=sortValue(b,sortColumn.value);return(typeof left==='number'&&typeof right==='number'?left-right:collator.compare(String(left),String(right)))*(sortDescending.value?-1:1)||collator.compare(a.path,b.path)||a.resourceId.localeCompare(b.resourceId)}
 return store.files.value.filter(file=>!file.folder&&file.intakeState!=='processed'&&file.reviewState!=='done').filter(file=>`${file.path} ${file.tags.join(' ')} ${Object.values(file.fields??{}).join(' ')}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).sort(compare)
})
const checking=computed(()=>!!store.intakeHealth.value?.manualCheck)
async function checkNow(){if(busy.value||checking.value)return;busy.value=true;error.value='';try{await store.request('intake-scan')}catch(e){error.value=e instanceof Error?e.message:'Could not check inbox';return}finally{busy.value=false}await refresh()}
const selected=computed(()=>rows.value.filter(file=>!file.folder&&selection.value.includes(file.resourceId))),allSelected=computed(()=>rows.value.some(file=>!file.folder)&&rows.value.filter(file=>!file.folder).every(file=>selection.value.includes(file.resourceId)))
function selectPage(){selection.value=allSelected.value?[]:rows.value.filter(file=>!file.folder).map(file=>file.resourceId)}
async function refresh(){if(busy.value)return;busy.value=true;error.value='';try{if(!store.connection.value)await store.connect();await store.refresh()}catch(e){error.value=e instanceof Error?e.message:'Could not load inbox'}finally{busy.value=false}}
async function open(file:typeof rows.value[number]){
 busy.value=true;error.value=''
 try{store.beginInboxNavigation(rows.value);await router.push(await store.inboxLocation(file))}catch(e){error.value=e instanceof Error?e.message:'Could not open document'}finally{busy.value=false}
}
let timer:ReturnType<typeof setInterval>|undefined,lastRefresh=0
onMounted(()=>{if(!requestedJob.value)void refresh();timer=setInterval(()=>{if(!requestedJob.value&&!busy.value&&(checking.value||Date.now()-lastRefresh>=10000)){lastRefresh=Date.now();void refresh()}},1000)})
onBeforeUnmount(()=>clearInterval(timer))
</script>
<template>
 <ReviewInbox v-if="requestedJob" collection="inbox" />
 <main v-else class="screen inbox-screen">
  <header class="screen-heading"><h1>{{ t('Inbox') }} <small v-if="store.inboxSummary.value" class="discovered-total">{{ t('{count} discovered',{count:store.inboxSummary.value.total}) }}</small></h1><button v-if="store.intakeConfigured.value" class="button" :disabled="busy||checking||!store.intakeEnabled.value||store.intakePaused.value" @click="checkNow">{{ t(checking?'Checking…':'Check now') }}</button><button v-if="store.connection.value?.mode==='demo'" class="button" @click="store.request('demo-add-scan').then(refresh).catch(e=>error=e.message)">{{ t('Add test PDF') }}</button><RouterLink v-if="store.intakeConfigured.value && store.folderLocation(store.inbox.value)" class="button primary" :to="store.folderLocation(store.inbox.value)!" target="_blank" rel="noopener">{{ t('Add documents') }}</RouterLink></header>
  <p v-if="store.intakeHealth.value?.manualCheck==='settling'" class="fine-print" role="status">{{ t('Waiting for uploads to finish…') }}</p>
  <p v-if="error||store.intakeHealth.value?.reason" role="alert" class="error">{{ t(error||store.intakeHealth.value?.message||'Could not check inbox') }}</p>
  <section v-if="!store.connection.value" class="empty-state"><button class="button" :disabled="busy" @click="refresh">{{ t(busy?'Connecting…':'Connect') }}</button></section>
  <section v-else-if="!store.intakeConfigured.value" class="empty-state"><RouterLink class="button primary" to="/document-workflow/settings/ingestion">{{ t('Choose inbox') }}</RouterLink></section>
  <template v-else>
   <QueueTotals v-if="store.inboxSummary.value" class="inbox-totals" :summary="store.inboxSummary.value" /><div class="inbox-toolbar"><input v-model="search" type="search" :aria-label="t('Search inbox')" :placeholder="t('Search')" /></div>
   <BulkActions :documents="selected" prepare file @changed="refresh" />
   <section class="panel document-list"><table v-if="rows.length"><thead><tr><th class="selection-column"><input type="checkbox" :checked="allSelected" :aria-label="t('Select all')" @change="selectPage" /></th><th v-for="column in columns" :key="column" :aria-sort="sortColumn===column?(sortDescending?'descending':'ascending'):'none'"><button class="column-sort" @click="sortBy(column)">{{ t(column) }}<span v-if="sortColumn===column" aria-hidden="true">{{ sortDescending?'↓':'↑' }}</span></button></th></tr></thead><tbody><tr v-for="file in rows" :key="file.resourceId"><td><input v-if="!file.folder" v-model="selection" type="checkbox" :value="file.resourceId" :aria-label="t('Select {name}',{name:file.path.split('/').pop()!})" /></td><td><button class="document-link" @click="open(file)">{{ file.path.split('/').pop() }}</button></td><td class="folder-path">{{ file.path.split('/').slice(0,-1).join('/') }}</td><td>{{ t(processingStatus(file)) }}</td><td><ProcessingProgress :item="file" stage-only /></td><td><span v-for="tag in file.tags" :key="tag" class="tag">{{ tag }}</span></td></tr></tbody></table><p v-else-if="!busy" class="empty-state">{{ t(search?'No matches':'Inbox is empty') }}</p></section>
  </template>
 </main>
</template>
<style scoped>.column-sort{display:inline-flex;gap:8px;align-items:center;color:inherit;font:inherit;border:0;background:none;padding:0;cursor:pointer}.column-sort:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.inbox-totals{margin:0 0 24px}.discovered-total{font-size:14px;font-weight:400;color:var(--muted);margin-left:14px;white-space:nowrap}.folder-path{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.screen-heading h1{margin:0}.inbox-toolbar{display:flex;gap:10px;margin-bottom:20px}.inbox-toolbar input{flex:1;min-width:0}.selection-column{width:40px}.document-list input[type=checkbox]{width:16px;height:16px}.document-list td{vertical-align:middle}.document-list .document-link{overflow-wrap:anywhere;text-align:left}</style>
