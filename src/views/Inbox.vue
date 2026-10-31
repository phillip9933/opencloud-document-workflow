<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed,ref,onMounted,onBeforeUnmount} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useRoute,useRouter} from '../state/navigation'
import {useLocale} from '../state/locale'
import {statusLabel} from '../domain/status'
import BulkActions from '../components/BulkActions.vue'
import ReviewInbox from './ReviewInbox.vue'
const store=useWorkspace(),route=useRoute(),router=useRouter(),{t}=useLocale(),search=store.inboxSearch,selection=ref<string[]>([]),busy=ref(false),error=ref('')
const requestedJob=computed(()=>typeof route.value.query.job==='string'),rows=computed(()=>store.files.value.filter(file=>file.intakeState!=='processed'&&file.reviewState!=='done').filter(file=>`${file.path} ${file.tags.join(' ')} ${Object.values(file.fields??{}).join(' ')}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const checking=computed(()=>!!store.intakeHealth.value?.manualCheck)
async function checkNow(){if(busy.value||checking.value)return;busy.value=true;error.value='';try{await store.request('intake-scan')}catch(e){error.value=e instanceof Error?e.message:'Could not check inbox';return}finally{busy.value=false}await refresh()}
const selected=computed(()=>rows.value.filter(file=>!file.folder&&selection.value.includes(file.resourceId))),allSelected=computed(()=>rows.value.some(file=>!file.folder)&&rows.value.filter(file=>!file.folder).every(file=>selection.value.includes(file.resourceId)))
function selectPage(){selection.value=allSelected.value?[]:rows.value.filter(file=>!file.folder).map(file=>file.resourceId)}
function jobFor(resource:string){return store.jobs.value.find(job=>job.source.resourceId===resource)}
function status(resource:string,fallback?:string|null){const job=jobFor(resource);return t(job?.automation?.state==='done'?'Processed':statusLabel(job?.decision||job?.state||fallback||'unprocessed'))}
async function refresh(){if(busy.value)return;busy.value=true;error.value='';try{if(!store.connection.value)await store.connect();await store.refresh()}catch(e){error.value=e instanceof Error?e.message:'Could not load inbox'}finally{busy.value=false}}
async function browse(path:string){store.folder.value=path;selection.value=[];await refresh()}
async function open(file:typeof rows.value[number]){
 if(file.folder)return browse(file.path)
 busy.value=true;error.value=''
 try{store.beginInboxNavigation(rows.value);await router.push(await store.inboxLocation(file))}catch(e){error.value=e instanceof Error?e.message:'Could not open document'}finally{busy.value=false}
}
let timer:ReturnType<typeof setInterval>|undefined,lastRefresh=0
onMounted(()=>{void refresh();timer=setInterval(()=>{if(!requestedJob.value&&!busy.value&&(checking.value||Date.now()-lastRefresh>=10000)){lastRefresh=Date.now();void refresh()}},1000)})
onBeforeUnmount(()=>clearInterval(timer))
</script>
<template>
 <ReviewInbox v-if="requestedJob" collection="inbox" />
 <main v-else class="screen inbox-screen">
  <header class="screen-heading"><h1>{{ t('Inbox') }}</h1><button v-if="store.intakeConfigured.value" class="button" :disabled="busy||checking||!store.intakeEnabled.value" @click="checkNow">{{ t(checking?'Checking…':'Check now') }}</button><button v-if="store.connection.value?.mode==='demo'" class="button" @click="store.request('demo-add-scan').then(refresh).catch(e=>error=e.message)">{{ t('Add test PDF') }}</button><RouterLink v-if="store.intakeConfigured.value && store.folderLocation(store.inbox.value)" class="button primary" :to="store.folderLocation(store.inbox.value)!" target="_blank" rel="noopener">{{ t('Add documents') }}</RouterLink></header>
  <p v-if="store.intakeHealth.value?.manualCheck==='settling'" class="fine-print" role="status">{{ t('Waiting for uploads to finish…') }}</p>
  <p v-if="error||store.intakeHealth.value?.reason" role="alert" class="error">{{ t(error||store.intakeHealth.value?.message||'Could not check inbox') }}</p>
  <section v-if="!store.connection.value" class="empty-state"><button class="button" :disabled="busy" @click="refresh">{{ t(busy?'Connecting…':'Connect') }}</button></section>
  <section v-else-if="!store.intakeConfigured.value" class="empty-state"><RouterLink class="button primary" to="/document-workflow/settings/ingestion">{{ t('Choose inbox') }}</RouterLink></section>
  <template v-else>
   <div class="inbox-toolbar"><input v-model="search" type="search" :aria-label="t('Search inbox')" :placeholder="t('Search')" /></div>
   <nav v-if="store.folder.value !== store.inbox.value" class="breadcrumbs" :aria-label="t('Folders')"><button class="button subtle" @click="browse(store.inbox.value)">{{ t('Inbox') }}</button><span>{{ store.folder.value.slice(store.inbox.value.length+1) }}</span><button class="icon-button" :aria-label="t('Parent folder')" @click="browse(store.folder.value.split('/').slice(0,-1).join('/'))">↑</button></nav>
   <BulkActions :documents="selected" prepare file @changed="refresh" />
   <section class="panel document-list"><table v-if="rows.length"><thead><tr><th class="selection-column"><input type="checkbox" :checked="allSelected" :aria-label="t('Select all')" @change="selectPage" /></th><th>{{ t('Document') }}</th><th>{{ t('Status') }}</th><th>{{ t('Tags') }}</th></tr></thead><tbody><tr v-for="file in rows" :key="file.resourceId"><td><input v-if="!file.folder" v-model="selection" type="checkbox" :value="file.resourceId" :aria-label="t('Select {name}',{name:file.path.split('/').pop()!})" /></td><td><button class="document-link" @click="open(file)"><span v-if="file.folder" aria-hidden="true">▱ </span>{{ file.path.split('/').pop() }}</button></td><td><span v-if="!file.folder" class="pill">{{ status(file.resourceId,file.reviewState||file.intakeState) }}</span></td><td><span v-for="tag in file.tags" :key="tag" class="tag">{{ tag }}</span></td></tr></tbody></table><p v-else-if="!busy" class="empty-state">{{ t(search?'No matches':'Inbox is empty') }}</p></section>
  </template>
 </main>
</template>
<style scoped>.screen-heading h1{margin:0}.inbox-toolbar{display:flex;gap:10px;margin-bottom:20px}.inbox-toolbar input{flex:1;min-width:0}.selection-column{width:40px}.document-list input[type=checkbox]{width:16px;height:16px}.document-list td{vertical-align:middle}.document-list .document-link{overflow-wrap:anywhere;text-align:left}</style>
