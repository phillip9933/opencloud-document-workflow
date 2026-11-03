<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
import TagPicker from './TagPicker.vue'
import {validateValues} from '../domain/metadata'
import type {MetadataSchema} from '../domain/metadata'
interface MetadataView {
 trash?:{id:string}|null
 source:{path:string;resourceId:string;etag:string;sha256:string;tags:string[]}
 schema:MetadataSchema
 record:{version:number;fields:Record<string,string|number>}
 suggestions:{fields:Record<string,{value:string|number;evidence:{page:number;quote:string}[]}>;tags:{value:string;evidence:{page:number;quote:string}[]}[]}
 pending:{id:string;state:string}[]
}
const props=defineProps<{path:string;resourceId:string;sha256:string;editableTags:boolean;selectedTags?:string[];newTags?:string[];tagEvidence?:{value:string;evidence:{page:number;quote:string}[]}[];tagOptions?:string[];locked?:boolean;documentSpace?:string}>()
const emit=defineEmits<{state:[value:{resourceId:string;dirty:boolean;busy:boolean;uncertain:boolean}];tag:[value:string];tags:[value:string]}>()
const store=useWorkspace(),{t}=useLocale(),data=ref<MetadataView|null>(null),values=ref<Record<string,string|number>>({}),baseline=ref<Record<string,string|number>>({}),loading=ref(false),saving=ref(false),stale=ref(false),error=ref(''),message=ref('')
const key=JSON.stringify([props.resourceId,props.sha256])
let generation=0,alive=true
const dirty=computed(()=>JSON.stringify(values.value)!==JSON.stringify(baseline.value))
const selected=computed(()=>props.selectedTags??[]),suggestedTags=computed(()=>data.value?.suggestions.tags.filter(tag=>!data.value!.source.tags.includes(tag.value)&&!selected.value.includes(tag.value))??[])
const savedTags=computed(()=>data.value?.schema.tags.filter(tag=>!data.value!.source.tags.includes(tag.tag)&&!selected.value.includes(tag.tag)&&!suggestedTags.value.some(suggestion=>suggestion.value===tag.tag))??[])
watch([dirty,loading,saving,()=>data.value?.pending.length||0,()=>data.value?.trash?.id],()=>{if(alive)emit('state',{resourceId:props.resourceId,dirty:dirty.value,busy:loading.value||saving.value,uncertain:!!data.value?.trash||!!data.value?.pending.length})},{immediate:true})
watch(values,()=>{if(!data.value)return;if(dirty.value)store.fieldDrafts.value[key]={version:store.fieldDrafts.value[key]?.version??data.value.record.version,values:JSON.parse(JSON.stringify(values.value))};else delete store.fieldDrafts.value[key]},{deep:true})
async function load(){
 const version=++generation;loading.value=true;error.value=''
 try{
  const result:MetadataView=await store.request('metadata',{path:props.path,...(props.documentSpace?{documentSpace:props.documentSpace}:{})})
  if(version!==generation||!alive)return
  if(result.source.resourceId!==props.resourceId||result.source.sha256!==props.sha256)throw new Error('The source document changed. Refresh its review before editing fields.')
  data.value=result;baseline.value=Object.fromEntries(result.schema.fields.map(field=>[field.id,result.record.fields[field.id]??'']))
  const draft=store.fieldDrafts.value[key];stale.value=!!draft&&(draft.version!==result.record.version||Object.keys(draft.values).some(id=>!result.schema.fields.some(field=>field.id===id)))
  values.value=draft?{...baseline.value,...draft.values}:{...baseline.value}
 }catch(e){if(version===generation&&alive)error.value=e instanceof Error?e.message:'Could not load custom fields'}
 finally{if(version===generation&&alive)loading.value=false}
}
function discard(){values.value={...baseline.value};stale.value=false;delete store.fieldDrafts.value[key];error.value='';message.value='Saved values restored'}
async function save(){
 if(!data.value||saving.value||loading.value||stale.value||props.locked||!dirty.value)return
 saving.value=true;error.value='';message.value=''
 try{
  const fields=Object.fromEntries(Object.entries(values.value).filter(([,value])=>value!==''&&value!==undefined).map(([id,value])=>[id,data.value!.schema.fields.find(f=>f.id===id)?.type==='number'?Number(value):value]))
  const checked=validateValues(data.value.schema,fields),source=data.value.source
  const result=await store.request('metadata-save',{path:props.path,...(props.documentSpace?{documentSpace:props.documentSpace}:{}),resourceId:source.resourceId,etag:source.etag,sha256:source.sha256,version:data.value.record.version,fields:checked,addTags:[]})
  if(!alive)return
  if(result.uncertain){message.value='Outcome needs verification';await load();return}
  delete store.fieldDrafts.value[key];await load();message.value='Saved'
  const file=store.files.value.find(file=>file.resourceId===props.resourceId);if(file&&data.value)file.fields={...data.value.record.fields}
 }catch(e){if(alive)error.value=e instanceof Error?e.message:'Field save held'}
 finally{if(alive)saving.value=false}
}
async function reconcile(id:string){
 if(saving.value)return;saving.value=true;error.value=''
 try{const result=await store.request('metadata-reconcile',{id,...(props.documentSpace?{documentSpace:props.documentSpace}:{})});if(!alive)return;if(!result.uncertain)delete store.fieldDrafts.value[key];await load();message.value=result.uncertain?'Outcome needs verification':'Verified'}
 catch(e){if(alive)error.value=e instanceof Error?e.message:'Recheck held'}finally{if(alive)saving.value=false}
}
watch(()=>props.path,()=>void load())
onMounted(load)
onBeforeUnmount(()=>{alive=false;generation++})
</script>
<template>
 <section class="review-step review-fields-section" :aria-label="t('Custom fields')">
  <p v-if="loading" role="status">{{ t('Loading…') }}</p><p v-if="data?.trash" class="error">{{ t('Verify Trash outcome') }}</p><p v-if="error" role="alert" class="error">{{ t(error) }}</p><p v-if="message" role="status" class="message">{{ t(message) }}</p>
  <details class="inline-fields"><summary><h2>{{ t('Fields') }}</h2></summary><template v-if="data"><p v-if="stale" role="alert" class="error">{{ t('Fields changed elsewhere. Your draft is retained.') }}</p>
   <div v-for="field in data.schema.fields" :key="field.id" class="inline-field"><label :for="`review-field-${field.id}`">{{ field.label }}</label><select v-if="field.type==='choice'" :id="`review-field-${field.id}`" v-model="values[field.id]" :disabled="saving||locked||!!data.trash||stale"><option value="">—</option><option v-for="choice in field.choices" :key="choice">{{ choice }}</option></select><input v-else :id="`review-field-${field.id}`" v-model="values[field.id]" :disabled="saving||locked||!!data.trash||stale" :type="field.type==='number'?'number':field.type==='date'?'date':'text'" :step="field.type==='number'?'any':undefined" /><details v-if="data.suggestions.fields[field.id]" class="field-suggestion"><summary>{{ t('Suggestion') }}</summary><button class="button subtle" :disabled="saving||locked||!!data.trash||stale" @click="values[field.id]=data.suggestions.fields[field.id].value">{{ data.suggestions.fields[field.id].value }}</button><blockquote v-for="(item,i) in data.suggestions.fields[field.id].evidence" :key="i">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></details></div>
   <div v-if="data.schema.fields.length&&(dirty||stale)" class="field-actions"><button class="button primary" :disabled="!dirty||saving||loading||stale||locked||data.pending.length>0" @click="save">{{ t(saving?'Saving…':'Save fields') }}</button><button class="button subtle" :disabled="saving" @click="discard">{{ t('Restore saved values') }}</button></div><div v-for="item in data.pending" :key="item.id"><p class="error">{{ t('Outcome needs verification') }}</p><button class="button" :disabled="saving" @click="reconcile(item.id)">{{ t('Verify') }}</button></div>
  </template><button v-else-if="!loading" class="button" @click="load">{{ t('Retry') }}</button></details>
 </section>
 <section class="review-step review-tags-section" :aria-label="t('Tags')"><h2>{{ t('Tags') }}</h2>
  <div v-if="data?.source.tags.length" class="existing-tags"><span v-for="tag in data.source.tags" :key="tag" class="tag">{{ tag }}</span></div>
  <template v-if="editableTags"><label for="manual-tags" class="tag-label">{{ t('Tags to add') }}</label><TagPicker id="manual-tags" :model-value="selected.join(', ')" :options="[...savedTags.map(tag=>tag.tag),...(tagOptions??[])]" :new-tags="newTags" collapse-input :disabled="saving||loading||locked||!!error||!!data?.trash||!!data?.pending.length" @update:model-value="emit('tags',$event)" />
   <section v-if="suggestedTags.length" class="suggested-tag-group"><h3>{{ t('Suggested tags') }}</h3><div v-for="tag in suggestedTags" :key="tag.value" class="tag-suggestion"><button type="button" class="button tag-choice" :aria-label="t('Add tag {tag}',{tag:tag.value})" :disabled="saving||locked" @click="emit('tag',tag.value)">{{ tag.value }}</button><details><summary>{{ t('Evidence') }}</summary><blockquote v-for="(item,i) in tag.evidence" :key="i">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></details></div></section>
  </template><div v-else><span v-for="tag in selected.filter(tag=>!data?.source.tags.includes(tag))" :key="tag" class="tag">{{ tag }}</span></div>
  <details v-if="tagEvidence?.length" class="tag-evidence"><summary>{{ t('Evidence') }}</summary><div v-for="tag in tagEvidence" :key="tag.value"><strong>{{ tag.value }}</strong><blockquote v-for="(item,i) in tag.evidence" :key="i">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></div></details>
 </section>
</template>
<style scoped>
.review-step{padding:22px 0;border-bottom:1px solid var(--line)}.review-step h2{font-size:15px}.inline-fields>summary{cursor:pointer;color:var(--ink)}.inline-fields>summary h2{display:inline;font-size:16px;font-weight:600}.inline-field{margin:14px 0}.inline-field label,.tag-label{display:block;font-size:12px;font-weight:600;margin:0 0 6px}.inline-field input,.inline-field select{width:100%}.field-suggestion{padding:6px 0}.field-suggestion .button{white-space:normal;text-align:left;font-size:12px}.field-suggestion summary,.tag-suggestion summary,.tag-evidence>summary{cursor:pointer;color:var(--muted);font-size:12px;padding:6px 0}blockquote{font-size:12px;border-left:2px solid var(--line);padding-left:10px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}blockquote small{display:block;color:var(--muted)}.field-actions{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0;padding:16px 0;border-top:1px solid var(--line)}.tag-suggestion{margin:12px 0}.existing-tags{margin-bottom:12px}.suggested-tag-group h3{font-size:12px;color:var(--muted);font-weight:500;margin:16px 0 8px}.tag-evidence{margin-top:16px}.tag-evidence strong{font-size:12px}
</style>
