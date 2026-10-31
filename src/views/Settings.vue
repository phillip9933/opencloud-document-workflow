<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { ref, watch, computed } from 'vue'
import { useRoute } from '../state/navigation'
import { aiTasks, useWorkspace, validateAIConfig } from '../state/workspace'
import GeneralSettings from '../components/GeneralSettings.vue'
import FolderSettings from '../components/FolderSettings.vue'
import OCRLanguages from '../components/OCRLanguages.vue'
import {useLocale} from '../state/locale'
import FilingSettings from '../components/FilingSettings.vue'
import MetadataSettings from './MetadataSettings.vue'
import ReliabilityStatus from '../components/ReliabilityStatus.vue'
import BackupSettings from '../components/BackupSettings.vue'
import type { Policy } from '../domain/review'
import { discoverLocalModels } from '../domain/local-ai'
import type { LocalModel } from '../domain/local-ai'
const store=useWorkspace()
const {t}=useLocale()
const { policy, ai, connection, capabilities } = store
const route = useRoute()
const draftPolicy=ref<Policy>(JSON.parse(JSON.stringify(policy.value)))
watch(policy,value=>{draftPolicy.value=JSON.parse(JSON.stringify(value))})
const draft = ref(JSON.parse(JSON.stringify(ai.value)))
watch(ai,value=>{draft.value=JSON.parse(JSON.stringify(value))})
const message = ref(''), error = ref('')
const models = ref<LocalModel[]>([]), testing = ref(false),providerCustomizing=ref(false)
watch(() => draft.value.local.endpoint, () => { models.value=[] })
async function saveProcessing(){try{const result=await store.savePreferences({policy:draftPolicy.value,ai:ai.value});message.value=result.paused?'Saved. Ingestion paused.':'Saved';error.value=''}catch(e){error.value=e instanceof Error?e.message:'Save failed'}}
async function testLocal() {
  if(testing.value)return
  testing.value=true; message.value=''; error.value=''
  try { models.value=connection.value ? (await store.request('models')).models : await discoverLocalModels(draft.value.local.endpoint); message.value='Connected' }
  catch(e){models.value=[];error.value=e instanceof Error?e.message:'Local connection failed'}
  finally{testing.value=false}
}
watch(() => route.value.params.section, () => { message.value = ''; error.value = '' })
const features: { key: keyof Policy; label: string; detail: string }[] = [
  { key: 'fields', label: 'Custom fields', detail: 'Fill unambiguous extracted fields automatically or leave suggestions for review; existing values are preserved.' },
  { key: 'ocr', label: 'OCR', detail: 'Extract missing page text locally with installed Tesseract language packs. Original PDF bytes are preserved.' },
  { key: 'rename', label: 'Filenames', detail: 'Derive a filename from the verified sender, date and document type.' },
  { key: 'move', label: 'Folders', detail: 'Suggest a destination using the document’s evidence-backed category.' },
  { key: 'tags', label: 'Tags', detail: 'Suggest relevant tags while preserving existing ones.' },
  { key: 'aiInput', label: 'AI input', detail: 'Control the submission of extracted text to a selected model.' },
  { key: 'aiOutput', label: 'AI output', detail: 'Control the generation of filing proposals from model output.' }
]
async function saveAI() {
  try { const result=await store.savePreferences({policy:policy.value,ai:validateAIConfig(JSON.parse(JSON.stringify(draft.value)))}); error.value = ''; message.value=result.paused?'Saved. Ingestion paused.':'Saved' }
  catch (e) { error.value = e instanceof Error ? e.message : 'Invalid settings'; message.value = '' }
}
const providerPreset=computed(()=>new Set(Object.values(draft.value.tasks)).size===1&&Object.values(draft.value.modelOverrides).every(value=>!String(value).trim())?draft.value.tasks.facts:'custom')
function chooseProvider(value:string){providerCustomizing.value=value==='custom';if(['off','local','cloud'].includes(value))for(const task of aiTasks){draft.value.tasks[task.id]=value;draft.value.modelOverrides[task.id]=''}}
const customizing=ref(false)
const section=computed(()=>['folders','ingestion','filing'].includes(String(route.value.params.section))?'folders':['ai','automation','processing'].includes(String(route.value.params.section))?'processing':['reliability','system'].includes(String(route.value.params.section))?'system':String(route.value.params.section||'general'))
const processingPreset=computed(()=>Object.values(draftPolicy.value).every(mode=>mode==='automatic')?'automatic':Object.entries(draftPolicy.value).every(([key,mode])=>mode==='suggest'||key==='ocr'&&mode==='off')?'review':'custom')
function chooseProcessing(value:string){customizing.value=value==='custom';if(value==='automatic')draftPolicy.value={ocr:'automatic',rename:'automatic',move:'automatic',tags:'automatic',fields:'automatic',aiInput:'automatic',aiOutput:'automatic'};if(value==='review')draftPolicy.value={ocr:'suggest',rename:'suggest',move:'suggest',tags:'suggest',fields:'suggest',aiInput:'suggest',aiOutput:'suggest'}}
</script>
<template>
 <main class="screen settings-screen">
  <header class="screen-heading"><h1>{{ t('Settings') }}</h1></header>
  <nav class="settings-tabs" :aria-label="t('Settings sections')"><RouterLink :aria-current="['general','appearance'].includes(section)?'page':undefined" to="/document-workflow/settings">{{ t('General') }}</RouterLink><RouterLink :aria-current="section==='folders'?'page':undefined" to="/document-workflow/settings/folders">{{ t('Folders') }}</RouterLink><RouterLink :aria-current="section==='processing'?'page':undefined" to="/document-workflow/settings/processing">{{ t('Processing') }}</RouterLink><RouterLink :aria-current="section==='metadata'?'page':undefined" to="/document-workflow/settings/metadata">{{ t('Fields & tags') }}</RouterLink><RouterLink :aria-current="section==='system'?'page':undefined" to="/document-workflow/settings/system">{{ t('System') }}</RouterLink></nav>
  <GeneralSettings v-if="section==='general'||section==='appearance'" />
  <FolderSettings v-else-if="section==='folders'" />
  <MetadataSettings v-else-if="section==='metadata'" />
  <template v-else-if="section==='system'"><ReliabilityStatus /><BackupSettings /></template>
  <template v-else>
   <section class="panel automation-panel"><h2>{{ t('Document processing') }}</h2><label for="processing-mode">{{ t('Processing mode') }}</label><select id="processing-mode" :value="customizing?'custom':processingPreset" @change="chooseProcessing(($event.target as HTMLSelectElement).value)"><option value="review">{{ t('Review first') }}</option><option value="automatic">{{ t('Automatic') }}</option><option value="custom">{{ t('Custom') }}</option></select><p class="mode-description">{{ t(customizing||processingPreset==='custom'?'Choose which steps run automatically and which wait for review.':processingPreset==='automatic'?'File documents using your saved rules. Uncertain results stay in the inbox.':'Prepare documents and wait for you to review their filing details.') }}</p><div v-if="customizing||processingPreset==='custom'" class="advanced-settings"><div v-for="feature in features" :key="feature.key" class="setting-row"><div><label :for="feature.key">{{ t(feature.label) }}</label><p class="step-description">{{ t(feature.detail) }}</p></div><select :id="feature.key" v-model="draftPolicy[feature.key]"><option value="off">{{ t('Off') }}</option><option value="suggest">{{ t('Review') }}</option><option value="automatic">{{ t('Automatic') }}</option></select></div></div><div class="settings-footer"><button class="button primary" :aria-label="t('Save processing')" @click="saveProcessing">{{ t('Save') }}</button></div></section>
   <OCRLanguages />
   <details class="panel settings-disclosure model-section" :open="route.params.section==='ai'"><summary>{{ t('AI models') }}</summary>
  <form class="model-settings" @submit.prevent="saveAI">
   <div class="model-body"><label for="ai-provider">{{ t('Provider') }}</label><select id="ai-provider" :value="providerCustomizing?'custom':providerPreset" @change="chooseProvider(($event.target as HTMLSelectElement).value)"><option value="off">{{ t('Off') }}</option><option value="local">{{ t('Local AI') }}</option><option value="cloud">{{ t('Cloud AI') }}</option><option value="custom">{{ t('Custom') }}</option></select>
    <section v-if="providerCustomizing||Object.values(draft.tasks).includes('local')" class="provider-fields"><label for="local-endpoint">{{ t('Local endpoint') }}</label><input id="local-endpoint" v-model="draft.local.endpoint" type="url" /><label for="local-model">{{ t('Local model') }}</label><div class="model-input"><input id="local-model" v-model="draft.local.model" list="local-models" /><datalist id="local-models"><option v-for="model in models" :key="model.name" :value="model.name" /></datalist><button type="button" class="button" :disabled="testing" @click="testLocal">{{ t('Check') }}</button></div></section>
    <section v-if="Object.values(draft.tasks).includes('cloud')" class="provider-fields"><p v-if="!capabilities.cloudEnabled" class="warning">{{ t('Cloud provider is not configured') }}</p><label for="cloud-endpoint">{{ t('Cloud endpoint') }}</label><input id="cloud-endpoint" v-model="draft.cloud.endpoint" type="url" /><label for="cloud-model">{{ t('Cloud model') }}</label><input id="cloud-model" v-model="draft.cloud.model" /></section>
    <section v-if="providerCustomizing||providerPreset==='custom'" class="advanced-settings task-routing"><h3>{{ t('Task routing') }}</h3><div v-for="task in aiTasks" :key="task.id" class="setting-row"><label :for="`task-${task.id}`">{{ t(task.label) }}</label><div class="task-controls"><select :id="`task-${task.id}`" v-model="draft.tasks[task.id]"><option value="off">{{ t('Off') }}</option><option value="local">{{ t('Local AI') }}</option><option value="cloud">{{ t('Cloud AI') }}</option></select><input v-model="draft.modelOverrides[task.id]" :aria-label="t('Model for {task}',{task:t(task.label)})" :disabled="draft.tasks[task.id]==='off'" :placeholder="t('Default model')" /></div></div></section>
   </div><div class="settings-footer"><button class="button primary">{{ t('Save') }}</button></div>
  </form>
   </details><details class="panel settings-disclosure capacity-section"><summary>{{ t('Processing capacity') }}</summary><div class="capacity-body"><FilingSettings mode="capacity" /></div></details>
  </template>
  <p v-if="error" role="alert" class="error">{{ t(error) }}</p><p v-if="message" role="status" class="message">{{ t(message) }}</p>
 </main>
</template>
<style scoped>
.screen.settings-screen{--settings-content-width:900px;max-width:980px}
.settings-screen>.screen-heading,.settings-screen>.settings-tabs,.settings-screen>:deep(.panel),.settings-screen>:deep(.folder-settings),.settings-screen>:deep(.error),.settings-screen>:deep(.message){width:100%;max-width:var(--settings-content-width);min-width:0}
.settings-screen>:deep(.panel){padding:24px;margin-bottom:22px}
.screen-heading h1{margin:0}
.mode-description{font-size:13px;max-width:660px;line-height:1.6}
.step-description{font-size:12px!important;font-weight:400!important;max-width:520px;line-height:1.6}
label{display:block;margin:16px 0 8px;font-size:13px}
label:first-child{margin-top:0}
.automation-panel>select,.model-body>select{display:block;width:100%;max-width:360px}
.settings-disclosure>summary{cursor:pointer;color:var(--ink);font-size:16px;font-weight:600;line-height:1.5;padding:0}
.settings-disclosure>summary::marker{color:var(--muted)}
.settings-disclosure>summary:focus-visible{outline:2px solid var(--focus);outline-offset:5px;border-radius:2px}
.settings-disclosure>summary:focus:not(:focus-visible){outline:none;box-shadow:none}
.model-settings,.capacity-body{margin-top:20px;border-top:1px solid var(--line);padding-top:20px}
.model-body{min-width:0}
.capacity-body :deep(.filing-settings){padding:0;margin:0;border:0;background:transparent;border-radius:0}
.provider-fields{margin-top:20px;padding:16px;border:1px solid var(--line);border-radius:6px}
.provider-fields input{width:100%}
.model-input{display:flex;gap:10px;align-items:center}
.model-input input{flex:1;min-width:0}
.advanced-settings{margin-top:20px;border-top:1px solid var(--line);padding-top:4px}
.setting-row{padding:16px 0;gap:24px}
.setting-row>div{min-width:0}
.setting-row label{margin:0}
.task-routing{padding-top:20px}
.task-routing h3{font-size:14px;font-weight:600;color:var(--ink);margin:0 0 8px}
.task-routing .setting-row:first-of-type{border-top:0}
.automation-panel>.settings-footer,.model-settings>.settings-footer{justify-content:flex-start;flex-wrap:wrap;gap:10px;margin-top:20px}
@media(max-width:700px){
 .settings-screen>:deep(.panel){padding:20px}
 .setting-row{align-items:flex-start;flex-direction:column;gap:12px}
 .setting-row>select{width:100%}
 .task-controls{width:100%;justify-content:flex-start}
 .task-controls select{flex:1;min-width:120px}
 .task-controls input{flex:1;min-width:140px}
}
</style>
