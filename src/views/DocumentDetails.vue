<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,computed,watch,onBeforeUnmount,defineAsyncComponent} from 'vue'
import {useInboxNavigation} from '../state/inbox-navigation'
import {useLocale} from '../state/locale'
import {useRoute,useRouter} from '../state/navigation'
import {useWorkspace,withinInbox} from '../state/workspace'
import type {MetadataSchema} from '../domain/metadata'
import {pdfHash} from '../domain/source'
type Suggestion={value:string|number;evidence:{page:number;quote:string}[]}
interface Detail{source:{path:string;resourceId:string;etag:string;sha256:string;tags:string[]};schema:MetadataSchema;record:{version:number;fields:Record<string,string|number>};suggestions:{fields:Record<string,Suggestion>;tags:Suggestion[]};pending:{id:string;state:string}[]}
const PdfPreview=defineAsyncComponent(()=>import('../components/PdfPreview.vue'))
const store=useWorkspace(),route=useRoute(),router=useRouter(),{t}=useLocale(),data=ref<Detail|null>(null),values=ref<Record<string,string|number>>({}),tags=ref(''),error=ref(''),message=ref(''),busy=ref(false),loading=ref(false),editing=ref(false),saveNeedsCheck=ref(false)
const previewError=ref(''),trashUncertain=ref(false)
const preview=ref<Blob|null>(null),previewOpen=ref(true),previewBusy=ref(false)
let generation=0,alive=true,previewGeneration=0
const scope=()=>store.connection.value&&JSON.stringify([store.connection.value.server,store.connection.value.account,store.connection.value.space])
const savedValues=()=>Object.fromEntries(data.value?.schema.fields.map(field=>[field.id,data.value!.record.fields[field.id]??''])??[])
const dirty=computed(()=>JSON.stringify(values.value)!==JSON.stringify(savedValues())||!!tags.value.trim())
const populated=computed(()=>data.value?.schema.fields.filter(field=>data.value!.record.fields[field.id]!==undefined)??[])
const selectedTags=computed(()=>tags.value.split(',').map(tag=>tag.trim()).filter(Boolean))
const suggestedTags=computed(()=>data.value?.suggestions.tags.filter(tag=>!data.value!.source.tags.includes(String(tag.value))&&!selectedTags.value.includes(String(tag.value)))??[])
const savedTags=computed(()=>data.value?.schema.tags.filter(tag=>!data.value!.source.tags.includes(tag.tag)&&!selectedTags.value.includes(tag.tag)&&!suggestedTags.value.some(suggestion=>suggestion.value===tag.tag))??[])
const navigation=useInboxNavigation(computed(()=>data.value?.source.resourceId),computed(()=>busy.value||loading.value||dirty.value))
const back=computed(()=>route.value.query.return==='filed'?{path:'/document-workflow/documents',query:{job:route.value.query.job,from:'filed'}}:route.value.query.return==='review'?{path:'/document-workflow/inbox',query:{job:route.value.query.job}}:'/document-workflow/inbox')
async function load({keepDraft=false}={}){
 const version=++generation;loading.value=true
 try{
  if(!store.connection.value)await store.connect()
  const pin=scope(),path=String(route.value.query.path??''),job=route.value.query.job
  const detail=await store.request('metadata',{path,...(typeof route.value.query.space==='string'?{documentSpace:route.value.query.space}:{})})
  if(typeof job==='string'){const saved=await store.request('job',{id:job});if(saved.job?.source.resourceId!==detail.source.resourceId){const location=await store.request('document-location',{id:job});if(location.resourceId!==detail.source.resourceId||location.path!==path||location.space!==route.value.query.space)throw new Error('This path now contains a different document. Return to its saved filing record.')}}
  if(!alive||version!==generation)return false
  if(scope()!==pin)throw new Error('The workspace changed. Reopen this document.')
  data.value=detail;if(route.value.query.return==='inbox'){const parent=detail.source.path.split('/').slice(0,-1).join('/');if(withinInbox(parent,store.inbox.value))store.folder.value=parent;await store.refresh();}if(!alive||version!==generation||scope()!==pin)return false;if(!keepDraft){values.value=savedValues();tags.value='';saveNeedsCheck.value=false}error.value='';void loadPreview();return true
 }catch(e){if(alive&&version===generation){if(!keepDraft)data.value=null;error.value=e instanceof Error?e.message:'Could not load document details'}return false}
 finally{if(alive&&version===generation)loading.value=false}
}
watch(()=>JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space]),()=>{editing.value=false;data.value=null;message.value='';trashUncertain.value=false;preview.value=null;previewError.value='';previewOpen.value=true;previewBusy.value=false;previewGeneration++;void load()},{immediate:true})
onBeforeUnmount(()=>{alive=false;generation++;previewGeneration++})
function startEdit(){values.value=savedValues();tags.value='';editing.value=true;message.value='';error.value=''}
function cancel(){values.value=savedValues();tags.value='';editing.value=false;error.value=''}
async function reload(){editing.value=false;message.value='';await load()}
async function save(){
 if(!data.value||busy.value||!dirty.value||saveNeedsCheck.value||data.value.pending.length)return
 busy.value=true;error.value='';message.value='';let posted=false;const context=JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space])
 try{
  const fields:Record<string,string|number>={}
  for(const field of data.value.schema.fields){const value=values.value[field.id];if(value!==''&&value!==undefined){if(field.type==='number'&&!Number.isFinite(Number(value)))throw new Error('Enter a valid number for '+field.label);fields[field.id]=field.type==='number'?Number(value):value}}
  const source=data.value.source;posted=true
  const result=await store.request('metadata-save',{path:source.path,...(typeof route.value.query.space==='string'?{documentSpace:route.value.query.space}:{}),resourceId:source.resourceId,etag:source.etag,sha256:source.sha256,version:data.value.record.version,fields,addTags:[...new Set(tags.value.split(',').map(tag=>tag.trim()).filter(Boolean))]})
  if(!alive||JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space])!==context)return
  const uncertain=result.uncertain===true
  if(await load({keepDraft:uncertain})){editing.value=uncertain;message.value=uncertain?'Outcome needs verification':'Saved'}
 }catch(e){if(alive&&JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space])===context){error.value=e instanceof Error?e.message:'Save held';saveNeedsCheck.value=posted}}
 finally{busy.value=false}
}
async function reconcile(id:string){
 if(busy.value)return;const context=JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space]),pin=scope();busy.value=true;error.value='';message.value=''
 try{const result=await store.request('metadata-reconcile',{id,...(typeof route.value.query.space==='string'?{documentSpace:route.value.query.space}:{})});if(!alive||scope()!==pin||JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space])!==context)return;if(await load({keepDraft:result.uncertain===true})){if(!result.uncertain)editing.value=false;message.value=result.uncertain?'Outcome needs verification':'Verified'}}
 catch(e){if(alive&&scope()===pin&&JSON.stringify([route.value.query.path,route.value.query.job,route.value.query.space])===context)error.value=e instanceof Error?e.message:'Verification held'}finally{busy.value=false}
}
function useTag(value:string|number){if(busy.value||loading.value||!editing.value)return;tags.value=[...new Set([...selectedTags.value,String(value)])].join(', ')}
async function loadPreview(){
 if(preview.value||previewBusy.value||!data.value)return
 const version=++previewGeneration,source=data.value.source;previewBusy.value=true
 try{const blob=await store.request('preview',{path:source.path,...(typeof route.value.query.space==='string'?{documentSpace:route.value.query.space}:{})});if(await pdfHash(blob)!==source.sha256)throw new Error('The PDF changed. Reload document details before opening it.');if(alive&&version===previewGeneration)preview.value=blob}
 catch(e){if(alive&&version===previewGeneration)previewError.value=e instanceof Error?e.message:'PDF unavailable'}finally{if(alive&&version===previewGeneration)previewBusy.value=false}
}
async function prepare(){if(!data.value||busy.value||dirty.value)return;busy.value=true;error.value='';try{const result=await store.prepareDocument(data.value.source.path,{retry:true,cloudConsent:cloudConsent.value});await router.push({path:'/document-workflow/inbox',query:{job:result.id}})}catch(e){error.value=e instanceof Error?e.message:'Preparation held'}finally{busy.value=false}}
const cloudConsent=ref(false)
const duplicate=computed(()=>store.files.value.find(file=>file.resourceId===data.value?.source.resourceId)?.duplicate)
async function openOriginal(){if(!duplicate.value?.job||busy.value)return;busy.value=true;error.value='';try{const id=duplicate.value.job,location=await store.request('document-location',{id});await router.push({path:'/document-workflow/details',query:{path:location.path,job:id,return:'filed',space:location.space}})}catch(e){error.value=e instanceof Error?e.message:'Could not open original'}finally{busy.value=false}}
async function trashDuplicate(){
 if(!duplicate.value||!data.value||busy.value||dirty.value||data.value.pending.length)return
 const id=duplicate.value.id,resource=data.value.source.resourceId,before=navigation.snapshot(),verify=trashUncertain.value||duplicate.value.uncertain
 busy.value=true;error.value='';trashUncertain.value=true
 try{const result=await store.request(verify?'duplicate-verify':'duplicate-trash',{id});if(!alive)return;if(result.state==='trashed'){busy.value=false;await store.refresh();await navigation.advance(before,resource)}else{trashUncertain.value=result.uncertain===true;error.value=result.detail??'Trash outcome needs verification'}}catch(e){if(alive)error.value=e instanceof Error?e.message:'Trash outcome needs verification'}finally{busy.value=false}
}
</script>
<template>
 <main class="screen document-details">
  <header class="screen-heading editor-heading"><nav v-if="route.query.return==='inbox'" class="inbox-navigation" :aria-label="t('Document navigation')"><RouterLink class="button subtle" to="/document-workflow/inbox" :aria-label="t('Back to inbox')">{{ t('Inbox') }}</RouterLink><button class="icon-button" :disabled="!navigation.canPrevious.value" :aria-label="t('Previous document')" :title="t('Previous document')" @click="navigation.move(-1)">‹</button><span v-if="navigation.position.value">{{ navigation.position.value }} / {{ navigation.total.value }}</span><button class="icon-button" :disabled="!navigation.canNext.value" :aria-label="t('Next document')" :title="t('Next document')" @click="navigation.move(1)">›</button></nav><RouterLink v-else class="icon-button" :to="back" :aria-label="t('Back')">←</RouterLink><h1>{{ data?.source.path.split('/').pop()||t('Document') }}</h1><button v-if="data&&duplicate" class="button" :disabled="busy||dirty||data.pending.length>0" @click="trashDuplicate">{{ t(trashUncertain||duplicate.uncertain?'Verify Trash outcome':'Move to OpenCloud Trash') }}</button><button v-else-if="data&&route.query.return==='inbox'" class="button primary" :disabled="busy||dirty" @click="prepare">{{ t(busy?'Preparing…':'Prepare') }}</button></header>
  <p v-if="loading" role="status">{{ t('Loading…') }}</p><p v-if="error||navigation.error.value" class="error" role="alert">{{ t(error||navigation.error.value) }}</p><p v-if="message" class="message" role="status">{{ t(message) }}</p>
  <label v-if="route.query.return==='inbox'&&Object.values(store.ai.value.tasks).includes('cloud')" class="check-label"><input v-model="cloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label>
  <p v-if="duplicate" class="duplicate-notice">{{ t('Exact duplicate') }} <button v-if="duplicate.job" class="button subtle" :disabled="busy" @click="openOriginal">{{ t('Open original') }}</button></p>
  <div v-if="data" class="details-layout">
   <section class="panel detail-preview" :aria-label="t('Original document')"><p v-if="previewBusy" role="status">{{ t('Loading…') }}</p><PdfPreview v-else-if="preview" :data="preview" :filename="data.source.path.split('/').pop()" /><p v-else-if="previewError" role="alert" class="error">{{ t(previewError) }}</p></section>
   <div>
    <section v-if="data.pending.length" class="panel pending-metadata" :aria-label="t('Pending verification')"><p>{{ t('Outcome needs verification') }}</p><button v-for="pending in data.pending" :key="pending.id" class="button" :disabled="busy" @click="reconcile(pending.id)">{{ t('Verify') }}</button></section>
    <section v-if="!editing" class="panel saved-details" :aria-label="t('Document details')"><div class="details-heading"><h2>{{ t('Fields') }}</h2><button class="icon-button" :disabled="busy||data.pending.length>0" :aria-label="t('Edit details')" :title="t('Edit details')" @click="startEdit">✎</button></div><dl v-if="populated.length" class="metadata-values"><div v-for="field in populated" :key="field.id"><dt>{{ field.label }}</dt><dd>{{ data.record.fields[field.id] }}</dd></div></dl><p v-else class="empty-value">—</p><div class="saved-tags"><h3>{{ t('Tags') }}</h3><div v-if="data.source.tags.length" class="tag-list"><span v-for="tag in data.source.tags" :key="tag" class="tag">{{ tag }}</span></div><p v-else class="empty-value">—</p></div></section>
    <form v-else class="panel metadata-edit" :aria-label="t('Edit document details')" @submit.prevent="save"><p v-if="saveNeedsCheck" class="error">{{ t('Verify the last save before continuing') }}</p><div class="metadata-edit-grid"><section><div v-for="field in data.schema.fields" :key="field.id" class="metadata-field"><label :for="`field-${field.id}`">{{ field.label }}</label><select v-if="field.type==='choice'" :id="`field-${field.id}`" v-model="values[field.id]" :disabled="busy"><option value="">—</option><option v-for="choice in field.choices" :key="choice">{{ choice }}</option></select><input v-else :id="`field-${field.id}`" v-model="values[field.id]" :disabled="busy" :type="field.type==='number'?'number':field.type==='date'?'date':'text'" :step="field.type==='number'?'any':undefined" /><details v-if="data.suggestions.fields[field.id]&&String(data.suggestions.fields[field.id].value)!==String(values[field.id])" class="metadata-suggestion"><summary>{{ t('Suggestion') }}</summary><button type="button" class="button subtle" :disabled="busy" @click="values[field.id]=data.suggestions.fields[field.id].value">{{ data.suggestions.fields[field.id].value }}</button><blockquote v-for="(quote,index) in data.suggestions.fields[field.id].evidence" :key="index">{{ quote.quote }} <small>{{ t('Page {number}',{number:quote.page}) }}</small></blockquote></details></div></section><section class="edit-tags"><div class="tag-list"><span v-for="tag in data.source.tags" :key="tag" class="tag">{{ tag }}</span></div><label for="extra-tags">{{ t('Tags to add') }}</label><input id="extra-tags" v-model="tags" :disabled="busy" /><div v-if="savedTags.length" class="tag-library" role="group" :aria-label="t('Saved tags')"><button v-for="tag in savedTags" :key="tag.tag" type="button" class="button tag-choice" :aria-label="t('Add tag {tag}',{tag:tag.tag})" :disabled="busy" @click="useTag(tag.tag)">{{ tag.tag }}</button></div><details v-if="suggestedTags.length" class="metadata-suggestion"><summary>{{ t('Suggestions') }}</summary><div v-for="tag in suggestedTags" :key="tag.value"><button type="button" class="button subtle" :disabled="busy" @click="useTag(tag.value)">{{ tag.value }}</button><blockquote v-for="(quote,index) in tag.evidence" :key="index">{{ quote.quote }} <small>{{ t('Page {number}',{number:quote.page}) }}</small></blockquote></div></details></section></div><footer class="metadata-actions"><button class="button primary" :disabled="busy||!dirty||saveNeedsCheck||data.pending.length>0" type="submit">{{ t('Save') }}</button><button type="button" class="button subtle" :disabled="busy" @click="cancel">{{ t('Cancel') }}</button><button v-if="saveNeedsCheck" type="button" class="button" :disabled="busy" @click="reload">{{ t('Reload') }}</button></footer></form>
    <details class="document-technical"><summary>{{ t('File information') }}</summary><dl><dt>{{ t('Location') }}</dt><dd>{{ data.source.path }}</dd><dt>{{ t('Resource') }}</dt><dd>{{ data.source.resourceId }}</dd><dt>SHA256</dt><dd>{{ data.source.sha256 }}</dd><dt>{{ t('Version') }}</dt><dd>{{ data.record.version }}</dd></dl></details>
   </div>
  </div>
 </main>
</template>
<style scoped>
.document-details{max-width:1200px}.document-details h1{font-size:25px;overflow-wrap:anywhere;max-width:850px}.saved-details,.metadata-edit,.pending-metadata,.detail-preview{padding:24px;margin:22px 0}.details-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.details-heading h2{margin:0}.metadata-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:26px 0}.metadata-values dt{font-size:12px;color:var(--muted)}.metadata-values dd{margin:5px 0 0;overflow-wrap:anywhere;font-weight:600}.saved-tags{border-top:1px solid var(--line);padding-top:20px;margin-top:24px}.saved-tags h3,.metadata-edit h3{font-size:13px;margin:0 0 12px}.tag-library{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.tag-choice{padding:5px 9px;font-size:12px}.tag-list{display:flex;flex-wrap:wrap;gap:4px}.metadata-edit-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:40px;margin-top:28px}.metadata-field{margin-bottom:22px}.metadata-field label,.edit-tags label{display:block;font-size:12px;font-weight:600;margin:0 0 7px}.metadata-field input,.metadata-field select,.edit-tags input{width:100%}.edit-tags label{margin-top:20px}.draft-status,.fine-print{font-size:12px;color:var(--muted)}.metadata-suggestion{font-size:12px;margin-top:10px}.metadata-suggestion summary,.document-technical summary{cursor:pointer;color:var(--accent-text);padding:7px 0}.metadata-suggestion .button{white-space:normal;text-align:left}.metadata-suggestion blockquote{border-left:2px solid var(--line);padding-left:12px;margin:8px 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}.metadata-suggestion blockquote small{display:block;color:var(--muted)}.metadata-actions{position:sticky;bottom:-1px;background:var(--surface);border-top:1px solid var(--line);padding:18px 0 0;display:flex;gap:10px;flex-wrap:wrap;z-index:2}.document-technical{font-size:12px;margin-top:24px;color:var(--muted)}.document-technical dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px}.document-technical dd{margin:0;overflow-wrap:anywhere}.document-technical a{display:inline-block;color:var(--accent-text);margin-top:12px}.pending-metadata .button{margin-top:14px}@media(max-width:700px){.metadata-edit-grid,.metadata-values{grid-template-columns:1fr;gap:18px}.saved-details,.metadata-edit,.pending-metadata,.detail-preview{padding:18px}.document-details h1{font-size:22px}.metadata-actions{padding-bottom:8px}.details-heading{align-items:start}}
.details-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px;align-items:start}.details-layout .detail-preview,.details-layout .saved-details,.details-layout .metadata-edit{margin:0}.details-layout .metadata-edit-grid{grid-template-columns:1fr;gap:24px;margin-top:0}.details-layout .metadata-values{grid-template-columns:1fr;gap:20px}.editor-heading{justify-content:start;gap:14px}.editor-heading h1{font-size:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.editor-heading .button.primary{margin-left:auto}.empty-value{color:var(--muted)}@media(max-width:850px){.details-layout{grid-template-columns:1fr}}
</style>
