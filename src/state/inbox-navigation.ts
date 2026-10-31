// SPDX-License-Identifier: AGPL-3.0-only
import {computed,ref} from 'vue'
import type {Ref} from 'vue'
import {useWorkspace} from './workspace'
import type {DraftFile} from './workspace'
import {useRouter} from './navigation'
export function useInboxNavigation(resource:Ref<string|undefined>,blocked:Ref<boolean>){
 const store=useWorkspace(),router=useRouter(),navigating=ref(false),error=ref('')
 const entries=computed(()=>{
  const context=store.inboxNavigation.value,source=context?.folder===store.folder.value?context.entries:store.files.value,live=new Map(store.files.value.filter(f=>!f.folder&&f.intakeState!=='processed'&&f.reviewState!=='done').map(f=>[f.resourceId,f]))
  return source.filter(f=>!f.folder).flatMap(f=>live.has(f.resourceId)?[live.get(f.resourceId)!]:f.resourceId===resource.value?[f]:[])
 }),index=computed(()=>entries.value.findIndex(f=>f.resourceId===resource.value)),position=computed(()=>index.value<0?0:index.value+1),total=computed(()=>entries.value.length)
 const canPrevious=computed(()=>index.value>0&&!blocked.value&&!navigating.value),canNext=computed(()=>index.value>=0&&index.value<entries.value.length-1&&!blocked.value&&!navigating.value)
 const scope=()=>store.connection.value&&JSON.stringify([store.connection.value.server,store.connection.value.account,store.connection.value.space])
 async function open(file:DraftFile){const pin=scope(),location=await store.inboxLocation(file);if(pin!==scope())throw new Error('The workspace changed. Reopen this document.');await router.push(location)}
 async function move(delta:number){if(blocked.value||navigating.value)return;const file=entries.value[index.value+delta];if(index.value<0||!file)return;navigating.value=true;error.value='';try{await open(file)}catch(e){error.value=e instanceof Error?e.message:'Could not open document'}finally{navigating.value=false}}
 function snapshot(){return entries.value.map(f=>({...f}))}
 async function advance(before:DraftFile[],current:string){
  if(navigating.value)return;navigating.value=true;error.value=''
  try{const live=new Map(store.files.value.filter(f=>!f.folder&&f.intakeState!=='processed'&&f.reviewState!=='done').map(f=>[f.resourceId,f])),start=before.findIndex(f=>f.resourceId===current),next=start<0?undefined:before.slice(start+1).find(f=>live.has(f.resourceId));if(next)await open(live.get(next.resourceId)!);else await router.push('/document-workflow/inbox')}
  catch(e){error.value=e instanceof Error?e.message:'Could not open document'}finally{navigating.value=false}
 }
 return{entries,index,position,total,canPrevious,canNext,navigating,error,move,snapshot,advance}
}
