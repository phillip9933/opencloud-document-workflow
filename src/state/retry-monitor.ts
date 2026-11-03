// SPDX-License-Identifier: AGPL-3.0-only
import {onBeforeUnmount,watch} from 'vue'
import type {Ref} from 'vue'
import type {ProcessingIssueInfo} from '../domain/processing'
interface RetryStatus{state:string;job:string|null;source:{resourceId:string;etag:string};processingIssue:ProcessingIssueInfo|null}
export function useRetryMonitor(options:{key:Ref<string>;blocked:()=>boolean;request:(id:string)=>Promise<RetryStatus>;issue:(value:ProcessingIssueInfo|null)=>void;ready:(id:string)=>Promise<void>}){
 let timer:ReturnType<typeof setTimeout>|undefined,generation=0,alive=true
 function stop(){generation++;clearTimeout(timer)}
 function start(id:string,source:{resourceId:string;etag:string}){
  stop();const version=generation,key=options.key.value
  const schedule=()=>{if(alive&&version===generation)timer=setTimeout(()=>void poll(),2500)}
  const poll=async()=>{
   if(!alive||version!==generation||key!==options.key.value)return
   if(options.blocked()){schedule();return}
   try{const result=await options.request(id);if(!alive||version!==generation||key!==options.key.value)return
    if(result.source.resourceId!==source.resourceId||result.source.etag!==source.etag){stop();return}
    options.issue(result.processingIssue)
    if(['queued','settling','running'].includes(result.state)){schedule();return}
    if(result.state==='prepared'&&result.job&&!result.processingIssue)await options.ready(result.job)
   }catch{schedule()}
  }
  schedule()
 }
 watch(options.key,stop)
 onBeforeUnmount(()=>{alive=false;stop()})
 return{start,stop}
}
