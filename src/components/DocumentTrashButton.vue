<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,nextTick,onBeforeUnmount,onMounted,useId} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
const props=defineProps<{path:string;documentSpace?:string;resourceId?:string;etag?:string;sha256?:string;job?:string;pendingId?:string;label?:string;disabled?:boolean}>(),emit=defineEmits<{state:[{busy:boolean;uncertain:boolean}];trashed:[]}>(),store=useWorkspace(),{t}=useLocale()
const titleId=useId(),dialog=ref<HTMLDialogElement|null>(null),busy=ref(false),uncertain=ref(!!props.pendingId),error=ref(''),target=ref<{path:string;space:string;resourceId:string;etag:string;sha256:string}|null>(null),id=ref(props.pendingId??'')
const checking=ref(false),dialogOpen=ref(false);let checks=0,timer:ReturnType<typeof setTimeout>|undefined,alive=true
function stopChecks(){clearTimeout(timer);checking.value=false}
function scheduleCheck(){clearTimeout(timer);if(!alive||!uncertain.value){checking.value=false;return}if(checks>=3){checking.value=false;error.value='We could not confirm the move. Check OpenCloud Trash before trying again.';return}checking.value=true;const pin=scope();timer=setTimeout(()=>{if(alive&&scope()===pin){checks++;void submit(true)}else checking.value=false},[500,2000,5000][checks])}
const scope=()=>JSON.stringify([store.connection.value?.server,store.connection.value?.account,store.connection.value?.space])
function state(){emit('state',{busy:busy.value,uncertain:uncertain.value})}
function close(){if(!busy.value){dialog.value?.close();dialogOpen.value=false}}
async function verify(){checks=0;await submit(true)}
async function open(){
 if(props.disabled||busy.value||checking.value)return
 if(uncertain.value||props.pendingId){if(props.pendingId)id.value=props.pendingId;await verify();return}
 const pin=scope();checks=0;busy.value=true;error.value='';state()
 try{
  const pending=await store.request('document-trash-pending'),prior=pending.operations.find((row:{id:string;path:string;space:string;resourceId:string;job?:string})=>props.job?row.job===props.job:row.resourceId===props.resourceId&&row.space===(props.documentSpace??store.connection.value?.space))
  if(!alive||scope()!==pin)return
  if(prior){id.value=prior.id;uncertain.value=true;busy.value=false;state();await verify();return}
  const location=props.job?await store.request('document-location',{id:props.job}):{path:props.path,space:props.documentSpace??store.connection.value?.space,resourceId:props.resourceId,etag:props.etag}
  const detail=await store.request('metadata',{path:location.path,...(location.space?{documentSpace:location.space}:{})}),source=detail.source
  if(!alive||scope()!==pin)return
  if(detail.pending?.length)throw Error('Verify the pending metadata change before moving this document to Trash')
  if(location.resourceId&&location.resourceId!==source.resourceId||location.etag&&location.etag!==source.etag||props.sha256&&props.sha256!==source.sha256)throw Error('The document changed. Reopen it before moving it to Trash')
  target.value={...source,space:location.space??source.space??store.connection.value?.space};id.value=crypto.randomUUID()
  await nextTick();dialog.value?.showModal();dialogOpen.value=true
 }catch(e){if(alive&&scope()===pin)error.value=e instanceof Error?e.message:'Could not verify this document'}finally{if(alive&&scope()===pin){busy.value=false;state()}}
}
async function submit(verifyOnly=false){
 if(busy.value||!id.value||!verifyOnly&&(!target.value||props.disabled))return
 const pin=scope();busy.value=true;error.value='';state()
 try{
  const result=await store.request(verifyOnly?'document-trash-verify':'document-trash',verifyOnly?{id:id.value}:{id:id.value,path:target.value!.path,documentSpace:target.value!.space,resourceId:target.value!.resourceId,etag:target.value!.etag,sha256:target.value!.sha256,...(props.job?{job:props.job}:{})})
  if(!alive||scope()!==pin)return
  uncertain.value=result.state==='intent';if(result.state==='trashed'){stopChecks();dialog.value?.close();dialogOpen.value=false;emit('trashed')}
  else if(result.state==='not_recorded'){stopChecks();dialog.value?.close();dialogOpen.value=false;error.value='Nothing was moved. Open the Trash confirmation to try again.'}
  else if(!uncertain.value)error.value=result.detail??'We could not confirm the move. Check OpenCloud Trash before trying again.'
 }catch(e){if(alive&&scope()===pin){uncertain.value=(e as Error&{trashRecorded?:boolean})?.trashRecorded!==false;error.value=uncertain.value?'':e instanceof Error?e.message:'Could not move this file to Trash'}}finally{if(alive&&scope()===pin){busy.value=false;if(uncertain.value)scheduleCheck();else stopChecks();state()}}
}
onMounted(()=>{if(props.pendingId)void verify()})
onBeforeUnmount(()=>{alive=false;stopChecks()});state()
</script>
<template><div class="document-trash-control"><button v-if="uncertain||pendingId" class="button" :disabled="busy||checking||disabled" @click="open">{{ t(checking?'Checking Trash…':'Check Trash status') }}</button><button v-else :class="label?'button':'icon-button'" :disabled="busy||disabled" :aria-label="t(label||'Move to OpenCloud Trash')" :title="label?undefined:t('Move to OpenCloud Trash')" @click="open"><span v-if="label">{{ t(label) }}</span><svg v-else viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg></button><p v-if="checking&&!dialogOpen" role="status">{{ t('Checking Trash…') }}</p><p v-if="error&&!dialogOpen" role="alert" class="error">{{ t(error) }}</p><dialog ref="dialog" :aria-labelledby="titleId" class="trash-confirmation" @cancel="busy?$event.preventDefault():close()"><h2 :id="titleId">{{ t('Move to OpenCloud Trash?') }}</h2><p class="trash-filename">{{ target?.path.split('/').pop() }}</p><p>{{ t('Restore it from OpenCloud Trash while its retention period allows.') }}</p><p v-if="checking" role="status">{{ t('Checking Trash…') }}</p><p v-if="error" role="alert" class="error">{{ t(error) }}</p><footer><button v-if="uncertain" class="button" :disabled="busy||checking" @click="verify">{{ t(checking?'Checking Trash…':'Check Trash status') }}</button><button v-else class="button danger" :disabled="busy||disabled" @click="submit(false)">{{ t(busy?'Moving…':'Move to Trash') }}</button><button class="button subtle" autofocus :disabled="busy" @click="close">{{ t('Cancel') }}</button></footer></dialog></div></template>
<style scoped>
.document-trash-control{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}.document-trash-control>p{font-size:12px;max-width:420px}.trash-confirmation{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:24px;max-width:460px;width:calc(100% - 40px);box-sizing:border-box}.trash-confirmation::backdrop{background:#0008}.trash-confirmation h2{font-size:18px;margin:0 0 16px}.trash-confirmation p{font-size:13px;line-height:1.6}.trash-filename{font-weight:600;overflow-wrap:anywhere}.trash-confirmation footer{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.button.danger{color:var(--danger-ink);border-color:var(--danger-ink);background:var(--danger-bg)}
</style>
