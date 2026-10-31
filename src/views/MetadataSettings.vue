<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,onMounted} from 'vue'
import {useLocale} from '../state/locale'
import {useWorkspace} from '../state/workspace'
import {defaultMetadataSchema,validateMetadataSchema} from '../domain/metadata'
import type {MetadataSchema,TagRule} from '../domain/metadata'
const store=useWorkspace(),{t}=useLocale(),schema=ref<MetadataSchema>(defaultMetadataSchema()),error=ref(''),message=ref('')
onMounted(async()=>{try{if(!store.connection.value)await store.connect();schema.value=await store.request('metadata-schema')}catch(e){error.value=e instanceof Error?e.message:'Connection failed'}})
function addField(){let n=schema.value.fields.length+1;while(schema.value.fields.some(f=>f.id===`field_${n}`))n++;schema.value.fields.push({id:`field_${n}`,label:'',type:'text',aliases:[],choices:[]})}
function split(value:string){return value.split(',').map(v=>v.trim()).filter(Boolean)}
function setTagMatch(rule:TagRule,event:Event){if((event.target as HTMLSelectElement).value==='name')rule.match='name';else delete rule.match}
async function save(){try{schema.value=await store.request('metadata-schema-save',{schema:validateMetadataSchema(JSON.parse(JSON.stringify(schema.value)))});message.value='Saved';error.value=''}catch(e){error.value=e instanceof Error?e.message:'Save failed'}}
</script>
<template>
 <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
 <p v-if="message" class="message" role="status">{{ t(message) }}</p>
 <section class="panel metadata-panel">
  <h2>{{ t('Custom fields') }}</h2>
  <p class="section-description">{{ t('Add details such as invoice number or due date. Enter them on documents, or match printed labels to extract values automatically.') }}</p>
  <p class="field-hint">{{ t('Printed labels match text such as Invoice number: 123. Keep a field’s ID unchanged after saving document values.') }}</p>
  <div v-for="(field,i) in schema.fields" :key="i" class="definition-card" role="group" :aria-label="field.label||field.id">
   <div class="definition-fields">
    <label>{{ t('Stable ID') }}<input v-model="field.id" placeholder="invoice_number" /></label>
    <label>{{ t('Label') }}<input v-model="field.label" /></label>
    <label>{{ t('Type') }}<select v-model="field.type"><option value="text">{{ t('Text') }}</option><option value="number">{{ t('Number') }}</option><option value="date">{{ t('Date') }}</option><option value="choice">{{ t('Choice') }}</option></select></label>
    <label>{{ t('Printed labels, separated by commas') }}<input :value="field.aliases.join(', ')" @change="field.aliases=split(($event.target as HTMLInputElement).value)" /></label>
    <label v-if="field.type==='choice'" class="definition-wide">{{ t('Choices, separated by commas') }}<input :value="field.choices.join(', ')" @change="field.choices=split(($event.target as HTMLInputElement).value)" /></label>
   </div>
   <div class="definition-actions"><button type="button" class="icon-button" :aria-label="t('Remove field')" @click="schema.fields.splice(i,1)">×</button></div>
  </div>
  <button type="button" class="button" @click="addField">{{ t('Add field') }}</button>
 </section>
 <section class="panel metadata-panel">
  <h2>{{ t('Saved tags') }}</h2>
  <p id="saved-tags-help" class="section-description">{{ t('Reusable tags for manual selection or keyword matching, without AI. Leave terms blank for manual use. Example: “guarantee” → Warranty.') }}</p>
  <div v-for="(rule,i) in schema.tags" :key="i" class="definition-card" role="group" :aria-label="rule.tag||t('Tag')">
   <div class="definition-fields">
    <label>{{ t('Tag') }}<input v-model="rule.tag" /></label>
    <label>{{ t('Matching') }}<select :value="rule.match??'substring'" @change="setTagMatch(rule,$event)"><option value="substring">{{ t('Contains text') }}</option><option value="name">{{ t('Name aliases') }}</option></select><small v-if="rule.match==='name'">{{ t('Name aliases ignore letter case and character width.') }}</small></label>
    <label class="definition-wide">{{ t('Matching terms, separated by commas (optional)') }}<input :value="rule.terms.join(', ')" aria-describedby="saved-tags-help" @change="rule.terms=split(($event.target as HTMLInputElement).value)" /></label>
   </div>
   <div class="definition-actions"><button type="button" class="icon-button" :aria-label="t('Remove tag')" @click="schema.tags.splice(i,1)">×</button></div>
  </div>
  <button type="button" class="button" @click="schema.tags.push({tag:'',terms:[]})">{{ t('Add tag') }}</button>
 </section>
 <button type="button" class="button primary" @click="save">{{ t('Save') }}</button>
</template>

<style scoped>
.metadata-panel.panel>h2{margin-bottom:0}
.metadata-panel>.section-description{font-size:13px;max-width:780px;margin:8px 0 20px}
.metadata-panel>.field-hint{font-size:12px;color:var(--muted);margin:-8px 0 22px;max-width:780px}
.metadata-panel .definition-card{display:grid;grid-template-columns:minmax(0,1fr) 36px;align-items:start;gap:16px;margin:16px 0;padding:16px;border:1px solid var(--line);border-radius:6px}
.metadata-panel .definition-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:16px;min-width:0}
.metadata-panel .definition-fields>label{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0;font-size:13px}
.metadata-panel .definition-fields input,.metadata-panel .definition-fields select{width:100%;min-width:0}
.metadata-panel .definition-fields small{font-size:12px;color:var(--muted);line-height:1.5}
.metadata-panel .definition-wide{grid-column:1/-1}
.metadata-panel .definition-actions{display:flex;align-items:flex-start;justify-content:flex-end}
.metadata-panel .definition-actions>.icon-button{align-self:flex-start;flex:none;margin:0}
@media(max-width:700px){.metadata-panel .definition-fields{grid-template-columns:minmax(0,1fr)}.metadata-panel .definition-card{gap:12px}}
</style>
