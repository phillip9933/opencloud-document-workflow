<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
import {validateValues} from '../domain/metadata'
import type {MetadataSchema} from '../domain/metadata'
interface MetadataView {
 source:{path:string;resourceId:string;etag:string;sha256:string;tags:string[]}
 schema:MetadataSchema
 record:{version:number;fields:Record<string,string|number>}
 suggestions:{fields:Record<string,{value:string|number;evidence:{page:number;quote:string}[]}>;tags:{value:string;evidence:{page:number;quote:string}[]}[]}
 pending:{id:string;state:string}[]
}
const props=defineProps<{path:string;resourceId:string;sha256:string;editableTags:boolean;locked?:boolean;documentSpace?:string}>()
const emit=defineEmits<{state:[value:{resourceId:string;dirty:boolean;busy:boolean;uncertain:boolean}];tag:[value:string]}>()
const store=useWorkspace(),{t}=useLocale(),data=ref<MetadataView|null>(null),values=ref<Record<string,string|number>>({}),baseline=ref<Record<string,string|number>>({}),loading=ref(false),saving=ref(false),stale=ref(false),error=ref(''),message=ref('')
const key=JSON.stringify([props.resourceId,props.sha256])
let generation=0,alive=true
const dirty=computed(()=>JSON.stringify(values.value)!==JSON.stringify(baseline.value))
const suggestedTags=computed(()=>data.value?.suggestions.tags.filter(tag=>!data.value!.source.tags.includes(tag.value))??[])
const savedTags=computed(()=>data.value?.schema.tags.filter(tag=>!data.value!.source.tags.includes(tag.tag)&&!suggestedTags.value.some(suggestion=>suggestion.value===tag.tag))??[])
watch([dirty,loading,saving,()=>data.value?.pending.length||0],()=>{if(alive)emit('state',{resourceId:props.resourceId,dirty:dirty.value,busy:loading.value||saving.value,uncertain:!!data.value?.pending.length})},{immediate:true})
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
<template><section class="inline-fields" :aria-label="t('Custom fields')"><p v-if="loading" role="status">{{ t('Loading…') }}</p><p v-if="error" role="alert" class="error">{{ t(error) }}</p><p v-if="message" role="status" class="message">{{ t(message) }}</p><template v-if="data"><p v-if="stale" role="alert" class="error">{{ t('Fields changed elsewhere. Your draft is retained.') }}</p><div v-for="field in data.schema.fields" :key="field.id" class="inline-field"><label :for="`review-field-${field.id}`">{{ field.label }}</label><select v-if="field.type==='choice'" :id="`review-field-${field.id}`" v-model="values[field.id]" :disabled="saving||locked||stale"><option value="">—</option><option v-for="choice in field.choices" :key="choice">{{ choice }}</option></select><input v-else :id="`review-field-${field.id}`" v-model="values[field.id]" :disabled="saving||locked||stale" :type="field.type==='number'?'number':field.type==='date'?'date':'text'" :step="field.type==='number'?'any':undefined" /><details v-if="data.suggestions.fields[field.id]" class="field-suggestion"><summary>{{ t('Suggestion') }}</summary><button class="button subtle" :disabled="saving||locked||stale" @click="values[field.id]=data.suggestions.fields[field.id].value">{{ data.suggestions.fields[field.id].value }}</button><blockquote v-for="(item,i) in data.suggestions.fields[field.id].evidence" :key="i">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></details></div><div v-if="data.schema.fields.length&&(dirty||stale)" class="field-actions"><button class="button" :disabled="!dirty||saving||loading||stale||locked||data.pending.length>0" @click="save">{{ t(saving?'Saving…':'Save fields') }}</button><button class="button subtle" :disabled="saving" @click="discard">{{ t('Restore saved values') }}</button></div><div v-for="item in data.pending" :key="item.id"><p class="error">{{ t('Outcome needs verification') }}</p><button class="button" :disabled="saving" @click="reconcile(item.id)">{{ t('Verify') }}</button></div><div v-if="editableTags&&savedTags.length" class="tag-library" role="group" :aria-label="t('Saved tags')"><button v-for="tag in savedTags" :key="tag.tag" type="button" class="button tag-choice" :aria-label="t('Add tag {tag}',{tag:tag.tag})" :disabled="saving||loading||locked" @click="emit('tag',tag.tag)">{{ tag.tag }}</button></div><details v-if="editableTags&&suggestedTags.length"><summary>{{ t('Suggested tags') }}</summary><div v-for="tag in suggestedTags" :key="tag.value" class="tag-suggestion"><button class="button" :disabled="saving||locked" @click="emit('tag',tag.value)">{{ tag.value }}</button><blockquote v-for="(item,i) in tag.evidence" :key="i">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></div></details></template><button v-else-if="!loading" class="button" @click="load">{{ t('Retry') }}</button></section></template>
<style scoped>.inline-fields{padding:12px 0}.inline-fields p,.inline-fields summary{font-size:12px}.inline-field{margin:14px 0}.inline-field label{display:block;font-size:12px;font-weight:600;margin:0 0 6px}.inline-field input,.inline-field select{width:100%}.field-suggestion{padding:6px 0}.field-suggestion .button{white-space:normal;text-align:left;font-size:12px}.field-suggestion summary,.tag-suggestion summary{cursor:pointer;color:var(--muted);padding:6px 0}blockquote{font-size:12px;border-left:2px solid var(--line);padding-left:10px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}blockquote small{display:block;color:var(--muted)}.field-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.draft-note{color:var(--warning-ink)!important}.tag-suggestion{margin:12px 0}.tag-library{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0}.tag-choice{padding:5px 9px;font-size:12px}.inline-fields h3{font-size:13px;margin-top:22px}</style>
