<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {useLocale} from '../state/locale'
import BulkActions from './BulkActions.vue'
import {useWorkspace} from '../state/workspace'
import type {FiledDocument} from '../state/workspace'
import {useRouter} from '../state/navigation'
const {t,formatDate}=useLocale(),store=useWorkspace(),router=useRouter(),documents=ref<FiledDocument[]>([]),search=ref(''),savedSearch=ref(''),loading=ref(false),opening=ref(''),error=ref(''),nextCursor=ref<string|null>(null),page=ref(1)
const selection=ref<string[]>([]),bulkDocuments=computed(()=>documents.value.filter(doc=>selection.value.includes(doc.resourceId)))
const views=ref<{id:string;name:string;query:{search:string}}[]>([]),viewName=ref(''),selectedView=ref('')
async function loadViews(){try{views.value=(await store.request('saved-views')).views}catch(e){error.value=e instanceof Error?e.message:'Could not load saved views'}}
async function saveView(){try{views.value=(await store.request('saved-view-save',{id:selectedView.value||crypto.randomUUID(),name:viewName.value,query:{search:search.value}})).views;viewName.value=''}catch(e){error.value=e instanceof Error?e.message:'Could not save view'}}
async function deleteView(){try{views.value=(await store.request('saved-view-delete',{id:selectedView.value})).views;selectedView.value=''}catch(e){error.value=e instanceof Error?e.message:'Could not delete view'}}
function chooseView(){const view=views.value.find(v=>v.id===selectedView.value);if(view){search.value=view.query.search;viewName.value=view.name;start()}}
let searchTimer:ReturnType<typeof setTimeout>|undefined
watch(search,()=>{clearTimeout(searchTimer);searchTimer=setTimeout(start,300)})
const allSelected=computed(()=>documents.value.length>0&&documents.value.every(doc=>selection.value.includes(doc.resourceId)))
function selectPage(){selection.value=allSelected.value?[]:documents.value.map(doc=>doc.resourceId)}
let generation=0,alive=true,currentCursor:string|undefined
const previous:(string|undefined)[]=[]
async function load(cursor?:string){
 const version=++generation;loading.value=true;error.value=''
 try{
  if(!store.connection.value)await store.connect()
  const result=await store.request('documents',{search:savedSearch.value,limit:50,...(cursor?{cursor}:{})})
  if(version!==generation||!alive)return
  selection.value=[];documents.value=result.documents;nextCursor.value=result.nextCursor;currentCursor=cursor;return true
 }catch(e){if(version===generation&&alive)error.value=e instanceof Error?e.message:'Could not load filed documents';return false}
 finally{if(version===generation&&alive)loading.value=false}
}
function start(){clearTimeout(searchTimer);previous.length=0;page.value=1;documents.value=[];nextCursor.value=null;currentCursor=undefined;savedSearch.value=search.value;void load()}
async function next(){if(loading.value||!nextCursor.value)return;const before=currentCursor;if(await load(nextCursor.value)){previous.push(before);page.value++}}
async function back(){if(loading.value||!previous.length)return;if(await load(previous.at(-1))){previous.pop();page.value--}}
async function open(document:FiledDocument){
 if(opening.value)return;opening.value=document.id;error.value=''
 try{await store.openJob(document.id);if(alive)await router.push({path:'/document-workflow/documents',query:{job:document.id,from:'filed'}})}
 catch(e){if(alive)error.value=e instanceof Error?e.message:'Could not open the saved review'}finally{if(alive)opening.value=''}
}
onMounted(():void=>{void load();void loadViews()});onBeforeUnmount(()=>{alive=false;generation++;clearTimeout(searchTimer)})
</script>
<template>
 <section class="filed-library" :aria-label="t('Documents')">
  <div class="library-toolbar"><input v-model="search" type="search" maxlength="200" :aria-label="t('Search documents')" :placeholder="t('Search')" /><details class="saved-views"><summary>{{ t('Saved searches') }}</summary><label>{{ t('Open') }}<select v-model="selectedView" @change="chooseView"><option value="">—</option><option v-for="view in views" :key="view.id" :value="view.id">{{ view.name }}</option></select></label><form @submit.prevent="saveView"><input v-model="viewName" :aria-label="t('Search name')" :placeholder="t('Name')" maxlength="100" required /><button class="button">{{ t('Save') }}</button><button v-if="selectedView" type="button" class="icon-button" :aria-label="t('Delete saved search')" @click="deleteView">×</button></form></details></div>
  <p v-if="error" role="alert" class="error">{{ t(error) }}</p><p v-if="loading" role="status">{{ t('Loading…') }}</p>
  <BulkActions :documents="bulkDocuments" @changed="load()" />
  <section class="panel document-list"><table v-if="documents.length"><thead><tr><th class="selection-column"><input type="checkbox" :checked="allSelected" :aria-label="t('Select all')" @change="selectPage" /></th><th>{{ t('Document') }}</th><th>{{ t('Folder') }}</th><th>{{ t('Tags') }}</th></tr></thead><tbody><tr v-for="document in documents" :key="document.id"><td><input v-model="selection" type="checkbox" :value="document.resourceId" :aria-label="t('Select {name}',{name:document.path.split('/').pop()!})" /></td><td><button class="document-link" :disabled="!!opening||loading" @click="open(document)">{{ document.path.split('/').pop() }}</button><small>{{ document.sender }} · {{ document.date }}</small></td><td><span class="filed-path">{{ document.path.split('/').slice(0,-1).join('/') }}</span></td><td><span v-for="tag in document.tags" :key="tag" class="tag">{{ tag }}</span></td></tr></tbody></table><p v-else-if="!loading&&!error" class="empty-state">{{ t(savedSearch?'No matches':'No documents') }}</p></section>
  <nav v-if="page>1||nextCursor" class="library-pages" :aria-label="t('Pages')"><button class="icon-button" :disabled="loading||page===1" :aria-label="t('Previous page')" @click="back">←</button><span>{{ page }}</span><button class="icon-button" :disabled="loading||!nextCursor" :aria-label="t('Next page')" @click="next">→</button></nav>
 </section>
</template>
<style scoped>.library-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}.library-toolbar>input{flex:1;min-width:160px}.saved-views{position:relative;font-size:12px}.saved-views summary{cursor:pointer;padding:8px;color:var(--muted)}.saved-views[open]{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:10px}.saved-views label{display:block}.saved-views form{display:flex;gap:8px;margin-top:10px}.saved-views input{min-width:100px;width:160px}.saved-views select{display:block;width:100%;margin-top:6px}.selection-column{width:40px}.document-list input[type=checkbox]{width:16px;height:16px}.document-list td{vertical-align:middle}.filed-path{overflow-wrap:anywhere;font-size:12px}.library-pages{display:flex;justify-content:center;align-items:center;gap:20px;margin-top:18px;font-size:12px}.document-link{text-align:left;overflow-wrap:anywhere}</style>
