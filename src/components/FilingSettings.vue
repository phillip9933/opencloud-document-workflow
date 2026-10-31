<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,onMounted} from 'vue'
import {useLocale} from '../state/locale'
import {useWorkspace} from '../state/workspace'
import {defaultFilingRules,validateFilingRules} from '../domain/filing'
import type {ClassificationRule,FolderClassificationRule} from '../domain/filing'
const props=defineProps<{mode?:'capacity'}>()
const store=useWorkspace(),{t}=useLocale(),rules=ref(defaultFilingRules()),limits=ref({maxMiB:100,maxPages:1000,maxCharacters:1000000,documentsPerCycle:20,contextTokens:32768}),languages=ref('[]'),busy=ref(false),error=ref(''),message=ref(''),targetSpace=ref(''),pickerOpen=ref(false),pickerPath=ref(''),folders=ref<{path:string}[]>([])
async function load(){busy.value=true;try{if(!store.connection.value)await store.connect();const result=await store.request('filing-settings');rules.value=validateFilingRules(result.rules);targetSpace.value=result.destinationSpace??store.connection.value?.space??'';if(!result.limits)throw new Error('Processing capacity is unavailable');limits.value=result.limits;languages.value=JSON.stringify(result.rules.languages,null,2);error.value=''}catch(e){error.value=e instanceof Error?e.message:'Could not load filing settings'}finally{busy.value=false}}
async function save(){busy.value=true;error.value='';message.value='';try{const checked=validateFilingRules({...rules.value,languages:JSON.parse(languages.value)});await store.request('filing-settings-save',{rules:checked,limits:limits.value,destinationSpace:targetSpace.value});rules.value=checked;message.value='Saved. New documents use these rules.'}catch(e){error.value=e instanceof Error?e.message:'Could not save filing settings'}finally{busy.value=false}}
async function browse(path:string){busy.value=true;error.value='';try{const value=await store.request('files',{path,documentSpace:targetSpace.value});folders.value=value.files.filter((f:any)=>f.folder);pickerPath.value=path;pickerOpen.value=true}catch(e){error.value=e instanceof Error?e.message:'Folder unavailable'}finally{busy.value=false}}
function categoryPattern(row:ClassificationRule){return (row as FolderClassificationRule).folderTemplate??''}
function categoryLabels(row:ClassificationRule){return (row as FolderClassificationRule).taxYearLabels?.join(', ')??''}
function setCategoryPattern(row:ClassificationRule,event:Event){const folder=row as FolderClassificationRule,value=(event.target as HTMLInputElement).value.trim();if(value)folder.folderTemplate=value;else delete folder.folderTemplate;if(!value.includes('{taxYear}'))delete folder.taxYearLabels}
function setCategoryLabels(row:ClassificationRule,event:Event){const folder=row as FolderClassificationRule,labels=(event.target as HTMLInputElement).value.split(',').map(label=>label.trim()).filter(Boolean);if(labels.length)folder.taxYearLabels=labels;else delete folder.taxYearLabels}
onMounted(():void=>{void load()})
</script>
<template>
 <section class="panel filing-settings">
  <form @submit.prevent="save"><fieldset :disabled="busy">
   <template v-if="!props.mode">
    <label for="filing-destination-space">{{ t('Destination Space') }}</label>
    <select id="filing-destination-space" v-model="targetSpace" @change="pickerOpen=false"><option v-for="space in store.spaces.value" :key="space.id" :value="space.id">{{ space.name }}</option></select>
    <label for="filing-destination-folder">{{ t('Destination folder') }}</label>
    <div class="folder-input"><input id="filing-destination-folder" v-model="rules.root" required /><button type="button" class="button" @click="browse('')">{{ t('Choose') }}</button></div>
    <section v-if="pickerOpen" class="folder-picker" :aria-label="t('Choose folder')">
     <div class="folder-path"><button v-if="pickerPath" type="button" class="icon-button" :aria-label="t('Parent folder')" @click="browse(pickerPath.split('/').slice(0,-1).join('/'))">↑</button><span>{{ pickerPath||store.spaces.value.find(space=>space.id===targetSpace)?.name }}</span></div>
     <button v-for="folder in folders" :key="folder.path" type="button" class="folder-choice" @click="browse(folder.path)">{{ folder.path.split('/').pop() }}</button>
     <div class="picker-actions"><button type="button" class="button primary" :disabled="!pickerPath" @click="rules.root=pickerPath;pickerOpen=false">{{ t('Use this folder') }}</button><button type="button" class="button subtle" @click="pickerOpen=false">{{ t('Cancel') }}</button></div>
    </section>
    <details class="filing-patterns">
     <summary>{{ t('Filing patterns') }}</summary>
     <div class="filing-patterns-body">
      <p id="filing-patterns-help" class="fine-print">{{ t('Patterns name the subfolders and files inside this destination.') }}</p>
      <div class="pattern-fields">
       <label>{{ t('Subfolder pattern') }}<input v-model="rules.folderTemplate" aria-describedby="filing-patterns-help" required /></label>
       <label>{{ t('Filename pattern') }}<input v-model="rules.nameTemplate" aria-describedby="filing-patterns-help" required /></label>
      </div>
      <section class="pattern-reference" aria-labelledby="filing-pattern-reference-title">
       <h3 id="filing-pattern-reference-title">{{ t('Pattern reference') }}</h3>
       <dl>
        <dt>{{ t('Subfolders') }}</dt><dd><code>{category}</code>, <code>{year}</code>, <code>{month}</code>, <code>{day}</code></dd>
        <dt>{{ t('Filename') }}</dt><dd><code>{date}</code>, <code>{issuer}</code>, <code>{kind}</code>, <code>{original}</code>, <code>{year}</code>, <code>{month}</code>, <code>{day}</code>, <code>{resource}</code></dd>
       </dl>
       <div class="pattern-examples"><div><code>{category}/{year}</code> → <code>Receipts/2026</code></div><div><code>{date} {issuer} {kind}.pdf</code> → <code>2026-10-31 Example Receipt.pdf</code></div></div>
      </section>
      <details class="filing-section rules-settings">
       <summary>{{ t('Categories & evidence rules') }}</summary>
       <div class="filing-section-body">
        <p class="fine-print">{{ t('Terms must appear in quoted text. Keep Other for unmatched documents.') }}</p>
        <section v-for="key in (['folders','tags'] as const)" :key="key" class="classification-section">
         <h3>{{ t(key==='folders'?'Folder categories':'AI tag suggestions') }}</h3>
         <p v-if="key==='tags'" id="ai-tag-suggestions-help" class="fine-print">{{ t('Tags the AI may suggest when matching text appears in a document. Example: “invoice” → Invoice.') }}</p>
         <div v-for="(row,index) in rules[key]" :key="index" class="classification-rule" role="group" :aria-label="row.value||t(key==='folders'?'Category':'Tag')">
          <div class="classification-row">
           <input v-model="row.value" class="rule-name" :aria-label="t('Rule {number}: name',{number:index+1})" :placeholder="t('Category or tag')" required />
           <input :value="row.terms.join(', ')" class="rule-terms" :aria-label="t('Rule {number}: evidence',{number:index+1})" :aria-describedby="key==='tags'?'ai-tag-suggestions-help':undefined" :placeholder="t('Terms, separated by commas')" @change="row.terms=($event.target as HTMLInputElement).value.split(',').map(v=>v.trim()).filter(Boolean)" />
           <select v-model="row.match" class="rule-matching" :aria-label="t('Rule {number}: matching',{number:index+1})"><option value="word">{{ t('Whole term') }}</option><option value="substring">{{ t('Contains term') }}</option></select>
           <button type="button" class="icon-button rule-remove" :aria-label="t('Remove rule')" :disabled="key==='folders'&&row.value==='Other'" @click="rules[key].splice(index,1)">×</button>
          </div>
          <details v-if="key==='folders'" class="category-pattern">
           <summary>{{ t('Category pattern') }}</summary>
           <div class="category-pattern-body">
            <p>{{ t('Leave blank to use the main pattern. {year} uses the document date; {taxYear} needs one clear printed tax year.') }}</p>
            <label>{{ t('Subfolder pattern') }}<input :value="categoryPattern(row)" :aria-label="t('Rule {number}: subfolder pattern',{number:index+1})" :placeholder="rules.folderTemplate" @change="setCategoryPattern(row,$event)" /></label>
            <label v-if="categoryPattern(row).includes('{taxYear}')">{{ t('Printed tax-year labels, separated by commas') }}<input :value="categoryLabels(row)" :aria-label="t('Rule {number}: tax-year labels',{number:index+1})" placeholder="Tax year, 対象年" required @change="setCategoryLabels(row,$event)" /></label>
           </div>
          </details>
         </div>
         <button type="button" class="button" @click="rules[key].push({value:'',terms:[],match:'word'})">{{ t(key==='folders'?'Add category':'Add tag') }}</button>
        </section>
       </div>
      </details>
      <details class="filing-section language-rules">
       <summary>{{ t('Document interpretation rules') }}</summary>
       <div class="filing-section-body"><p id="document-interpretation-help" class="fine-print">{{ t('Recognize date formats and document terms across languages. Example: “2026年10月31日” → “2026-10-31”.') }}</p><label>{{ t('Rule definitions (JSON)') }}<textarea v-model="languages" rows="10" spellcheck="false" aria-describedby="document-interpretation-help" /></label></div>
      </details>
     </div>
    </details>
   </template>
   <template v-if="props.mode==='capacity'">
    <label>{{ t('Maximum PDF size (MiB)') }}<input v-model.number="limits.maxMiB" type="number" min="1" max="1024" /></label>
    <label>{{ t('Maximum pages per PDF') }}<input v-model.number="limits.maxPages" type="number" min="1" max="10000" /></label>
    <label>{{ t('Maximum extracted characters') }}<input v-model.number="limits.maxCharacters" type="number" min="1000" max="8000000" /></label>
    <label>{{ t('Model context (tokens)') }}<input v-model.number="limits.contextTokens" type="number" min="8192" max="1048576" /></label>
    <label>{{ t('Documents per cycle') }}<input v-model.number="limits.documentsPerCycle" type="number" min="1" max="1000" /></label>
   </template>
   <div class="settings-footer"><button class="button primary">{{ t('Save') }}</button></div>
  </fieldset></form>
  <p v-if="error" role="alert" class="error">{{ t(error) }}</p><p v-if="message" role="status" class="message">{{ t(message) }}</p>
 </section>
</template>
<style scoped>
.folder-input{display:flex;gap:10px}.folder-input input{flex:1;min-width:0}.folder-picker{padding:16px;border:1px solid var(--line);border-radius:6px;margin-top:16px}.folder-path,.picker-actions{display:flex;gap:12px;align-items:center}.folder-choice{display:block;background:transparent;border:0;padding:10px;color:var(--ink);font:inherit;cursor:pointer;width:100%;text-align:left}.folder-choice:hover{background:var(--subtle)}.picker-actions{margin-top:12px}select{display:block;width:100%;margin-top:6px}fieldset{border:0;padding:0;margin:0}label{display:block;margin-top:14px}input,textarea{display:block;width:100%}small{display:block;color:var(--muted);margin-top:6px;font-size:11px}summary{cursor:pointer;color:var(--ink)}summary:focus-visible{outline:2px solid var(--focus);outline-offset:4px;border-radius:2px}summary:focus:not(:focus-visible){outline:none}.filing-patterns{margin-top:24px;border-top:1px solid var(--line)}.filing-patterns>summary{padding:16px 0;font-size:16px;font-weight:650}.filing-patterns-body{padding-left:16px}.pattern-fields{display:grid;gap:16px;margin-top:16px}.pattern-fields>label{margin:0;font-size:13px}.pattern-fields input{margin-top:8px}.pattern-reference{margin:18px 0 24px;padding-left:16px;border-left:2px solid var(--line);font-size:12px;color:var(--muted)}.pattern-reference h3{font-size:12px;font-weight:600;color:var(--ink);margin:0 0 10px}.pattern-reference dl{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px 12px;margin:0}.pattern-reference dt{font-weight:500}.pattern-reference dd{margin:0;overflow-wrap:anywhere}.pattern-reference code{font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:inherit;background:none;border:0;border-radius:0;padding:0;white-space:normal;overflow-wrap:anywhere}.pattern-examples{display:grid;gap:6px;margin-top:12px}.filing-section{margin-top:24px;padding-top:4px;border-top:1px solid var(--line)}.filing-section>summary{padding:14px 0;font-size:14px;font-weight:600}.filing-section-body{padding-left:16px}.classification-section{margin-top:24px}.classification-section h3{font-size:14px;font-weight:600;color:var(--ink);margin:0 0 12px}.classification-section>.fine-print{margin-bottom:14px}.classification-rule{padding:16px;margin:12px 0;border:1px solid var(--line);border-radius:6px;background:var(--surface)}.classification-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(130px,.8fr) 32px;gap:8px;align-items:start}.classification-row input{min-width:0}.classification-row select{margin-top:0}.rule-remove{width:32px;height:40px;margin:0;align-self:start}.category-pattern{margin-top:12px;padding-top:6px;border-top:1px solid var(--line)}.category-pattern>summary{padding:6px 0;font-size:12px;font-weight:500;color:var(--muted)}.category-pattern-body{padding-left:12px}.category-pattern p{font-size:12px;color:var(--muted);margin:4px 0}.category-pattern label{font-size:12px}.language-rules textarea{margin-top:8px}.settings-footer{margin-top:24px}
@media(max-width:900px){.classification-row{grid-template-columns:minmax(0,1fr) 32px}.rule-name{grid-column:1;grid-row:1}.rule-remove{grid-column:2;grid-row:1}.rule-terms,.rule-matching{grid-column:1/-1}}
@media(max-width:700px){.filing-patterns-body,.filing-section-body{padding-left:12px}.pattern-reference{padding-left:12px}.pattern-reference dl{grid-template-columns:1fr;gap:4px}.pattern-reference dd+dt{margin-top:8px}}
</style>
