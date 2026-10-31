<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {useInboxNavigation} from '../state/inbox-navigation'
import {withinInbox} from '../state/workspace'
import {useLocale} from '../state/locale'
import { computed, ref, watch, onBeforeUnmount, onMounted, defineAsyncComponent } from 'vue'
import { useWorkspace } from '../state/workspace'
import {pdfHash} from '../domain/source'
import {statusLabel as displayStatus} from '../domain/status'
import { actions, createApproval, reviewDigest,validateManualActions } from '../domain/review'
import {useRoute,useRouter} from '../state/navigation'
const props=defineProps<{collection?:'inbox'|'documents'}>()
const store=useWorkspace(),{t,formatDate}=useLocale()
const route=useRoute(),router=useRouter(),requestedJob=computed(()=>typeof route.value.query.job==='string'?route.value.query.job:undefined)
const collectionPath=()=>props.collection==='documents'||route.value.query.from==='filed'?'/document-workflow/documents':'/document-workflow/inbox'
const verification=ref<{checkedAt:string;resourceId:string;sha256:string;tags:string[]}|null>(null)
const { reviews, selected, policy, connection } = store
const screen=ref<HTMLElement|null>(null)
watch(selected,()=>{screen.value?.closest('.dw-content')?.scrollTo?.({top:0})})
const fieldsOpen=ref(false),fieldsLoaded=ref(false),fieldsDirty=ref(false),fieldsBusy=ref(false),fieldsUncertain=ref(false)
const ReviewFields=defineAsyncComponent(()=>import('../components/ReviewFields.vue'))
function fieldState(value:{resourceId:string;dirty:boolean;busy:boolean;uncertain?:boolean}){if(value.resourceId===active.value?.bundle.source.resourceId){fieldsDirty.value=value.dirty;fieldsBusy.value=value.busy;fieldsUncertain.value=value.uncertain===true}}
function addSuggestedTag(tag:string){if(busy.value||job.value?.decision)return;if(!manual.value)editActions();manualTags.value=[...new Set([...manualTags.value.split(',').map(t=>t.trim()).filter(Boolean),tag])].join(', ')}
const freshCloudConsent=ref(false)
async function prepareFresh(){if(!active.value||busy.value||fieldsBusy.value)return;busy.value=true;error.value='';message.value='';try{const location=job.value?.decision==='conflict'?await store.request('document-location',{id:job.value.id}):{path:active.value.bundle.source.path,space:active.value.bundle.source.space};const result=await store.prepareDocument(location.path,{newReview:true,cloudConsent:freshCloudConsent.value,...(location.space&&location.space!==connection.value?.space?{documentSpace:location.space}:{})});if(requestedJob.value)await router.push({path:collectionPath(),query:{job:result.id,from:'filed'}});message.value='Ready to review'}catch(e){error.value=e instanceof Error?e.message:'Preparation held'}finally{busy.value=false}}
const error = ref('')
const message = ref('')
const busy = ref(false)
const active = computed(() => {const review=reviews.value[selected.value];return review&&(!requestedJob.value||store.jobFor(review)?.id===requestedJob.value)?review:undefined})
const pendingFieldDraft=computed(()=>!!active.value&&!!store.fieldDrafts.value[JSON.stringify([active.value.bundle.source.resourceId,active.value.bundle.source.sha256])])
const fieldEditsPending=computed(()=>fieldsDirty.value||pendingFieldDraft.value)
const job=computed(()=>active.value ? store.jobFor(active.value) : undefined)
const queuedIndices=computed(()=>reviews.value.map((_,index)=>index).filter(index=>store.jobFor(reviews.value[index]!)?.decision!=='done'))
const manual=ref(false),manualTarget=ref(''),manualTags=ref(''),manualNeedsDestination=ref(false)
function manualActions(){if(!manual.value)return;if(manualNeedsDestination.value)throw new Error('Choose a destination before filing.');return validateManualActions({target:manualTarget.value,addTags:manualTags.value.split(',').map(t=>t.trim()).filter(Boolean)})}
const planning = computed(() => {if(job.value?.approval?.actions)return{actions:job.value.approval.actions,error:''};if(!active.value)return{actions:null,error:''};try{return{actions:actions(active.value,policy.value,manualActions()),error:''}}catch(e){return{actions:null,error:e instanceof Error?e.message:'Filing needs attention'}}})
const planned=computed(()=>planning.value.actions),filingProblem=computed(()=>planning.value.error)
function editActions(){
 if(busy.value||job.value?.decision||!active.value)return
 let current
 try{current=actions(active.value,policy.value);manualNeedsDestination.value=false}
 catch(e){
  try{const existing=actions(active.value,{...policy.value,move:'off'});if(!existing||!active.value.proposal)return;const base=active.value.bundle.rules?.root??'Filed';current=validateManualActions({target:policy.value.move==='off'?existing.target:`${base}/${active.value.proposal.folder.value}/${existing.target.split('/').pop()}`,addTags:existing.addTags});manualNeedsDestination.value=true}
  catch{error.value=e instanceof Error?e.message:'Filing needs attention';return}
 }
 if(current){manualTarget.value=current.target;manualTags.value=current.addTags.join(', ');manual.value=true}
}
watch(()=>job.value?.id,id=>{manual.value=false;manualNeedsDestination.value=false;const draft=id?store.filingDrafts.value[id]:undefined;manualTarget.value=draft?.target||'';manualTags.value=draft?.tags||'';manual.value=!!draft},{immediate:true})
watch([manualTarget,manualTags,manual,manualNeedsDestination],()=>{const id=job.value?.id;if(id&&manual.value&&!manualNeedsDestination.value&&!job.value?.decision)store.filingDrafts.value[id]={target:manualTarget.value,tags:manualTags.value}})
function resetActions(){manual.value=false;manualNeedsDestination.value=false;if(job.value)delete store.filingDrafts.value[job.value.id]}
watch(()=>job.value?.decision,decision=>{if(decision){manual.value=false;if(job.value)delete store.filingDrafts.value[job.value.id]}},{immediate:true})
const PdfPreview=defineAsyncComponent(()=>import('../components/PdfPreview.vue'))
const destinationBlocked=ref(false),checkingDestination=ref(false)
let destinationGeneration=0
watch(()=>JSON.stringify([planned.value?.target,job.value?.id,job.value?.decision,connection.value?.account]),async()=>{
 const version=++destinationGeneration;destinationBlocked.value=false;checkingDestination.value=false
 const target=planned.value?.target
 if(!connection.value||!job.value||job.value.decision||!target||target===active.value?.bundle.source.path)return
 checkingDestination.value=true
 try{const result=await store.request('files',{path:target.split('/').slice(0,-1).join('/'),...(planned.value?.targetSpace?{documentSpace:planned.value.targetSpace}:{})});if(version===destinationGeneration)destinationBlocked.value=result.files.some((f:{path:string})=>f.path===target)}catch{/* Missing folders and unavailable listings are rechecked by the filing worker. */}
 finally{if(version===destinationGeneration)checkingDestination.value=false}
},{immediate:true})
onBeforeUnmount(()=>{destinationGeneration++})
const preview=ref<Blob|null>(null),previewLoading=ref(false),previewError=ref(''),previewChanged=ref(false)
const resolvedPath=ref<string|null>(null),resolvedSpace=ref<string|null>(null)
const documentSpace=computed(()=>resolvedSpace.value??(['done','move_done','tags_intent','transfer_ready','transfer_ready'].includes(job.value?.decision||'')?(planned.value?.targetSpace??active.value?.bundle.source.space):active.value?.bundle.source.space))
const documentPath=computed(()=>resolvedPath.value??(['done','move_done','tags_intent','transfer_ready'].includes(job.value?.decision||'')?planned.value?.target:active.value?.bundle.source.path))
let previewGeneration=0
function statusLabel(review:typeof reviews.value[number]){const state=store.jobFor(review)?.decision;return displayStatus(state||review.state)}
const inInbox=computed(()=>collectionPath().endsWith('/inbox'))
const navigation=useInboxNavigation(computed(()=>active.value?.bundle.source.resourceId),computed(()=>busy.value||fieldsBusy.value))
watch(()=>active.value?.bundle.source.resourceId,()=>{fieldsOpen.value=false;fieldsLoaded.value=false;fieldsDirty.value=false;fieldsBusy.value=false;fieldsUncertain.value=false;verification.value=null;message.value='';error.value=''})
async function refreshReviews(){
 if(!connection.value||busy.value)return
 busy.value=true;const resource=active.value?.bundle.source.resourceId
 try{await store.refresh();if(requestedJob.value){const opened=await store.openJob(requestedJob.value);const parent=opened.source.path.split('/').slice(0,-1).join('/');if(inInbox.value&&withinInbox(parent,store.inbox.value)&&store.folder.value!==parent){store.folder.value=parent;await store.refresh();await store.openJob(requestedJob.value)}}else{const index=reviews.value.findIndex(r=>r.bundle.source.resourceId===resource&&store.jobFor(r)?.decision!=='done');selected.value=index>=0?index:queuedIndices.value[0]??-1}}
 catch(e){error.value=e instanceof Error?e.message:'Review refresh failed'}
 finally{busy.value=false}
}
onMounted(async():Promise<void>=>{try{if(requestedJob.value&&!connection.value)await store.connect();await refreshReviews()}catch(e){error.value=e instanceof Error?e.message:'Could not open the saved document'}})
watch(requestedJob,()=>void refreshReviews())
watch(()=>connection.value?.account,()=>{if(requestedJob.value&&!busy.value)void refreshReviews()})
watch(selected,()=>{verification.value=null})
onBeforeUnmount(()=>{previewGeneration++})
async function loadPreview(){
 const version=++previewGeneration;preview.value=null;previewError.value='';previewChanged.value=false;resolvedPath.value=null;resolvedSpace.value=null
 if(!active.value||!connection.value){previewLoading.value=false;return}
 previewLoading.value=true
 try{const expected=active.value.bundle.source.sha256;const location=job.value?.decision==='conflict'?await store.request('document-location',{id:job.value.id}):null;const path=location?.path??documentPath.value;if(location)resolvedSpace.value=location.space;if(version!==previewGeneration)return;resolvedPath.value=path;const blob=await store.request('preview',{path,...(documentSpace.value&&documentSpace.value!==connection.value?.space?{documentSpace:documentSpace.value}:{})});if(version!==previewGeneration)return;const hash=await pdfHash(blob);if(version!==previewGeneration)return;if(hash!==expected){previewChanged.value=true;throw new Error('This PDF changed after the suggestion was prepared. Prepare a fresh suggestion to review its current contents.')}preview.value=blob}
 catch(e){if(version===previewGeneration)previewError.value=e instanceof Error?e.message:'Preview failed'}
 finally{if(version===previewGeneration)previewLoading.value=false}
}
watch(()=>JSON.stringify([active.value?.bundle.source,job.value?.decision,connection.value?.account]),()=>{void loadPreview()},{immediate:true})
async function decide(operation:'approve'|'reject'|'apply'|'reconcile'|'file'){
 if(!active.value||!job.value||busy.value||fieldsBusy.value||(['approve','apply','file'].includes(operation)&&fieldsUncertain.value)||(['approve','file'].includes(operation)&&(fieldEditsPending.value||previewChanged.value)))return
 busy.value=true;error.value='';message.value=''
 const resourceId=active.value.bundle.source.resourceId,before=navigation.snapshot();let advance=false
 try{const id=job.value.id,payload=['approve','file'].includes(operation)?{id,policy:JSON.parse(JSON.stringify(policy.value)),reviewDigest:await reviewDigest(active.value,policy.value,manualActions()),...(manual.value?{manualActions:manualActions()}:{})}:{id};let result;if(operation==='file'){await store.request('approve',payload);result=await store.request('apply',{id})}else result=await store.request(operation,payload);await store.refresh();if(requestedJob.value||!store.jobs.value.some(value=>value.id===id))await store.openJob(id);else{const index=reviews.value.findIndex(r=>r.bundle.source.resourceId===resourceId);if(index>=0)selected.value=index}if(operation==='reconcile'&&result.state==='done'&&result.verification){if((result.verification.originalResourceId??result.verification.resourceId)!==resourceId)throw new Error('Verification identity did not match this document');verification.value={...result.verification,tags:result.tags}}advance=inInbox.value&&!result.uncertain&&(['file','apply'].includes(operation)&&result.state==='done'||operation==='reject'&&result.state==='rejected');message.value=result.uncertain?'Outcome needs verification':operation==='reject'?'Rejected':operation==='reconcile'&&result.state==='done'?'Verified':result.state==='done'?'':displayStatus(result.state)}
 catch(e){error.value=e instanceof Error?e.message:'Operation held';if(error.value.includes('metadata save needs verification')){fieldsOpen.value=true;fieldsLoaded.value=true}try{await store.refresh();if(requestedJob.value)await store.openJob(requestedJob.value)}catch{}}
 finally{busy.value=false}
 if(advance)await navigation.advance(before,resourceId)
}
async function takeOver(){
 if(!job.value||busy.value)return;busy.value=true;error.value=''
 try{const id=job.value.id;await store.request('automation-takeover',{id,reviewDigest:job.value.approval?.reviewDigest});await store.openJob(id);message.value=''}catch(e){error.value=e instanceof Error?e.message:'Takeover held'}finally{busy.value=false}
}
async function exportApproval() {
  if (!active.value || busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const approval = await createApproval(active.value, policy.value,manualActions())
    const url = URL.createObjectURL(new Blob([JSON.stringify(approval, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'document-review-approval.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    message.value = 'Approval record downloaded. OpenCloud has not been changed. A connected worker must recheck identity, bytes, ETag and permissions before applying it.'
  } catch (e) { error.value = e instanceof Error ? e.message : 'Could not export approval' }
  finally { busy.value = false }
}
</script>

<template>
 <main ref="screen" class="workflow screen">
  <header class="screen-heading editor-heading"><nav v-if="inInbox" class="inbox-navigation" :aria-label="t('Document navigation')"><RouterLink class="button subtle" to="/document-workflow/inbox" :aria-label="t('Back to inbox')">{{ t('Inbox') }}</RouterLink><button class="icon-button" :disabled="!navigation.canPrevious.value" :aria-label="t('Previous document')" :title="t('Previous document')" @click="navigation.move(-1)">‹</button><span v-if="navigation.position.value">{{ navigation.position.value }} / {{ navigation.total.value }}</span><button class="icon-button" :disabled="!navigation.canNext.value" :aria-label="t('Next document')" :title="t('Next document')" @click="navigation.move(1)">›</button></nav><RouterLink v-else class="icon-button" :to="collectionPath()" :aria-label="t(collectionPath().endsWith('/documents')?'Back to documents':'Back to inbox')">←</RouterLink><h1 :title="(job?.decision==='done'?planned?.target:active?.bundle.source.path)?.split('/').pop()">{{ (job?.decision==='done'?planned?.target:active?.bundle.source.path)?.split('/').pop()||t('Document') }}</h1><span v-if="job?.decision==='done'" class="pill">{{ t('Filed') }}</span></header>
  <p v-if="error||navigation.error.value" role="alert" class="error">{{ t(error||navigation.error.value) }}</p><p v-if="message" role="status" class="message">{{ t(message) }}</p>
  <template v-if="active">
   <div class="review-layout">
    <section class="source-panel panel" :aria-label="t('Original document')"><p v-if="previewLoading" role="status">{{ t('Loading…') }}</p><PdfPreview v-if="preview" :data="preview" :filename="documentPath?.split('/').pop()" /><div v-else-if="!previewLoading" class="preview-placeholder"><p>{{ t(previewError||'Preview unavailable') }}</p><button class="button" @click="loadPreview">{{ t('Retry') }}</button></div></section>
    <section class="review-plan panel" :aria-label="t('Document details')">
     <template v-if="active.proposal">
      <section class="review-step"><dl class="facts"><template v-for="key in (['issuer','date','kind'] as const)" :key="key"><dt>{{ t(key==='issuer'?'Sender':key==='date'?'Date':'Type') }}</dt><dd>{{ active.proposal[key].value }}</dd></template></dl><details class="evidence"><summary>{{ t('Evidence') }}</summary><div v-for="key in (['issuer','date','kind','folder'] as const)" :key="key" class="claim"><strong>{{ t(key==='issuer'?'Sender':key==='date'?'Date':key==='kind'?'Type':'Category') }}</strong><blockquote v-for="(item,index) in active.proposal[key].evidence" :key="index">{{ item.quote }} <small>{{ t('Page {number}',{number:item.page}) }}</small></blockquote></div></details></section>
      <section class="review-step"><div class="step-heading"><h2>{{ t('Filing') }}</h2><button v-if="job&&!job.decision" class="icon-button" :disabled="busy||fieldsBusy" :aria-label="t(manual?'Use suggestions':'Edit filing')" :title="t(manual?'Use suggestions':'Edit filing')" @click="manual?resetActions():editActions()">{{ manual?'↶':'✎' }}</button></div><template v-if="manual"><label for="manual-target">{{ t('Destination') }}</label><input id="manual-target" v-model.lazy="manualTarget" :disabled="busy||fieldsBusy" @change="manualNeedsDestination=false" /><label for="manual-tags">{{ t('Tags to add') }}</label><input id="manual-tags" v-model="manualTags" :disabled="busy||fieldsBusy" /></template><template v-else-if="planned"><p class="target"><span v-if="planned.targetSpace">{{ store.spaces.value.find(space=>space.id===planned.targetSpace)?.name||planned.targetSpace }} / </span>{{ planned.target }}</p><dl v-if="planned.addTags.length" class="filing"><dt>{{ t('Tags to add') }}</dt><dd><span v-for="tag in planned.addTags" :key="tag" class="tag">{{ tag }}</span></dd></dl></template><p v-if="filingProblem" role="alert" class="error">{{ t(filingProblem) }}</p><p v-if="destinationBlocked" class="error">{{ t('Destination already exists') }}</p><p v-if="active.ruleAmbiguous" class="error">{{ t('Several filing rules match') }}</p><RouterLink v-if="job?.decision==='done'&&documentPath" class="button subtle" :to="{path:'/document-workflow/details',query:{path:documentPath,return:'filed',job:job.id,space:documentSpace}}">{{ t('Edit details') }}</RouterLink><details v-if="connection&&job?.decision!=='done'" :open="fieldsOpen" class="review-fields" @toggle="fieldsOpen=($event.target as HTMLDetailsElement).open;if(fieldsOpen)fieldsLoaded=true"><summary>{{ t('Fields') }}</summary><ReviewFields v-if="fieldsLoaded" :key="active.bundle.source.resourceId+active.bundle.source.sha256" :path="documentPath||active.bundle.source.path" :document-space="documentSpace" :resource-id="active.bundle.source.resourceId" :sha256="active.bundle.source.sha256" :editable-tags="!job?.decision" :locked="busy||['approved','folders_pending','move_intent','move_done','tags_intent','copy_intent','transfer_ready'].includes(job?.decision||'')" @state="fieldState" @tag="addSuggestedTag" /></details></section>
      <section class="decision-actions">
       <p v-if="job?.automation?.state==='held'" class="error">{{ t(job.automation.detail||'Needs attention') }}</p>
       <template v-if="job"><template v-if="job.automation?.state==='done'&&!job.decision"><span class="pill">{{ t('Processed') }}</span></template><template v-else-if="!job.decision"><p v-if="previewChanged" class="error">{{ t('Document changed') }}</p><p v-if="fieldEditsPending" class="error">{{ t('Save field changes before filing') }}</p><div class="action-buttons"><button class="button primary" :disabled="busy||fieldsBusy||fieldsUncertain||fieldEditsPending||previewChanged||!planned||checkingDestination||destinationBlocked||(!planned.targetSpace&&planned.target===active.bundle.source.path&&!planned.addTags.length)" @click="decide('file')">{{ t(busy?'Filing…':'File') }}</button><button class="button subtle" :disabled="busy||fieldsBusy" @click="decide('reject')">{{ t('Reject') }}</button></div></template><template v-else-if="['approved','folders_pending','move_done','transfer_ready'].includes(job.decision)"><button v-if="job.approval?.automaticAuthorization" class="button" :disabled="busy||fieldsBusy" @click="takeOver">{{ t('Take over') }}</button><button v-else class="button primary" :disabled="busy||fieldsBusy||fieldsUncertain" @click="decide('apply')">{{ t(busy?'Filing…':'Continue filing') }}</button></template><template v-else-if="['move_intent','tags_intent','copy_intent'].includes(job.decision)"><button class="button" :disabled="busy||fieldsBusy" @click="decide('reconcile')">{{ t('Verify outcome') }}</button></template><template v-else-if="job.decision==='done'"><button class="button" :disabled="busy||fieldsBusy||fieldsUncertain" @click="decide('reconcile')">{{ t('Verify file') }}</button><details v-if="verification"><summary>{{ t('Verification') }}</summary><p>{{ formatDate(verification.checkedAt) }}</p><dl class="filing"><dt>{{ t('Resource') }}</dt><dd>{{ verification.resourceId }}</dd><dt>SHA256</dt><dd>{{ verification.sha256 }}</dd></dl></details></template><template v-else><label v-if="Object.values(store.ai.value.tasks).includes('cloud')" class="check-label"><input v-model="freshCloudConsent" type="checkbox" />{{ t('Allow cloud processing') }}</label><button class="button" :disabled="busy||fieldsBusy" @click="prepareFresh">{{ t('Prepare again') }}</button></template></template><button v-else class="button" :disabled="busy||!planned" @click="exportApproval">{{ t('Export record') }}</button>
      </section>
      <details v-if="active.excluded.length" class="excluded"><summary>{{ t('Excluded tags') }}</summary><p v-for="(tag,index) in active.excluded" :key="index">{{ tag.value }}</p></details>
     </template><section v-else><p>{{ t('Text recognition required') }}</p><RouterLink class="text-link" to="/document-workflow/settings/automation">{{ t('Processing settings') }}</RouterLink></section>
     <details class="technical"><summary>{{ t('File information') }}</summary><dl class="filing"><dt>{{ t('Original path') }}</dt><dd>{{ active.bundle.source.path }}</dd><dt>{{ t('Resource') }}</dt><dd>{{ active.bundle.source.resourceId }}</dd><dt>SHA256</dt><dd>{{ active.bundle.source.sha256 }}</dd></dl><article v-for="(page,index) in active.bundle.pages" :key="index"><h3>{{ t('Page {number}',{number:index+1}) }}</h3><pre>{{ page }}</pre></article><p v-if="job?.approval?.automaticAuthorization">{{ t('Automatic') }} · {{ formatDate(job.approval.automaticAuthorization.authorizedAt) }}</p></details>
    </section>
   </div>
  </template><p v-else-if="busy" role="status">{{ t('Loading…') }}</p>
 </main>
</template>
<style scoped>
.review-selector{display:flex;align-items:center;gap:12px;padding:12px 16px;margin-bottom:20px;flex-wrap:wrap}.review-selector label{font-size:12px;color:var(--muted)}.review-selector select{flex:1;min-width:160px}.review-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,1fr);gap:24px;align-items:start}.source-panel{padding:18px;position:sticky;top:16px}.source-heading,.step-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.source-heading h2{margin:0}.source-name{overflow-wrap:anywhere;font-size:12px}.preview-placeholder{padding:48px 12px;text-align:center}.review-plan{min-width:0;padding:0 24px}.review-step{padding:22px 0;border-bottom:1px solid var(--line)}.review-step h2{display:flex;align-items:center;gap:9px;font-size:15px}.step-number{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--subtle);color:var(--accent-text);font-size:12px}.review-step>p{font-size:12px}.facts,.filing{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;margin:20px 0 12px;font-size:13px}dt{color:var(--muted);font-size:12px}dd{margin:0;overflow-wrap:anywhere}.facts dd{font-weight:600}.target{font-weight:600;color:var(--accent-text)}.review-step label{display:block;font-size:12px;font-weight:600;margin:14px 0 6px}.review-step input{width:100%}.text-link{display:inline-block;color:var(--accent-text);font-size:12px;margin-top:14px}.fine-print{font-size:11px!important}.action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.decision-actions>.button{margin-top:16px}.technical,.excluded{padding:14px 0}summary{font-size:12px;color:var(--muted);cursor:pointer;padding:6px 0}.evidence{margin-top:12px}.claim{margin:12px 0;font-size:12px}.claim strong{text-transform:capitalize}blockquote{margin:6px 0 12px;border-left:2px solid var(--line);padding-left:12px;white-space:pre-wrap;overflow-wrap:anywhere}blockquote small{display:block;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:var(--subtle);padding:12px}h3{font-size:13px;margin:20px 0 8px}@media(max-width:1100px){.review-layout{grid-template-columns:minmax(0,1fr) minmax(300px,1fr);gap:16px}.review-plan{padding:0 16px}.review-selector .button{padding:8px}}@media(max-width:850px){.review-layout{grid-template-columns:1fr}.source-panel{position:static}.review-selector select{flex-basis:65%}.facts,.filing{grid-template-columns:85px minmax(0,1fr)}}
.editor-heading{justify-content:start;gap:14px}.editor-heading h1{font-size:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.editor-heading .pill{margin-left:auto}.source-panel{padding:16px}.review-plan>.review-step:first-child{padding-top:0}.review-plan .facts{margin-top:0}.decision-actions{padding:18px 0}.step-heading .icon-button{width:30px;height:30px;font-size:17px}@media(max-width:700px){.editor-heading h1{font-size:17px}}
</style>
