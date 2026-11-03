// SPDX-License-Identifier: AGPL-3.0-only
import {inject,ref,computed} from 'vue'
import type {RouteLocationRaw} from 'vue-router'
import type {InjectionKey} from 'vue'
import {defaultPolicy,validateBundle,validatePolicy} from '../domain/review'
import type {Review, Policy} from '../domain/review'
import {defaultAIConfig,preparationProblem,validateAIConfig} from '../domain/ai'
import type {ProcessingProgress,ProcessingIssueInfo} from '../domain/processing'
export * from '../domain/ai'
export interface WorkspaceHost {spaceName:(id:string)=>string;folderLocation:(id:string,path:string)=>RouteLocationRaw|undefined}
export const workspaceHostKey:InjectionKey<WorkspaceHost>=Symbol('OpenCloud workspace navigation')
export const sessionTokenKey: InjectionKey<()=>string> = Symbol('OpenCloud session token')
export interface DraftJob {potentialDuplicates?:{id:string;path:string}[];duplicateCheck?:'complete'|'unavailable';preparationReview?:import('../domain/preparation').PreparationReview|null;conversion?:{conversionId:string;archivePath:string;originalResourceId:string;originalSha256:string;space:string}|null;processingIssue?:ProcessingIssueInfo|null;workflowSpace?:string;source:Review['bundle']['source'];id:string;state:string;attempts?:number;decision:string|null;bundle:Review['bundle']|null;updated:string;error:string|null;automation?:{state:string;detail:string|null}|null;approval?:{automaticAuthorization?:{kind:string;authorizedAt:string};actions:{target:string;targetSpace?:string;addTags:string[]};policy:Policy;reviewDigest:string}|null}
export interface IntakeRecord {resource:string;path:string;job:string|null;state:string;decision?:string|null}
export interface IntakeSummary {total:number;waiting:number;running:number;attention:number;ready:number;completed:number;cancelled:number;duplicates:number;superseded:number;retryable:number;cancellable:number}
export interface IntakeHealth {manualCheck?:'checking'|'settling'|null;manualOnly?:boolean;state:'paused'|'pausing'|'waiting_for_session'|'running'|'resuming'|'held'|'ready'|'starting';lastAttempt:number|null;lastSuccess:number|null;reason:'session'|'source'|null;message:string|null;nextScanAt:number|null}
export interface DraftFile {path:string;resourceId:string;etag:string;tags:string[];folder:boolean;size:number;reviewJob?:string|null;reviewState?:string|null;intakeState?:string|null;progress?:ProcessingProgress;fields?:Record<string,string|number>;duplicate?:{id:string;job:string|null;uncertain:boolean}}
export interface FiledDocument {space?:string;processed?:boolean;id:string;path:string;originalPath:string;resourceId:string;sha256:string;sender:string;date:string;kind:string;tags:string[];fields:Record<string,string|number>;metadataVersion:number;updated:string}
// UI browsing stays inside the chosen inbox; the adapter enforces the configured Space.
export function withinInbox(path:string,root:string){return path===root||path.startsWith(root+'/')}
export function createWorkspace(token:()=>string=()=> '',host?:WorkspaceHost) {
 const activeSpace=ref(''),spaces=ref<{id:string;name:string;type:string}[]>([]),switchingSpace=ref(false),spaceError=ref('')
 try{activeSpace.value=globalThis.localStorage?.getItem('document-workflow:active-space')??''}catch{}
 const inboxSearch=ref(''),inboxNavigation=ref<{folder:string;entries:DraftFile[]}|null>(null)
 const filingDrafts=ref<Record<string,{target:string;tags:string}>>({})
 const fieldDrafts=ref<Record<string,{version:number;values:Record<string,string|number>}>>({}),storedPreferences=ref<{policy:Policy;ai:ReturnType<typeof defaultAIConfig>}|null>(null)
 const intakeQueue=ref<IntakeRecord[]>([])
 const intakeSummary=ref<IntakeSummary|null>(null),inboxSummary=ref<IntakeSummary|null>(null),intakePaused=ref(false)
 const intakeConfigured=ref(false)
 const intakeHealth=ref<IntakeHealth|undefined>(),intakeSessionAttached=ref(false)
 const reviewsHaveMore=ref(false),reviewsCursor=ref<string|null>(null)
 let workspaceGeneration=0,connectGeneration=0,filesGeneration=0,pinnedJobId:string|null=null
 const capabilities=ref({cloudEnabled:false,atomicPreferencePause:false})
 const reviews=ref<Review[]>([]),selected=ref(0),policy=ref(defaultPolicy()),ai=ref(defaultAIConfig())
 const cloudProcessing=computed(()=>policy.value.aiInput!=='off'&&policy.value.aiOutput!=='off'&&Object.values(ai.value.tasks).includes('cloud'))
 const connection=ref<{mode:string;server:string;account:string;space:string;name:string;username?:string;spaceName?:string}|null>(null),jobs=ref<DraftJob[]>([]),files=ref<DraftFile[]>([]),jobIds=ref<Record<string,string>>({}),folder=ref('Inbox'),inbox=ref('Inbox'),intakeEnabled=ref(false),connectionError=ref('')
 async function request(operation:string,body:unknown={}) {
  const bearer=token(),generation=workspaceGeneration,pin=connection.value?JSON.stringify([connection.value.server,connection.value.account,connection.value.space]):null,space=activeSpace.value
  let verifiedBearer=bearer
  const checkSession=async()=>{
   if(generation!==workspaceGeneration)throw new Error('The workspace changed. Reload its current state before continuing.')
   if(verifiedBearer===token())return
   const renewed=token()
   if(!pin||!renewed)throw new Error('The workspace changed. Reload its current state before continuing.')
   // Token renewal is normal during OCR. Re-authenticate the current session
   // before exposing a response produced under the earlier credential.
   const check=await fetch('/_workflow/api/status',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${renewed}`,...(space?{'X-Workflow-Space':space}:{})},body:JSON.stringify({activeOnly:true}),signal:AbortSignal.timeout(30_000)})
   const status=check.ok?await check.json():null,actor=status?.actor
   if(generation!==workspaceGeneration||renewed!==token()||!actor||JSON.stringify([actor.server,actor.account,actor.space])!==pin)throw new Error('The workspace changed. Reload its current state before continuing.')
   verifiedBearer=renewed
  }
  const response=await fetch(`/_workflow/api/${operation}`,{method:'POST',headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{}) ,...(activeSpace.value?{'X-Workflow-Space':activeSpace.value}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(480_000)})
  await checkSession()
  if(operation==='preview'&&response.ok){const blob=await response.blob();await checkSession();return blob}
  let result
  try{result=await response.json()}catch{throw new Error('Companion is not connected. Start the draft server or configure its same-origin route.')}
  await checkSession()
  if(!response.ok)throw Object.assign(new Error(result.error||'Companion request failed'),operation==='document-trash'&&result.trashRecorded===false?{trashRecorded:false}:{})
  return result
 }
 function reviewKey(review:Review){return JSON.stringify(review.bundle)}
 function installJobs(rows:DraftJob[]){
  const previous=reviews.value[selected.value]?.bundle.source.resourceId
  jobs.value=rows;jobIds.value={}
  const seen=new Set<string>();reviews.value=[]
  for(const j of rows.filter(j=>j.bundle)){const review=validateBundle(j.bundle),key=reviewKey(review);if(seen.has(key))continue;seen.add(key);jobIds.value[key]=j.id;reviews.value.push(review)}
  const retained=reviews.value.findIndex(r=>r.bundle.source.resourceId===previous),waiting=reviews.value.findIndex(r=>{const j=rows.find(j=>j.id===jobIds.value[reviewKey(r)]);return r.proposal&&!j?.decision});selected.value=retained>=0?retained:waiting>=0?waiting:0
 }
 async function loadSpaces(){try{const result=await request('spaces');spaces.value=Array.isArray(result.spaces)?result.spaces:[];spaceError.value='';return result.spaces}catch(e){spaceError.value=e instanceof Error?e.message:'Could not list Spaces';throw e}}
 function clearWorkspace(){pinnedJobId=null;workspaceGeneration++;connectGeneration++;filesGeneration++;connection.value=null;jobs.value=[];reviews.value=[];jobIds.value={};files.value=[];inboxSearch.value='';inboxNavigation.value=null;filingDrafts.value={};fieldDrafts.value={};storedPreferences.value=null;intakeQueue.value=[];intakeSummary.value=null;inboxSummary.value=null;intakePaused.value=false;intakeHealth.value=undefined;intakeSessionAttached.value=false;reviewsHaveMore.value=false;reviewsCursor.value=null;folder.value='Inbox';inbox.value='Inbox';intakeEnabled.value=false;intakeConfigured.value=false;policy.value=defaultPolicy();ai.value=defaultAIConfig()}
 async function switchSpace(id:string){
  if(switchingSpace.value)return
  if(!spaces.value.some(space=>space.id===id))throw new Error('Choose one of your available Spaces')
  switchingSpace.value=true;spaceError.value='';const previous=activeSpace.value
  clearWorkspace();activeSpace.value=id
  try{await connect();try{globalThis.localStorage?.setItem('document-workflow:active-space',id)}catch{};try{await refresh()}catch{/* A new Space may not have an inbox yet; show setup. */}}
  catch(e){clearWorkspace();activeSpace.value=previous;spaceError.value=e instanceof Error?e.message:'Space access failed';try{await connect()}catch{};throw e}
  finally{switchingSpace.value=false}
 }
 async function connect(){
  const generation=++connectGeneration
  try{
   const status=await request('status',{activeOnly:true})
   if(generation!==connectGeneration)return status
   // A fresh browser has no cached Space. Pin the server-verified selection
   // before subsequent requests so another device cannot change this session.
   if(!activeSpace.value&&typeof status.actor?.space==='string')activeSpace.value=status.actor.space
   const intake=await request('intake')
   if(generation!==connectGeneration)return status
   capabilities.value={cloudEnabled:status.cloudEnabled===true,atomicPreferencePause:status.atomicPreferencePause===true}
   // The active-only status page may omit an opened hold or an older saved review.
   // Keep that document mounted during list refreshes within the same workspace.
   const sameScope=connection.value&&JSON.stringify([connection.value.server,connection.value.account,connection.value.space])===JSON.stringify([status.actor.server,status.actor.account,status.actor.space])
   const pinned=sameScope?jobs.value.find(job=>job.id===pinnedJobId):undefined
   const rows=status.jobs.map((job:DraftJob)=>pinned&&job.id===pinned.id&&job.state===pinned.state&&job.decision===pinned.decision&&job.updated===pinned.updated&&job.source.etag===pinned.source.etag&&!Object.hasOwn(job,'processingIssue')?{...job,potentialDuplicates:pinned.potentialDuplicates,duplicateCheck:pinned.duplicateCheck,preparationReview:pinned.preparationReview,processingIssue:pinned.processingIssue}:job)
   installJobs(pinned&&!rows.some((job:DraftJob)=>job.id===pinned.id)?[pinned,...rows]:rows)
   intakeQueue.value=intake.queue||[];intakeSummary.value=intake.summary??null;intakePaused.value=intake.paused===true;intakeConfigured.value=intake.configured??!!intake.configuration
   intakeHealth.value=intake.health;intakeSessionAttached.value=intake.sessionAttached===true
   reviewsHaveMore.value=status.jobsHasMore===true;reviewsCursor.value=status.jobsCursor??null
   const root=intake.configuration?.folder
   if(root){inbox.value=root;intakeEnabled.value=intake.configuration.enabled===true;if(!withinInbox(folder.value,root))folder.value=root}
   connection.value=status.actor;storedPreferences.value=status.preferences?JSON.parse(JSON.stringify(status.preferences)):null
   if(status.preferences){policy.value={...defaultPolicy(),...status.preferences.policy};ai.value=status.preferences.ai}else if(status.ollama){ai.value.local.endpoint=status.ollama}
   connectionError.value='';return status
  }catch(e){if(generation===connectGeneration)connectionError.value=e instanceof Error?e.message:'Connection failed';throw e}
 }
 async function refresh(){
  if(!connection.value)return
  await connect();if(!intakeConfigured.value){files.value=[];inboxSummary.value=null;return}if(!withinInbox(folder.value,inbox.value))folder.value=inbox.value
  folder.value=inbox.value
  const path=inbox.value,generation=++filesGeneration,value=await request('files',{path,flattenInbox:true})
  if(generation===filesGeneration&&path===inbox.value){files.value=value.files.filter((file:DraftFile)=>!file.folder&&withinInbox(file.path,inbox.value));inboxSummary.value=value.summary??null}
 }
 async function loadMoreReviews(){if(!reviewsCursor.value)return;const result=await request('jobs',{activeOnly:true,cursor:reviewsCursor.value});installJobs([...jobs.value,...result.jobs.filter((j:DraftJob)=>!jobs.value.some(old=>old.id===j.id))]);reviewsCursor.value=result.nextCursor;reviewsHaveMore.value=!!result.nextCursor}
 async function savePreferences(configuration={policy:policy.value,ai:ai.value}){
  const snapshot={policy:validatePolicy(JSON.parse(JSON.stringify(configuration.policy))),ai:validateAIConfig(JSON.parse(JSON.stringify(configuration.ai)))}
  let paused=false
  if(connection.value){
   if(!capabilities.value.atomicPreferencePause&&intakeEnabled.value&&preparationProblem(snapshot,capabilities.value.cloudEnabled)){const current=await request('intake');await request('intake-settings',{configuration:{...current.configuration,enabled:false}});intakeEnabled.value=false;paused=true}
   try{const result=await request('preferences',{configuration:snapshot});if(result.paused){intakeEnabled.value=false;paused=true}}catch(e){if(paused)throw new Error('Automatic preparation is paused. Could not confirm the settings save; reload saved settings before retrying.');throw e}
  }
  policy.value=snapshot.policy;ai.value=snapshot.ai;storedPreferences.value=JSON.parse(JSON.stringify(snapshot))
  return{paused}
 }

 async function prepareDocument(path:string,options:{retry?:boolean;newReview?:boolean;cloudConsent?:boolean;documentSpace?:string;resourceId?:string;etag?:string}={}){
  const issue=preparationProblem(storedPreferences.value,capabilities.value.cloudEnabled);if(issue)throw new Error(issue)
  const result=await request('prepare',{path,...options});await refresh();const index=reviews.value.findIndex(review=>jobFor(review)?.id===result.id);if(index>=0)selected.value=index;else await openJob(result.id);return result
 }
 function jobFor(review:Review){const id=jobIds.value[reviewKey(review)];return jobs.value.find(j=>j.id===id)}
 async function openJob(id:string,expected?:DraftFile){
  const scope=connection.value&&JSON.stringify([connection.value.server,connection.value.account,connection.value.space])
  if(!scope)throw new Error('Connect the document workspace first')
  const result=await request('job',{id}),job:DraftJob=result.job
  if(!connection.value||scope!==JSON.stringify([connection.value.server,connection.value.account,connection.value.space]))throw new Error('The workspace changed. Open the document again.')
  if(!job?.bundle||job.id!==id||scope!==JSON.stringify([job.source.server,job.source.account,job.workflowSpace??job.source.space]))throw new Error('The saved document does not match this workspace')
  if(expected&&(job.source.resourceId!==expected.resourceId||job.source.etag!==expected.etag))throw new Error('The document changed. Refresh the inbox.')
  if(job.bundle.source.resourceId!==job.source.resourceId||job.bundle.source.etag!==job.source.etag)throw new Error('The saved document does not match this workspace')
  validateBundle(job.bundle);pinnedJobId=id;installJobs([job,...jobs.value.filter(value=>value.id!==id)])
  selected.value=reviews.value.findIndex(review=>jobFor(review)?.id===id)
  return job
 }
 function beginInboxNavigation(entries:DraftFile[]){inboxNavigation.value={folder:folder.value,entries:entries.filter(file=>!file.folder).map(file=>({...file}))}}
 async function inboxLocation(file:DraftFile):Promise<RouteLocationRaw>{
  const cached=jobs.value.find(job=>job.source.resourceId===file.resourceId&&job.source.etag===file.etag),id=file.reviewJob===undefined?cached?.id:file.reviewJob,state=file.reviewState??cached?.state
  if(id&&!['failed','running','pending'].includes(state??'')){const job=await openJob(id,file);if(job.source.resourceId!==file.resourceId)throw new Error('The document changed. Refresh the inbox.');return{path:'/document-workflow/inbox',query:{job:id}}}
  return{path:'/document-workflow/details',query:{path:file.path,return:'inbox'}}
 }
 return {cloudProcessing,intakeSummary,inboxSummary,intakePaused,inboxSearch,inboxNavigation,beginInboxNavigation,inboxLocation,intakeConfigured,loadMoreReviews,activeSpace,spaces,switchingSpace,spaceError,loadSpaces,switchSpace,clearWorkspace,intakeQueue,intakeHealth,intakeSessionAttached,reviewsHaveMore,spaceName:()=>connection.value?(host?.spaceName(connection.value.space)||connection.value.spaceName||'Configured OpenCloud Space'):'',fileLocation:(space:string,path:string)=>connection.value?.mode==='live'?host?.folderLocation(space,path):undefined,folderLocation:(path:string)=>connection.value?.mode==='live'?host?.folderLocation(connection.value.space,path):undefined,storedPreferences,fieldDrafts,filingDrafts,capabilities,reviews,selected,policy,ai,connection,jobs,files,folder,connectionError,inbox,intakeEnabled,request,connect,refresh,savePreferences,prepareDocument,jobFor,openJob}
}
export type Workspace=ReturnType<typeof createWorkspace>
export const workspaceKey: InjectionKey<Workspace> = Symbol('document-workflow')
export function useWorkspace():Workspace{return inject(workspaceKey,null)??createWorkspace()}
