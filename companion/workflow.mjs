// SPDX-License-Identifier: AGPL-3.0-only
import {createHash,randomUUID} from 'node:crypto'
import {pageOptions,pageCursor} from './pagination.mjs'
import {hostname} from 'node:os'
import {extractPDFBytes} from './extract.mjs'
import {ocrPages} from './ocr.mjs'
import {validateAIConfig} from '../src/domain/ai.ts'
import {safePath,validateBundle,validatePolicy,createApproval,reviewDigest,approvalMatches} from '../src/domain/review.ts'
const sha=b=>createHash('sha256').update(b).digest('hex')
export class Workflow {
 constructor(journal){this.journal=journal;this.db=journal.db;this.db.exec(`
 CREATE INDEX IF NOT EXISTS proposals_resource_latest ON proposals(scope,json_extract(input,'$.source.resourceId'),updated DESC,id DESC);
 CREATE TABLE IF NOT EXISTS decisions(job TEXT PRIMARY KEY,actor TEXT NOT NULL,record TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS activity(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,job TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity BEGIN SELECT RAISE(ABORT,'Activity is append-only'); END;
 CREATE TABLE IF NOT EXISTS preferences(scope TEXT PRIMARY KEY,configuration TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workflow_locks(job TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);`)}
 scope(actor){return JSON.stringify([actor.server,actor.account,actor.space])}
 event(actor,job,kind,detail={}){this.db.prepare('INSERT INTO activity(scope,job,kind,detail,created) VALUES(?,?,?,?,?)').run(this.scope(actor),job,kind,JSON.stringify(detail),new Date().toISOString())}
 preference(actor){const row=this.db.prepare('select configuration from preferences where scope=?').get(this.scope(actor));return row?JSON.parse(row.configuration):null}
 savePreference(actor,configuration){if(!configuration||Object.keys(configuration).sort().join(',')!=='ai,policy')throw new Error('Unexpected preference fields');configuration={policy:validatePolicy(configuration.policy),ai:validateAIConfig(configuration.ai)};this.db.prepare('insert into preferences values(?,?) on conflict(scope) do update set configuration=excluded.configuration').run(this.scope(actor),JSON.stringify(configuration));this.event(actor,null,'settings_saved');return configuration}
 jobPage(actor,{id=null,activeOnly=false,...options}={}){
  const {limit,after}=pageOptions({limit:200,...options})
  const rows=this.db.prepare(`select p.id,p.state,p.attempts,p.result,p.input sourceInput,p.error,p.updated,d.state decision,d.record approval from proposals p left join decisions d on d.job=p.id where p.scope=? and (? is null or p.id=?) and (?=0 or (d.state is null or d.state<>'done') ${this.automation?"and not exists(select 1 from automatic_runs a where a.job=p.id and a.state='done')":''}) and (? is null or p.updated<? or (p.updated=? and p.id<?)) order by p.updated desc,p.id desc limit ?`).all(this.scope(actor),id,id,activeOnly?1:0,after?.time??null,after?.time??null,after?.time??null,after?.id??null,limit+1)
  const jobs=rows.slice(0,limit).map(j=>({...j,source:JSON.parse(j.sourceInput).source,sourceInput:undefined,approval:j.approval?JSON.parse(j.approval):null,workflowSpace:actor.space,automation:this.automation?.statusFor(actor,j.id)??null,bundle:j.result?JSON.parse(j.result):null,result:undefined})),last=jobs.at(-1)
  return{jobs,nextCursor:rows.length>limit?pageCursor(last.updated,last.id):null,hasMore:rows.length>limit}
 }
 jobs(actor,options={}){return this.jobPage(actor,options).jobs}
 jobsHaveMore(actor,options={}){return this.jobPage(actor,options).hasMore}
 jobView(actor,id){this.job(actor,id);return this.jobs(actor,{id})[0]}
 activityPage(actor,options={}){
  const {limit,after}=pageOptions(options,'number'),rows=this.db.prepare('select seq,job,kind,detail,created from activity where scope=? and (? is null or seq<?) order by seq desc limit ?').all(this.scope(actor),after?.time??null,after?.time??null,limit+1),events=rows.slice(0,limit).map(e=>({...e,detail:JSON.parse(e.detail)}))
  return{events,nextCursor:rows.length>limit?pageCursor(events.at(-1).seq,'activity'):null}
 }
 history(actor,options={}){return this.activityPage(actor,{limit:200,...options}).events}
 job(actor,id){const job=this.journal.get(id);if(!job||job.scope!==this.scope(actor))throw Object.assign(new Error('Job not found'),{status:404});return job}
 decision(actor,id){this.job(actor,id);return this.db.prepare('select * from decisions where job=? and actor=?').get(id,actor.account)}
 async location(actor,api,id){
  const job=this.job(actor,id),source=JSON.parse(job.input).source,decision=this.decision(actor,id)
  const approval=decision?.record&&JSON.parse(decision.record),target=approval?.actions?.target,sourceAPI=source.space===actor.space?api:api.forSpace(source.space),targetSpace=approval?.actions?.targetSpace??source.space,targetAPI=targetSpace===source.space?sourceAPI:api.forSpace(targetSpace)
  const expectedTarget=targetSpace===source.space?source.resourceId:this.db.prepare('select resource from cross_transfers where job=? and scope=?').get(id,this.scope(actor))?.resource
  const found=[]
  const mapped=this.transfers?this.db.prepare('select * from file_locations where scope=? and resource=? and sha=?').get(this.scope(actor),this.transfers.canonical(actor,source.resourceId,source.space),source.sha256):null
  const locations=[...(mapped?[{path:mapped.path,api:mapped.space===actor.space?api:api.forSpace(mapped.space),space:mapped.space,resource:mapped.target_resource}]:[]),{path:source.path,api:sourceAPI,space:source.space,resource:source.resourceId},...(target?[{path:target,api:targetAPI,space:targetSpace,resource:expectedTarget}]:[])]
  const seen=new Set();for(const item of locations){const key=JSON.stringify([item.space,item.path]);if(seen.has(key)||!item.resource)continue;seen.add(key);safePath(item.path);const current=await item.api.stat(item.path);if(current&&!current.folder&&current.resourceId===item.resource)found.push({...current,space:item.space})}
  if(found.length!==1)throw new Error('The original resource could not be located uniquely at its recorded paths. Inspect it in OpenCloud.')
  return{path:found[0].path,resourceId:found[0].resourceId,etag:found[0].etag,space:found[0].space}

 }
 async prepare(actor,api,path,configuration,{retry=false,newReview=false,cloudKey}={}){
  const release=this.lock('__prepare__');try{
  safePath(path);const before=await api.stat(path);if(!before||before.folder)throw new Error('PDF source not found')
  const settings=this.configuration?.settings(actor),bytes=await api.get(path,before.etag,settings?.limits.maxMiB*1024*1024),after=await api.stat(path)
  if(after?.resourceId!==before.resourceId||after?.etag!==before.etag)throw new Error('Source changed during reading')
  const source={server:actor.server,account:actor.account,space:api.space??actor.space,resourceId:before.resourceId,path,etag:before.etag,sha256:sha(bytes)}
  const input=await extractPDFBytes(bytes,source,settings?.limits)
  if(configuration.policy.ocr!=='off'&&input.pages.some(p=>!p.trim())){input.pages=await ocrPages(bytes,input.pages,configuration.ocrLanguages??[],settings?.limits);this.event(actor,null,'ocr_extracted',{resourceId:source.resourceId,languages:configuration.ocrLanguages})}
  if(settings){input.rules=settings.rules;const targetSpace=this.configuration.destinationSpace(actor);if(targetSpace!==source.space)input.destinationSpace=targetSpace}
  if(newReview){const prior=this.db.prepare("select d.state decision from proposals p left join decisions d on d.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId')=? order by p.updated desc,p.id desc limit 1").get(this.scope(actor),this.transfers?.canonical(actor,source.resourceId,source.space)??source.resourceId);if(!prior||!['rejected','conflict','done'].includes(prior.decision))throw new Error('A new review requires a rejected, conflicted or completed prior decision');configuration={...configuration,reviewRevision:randomUUID()}}
  this.event(actor,null,'preparation_started',{path,resourceId:source.resourceId})
  try{const result=await this.journal.prepare(input,configuration,{retry,cloudKey,scope:this.scope(actor)});if(result.review.ruleMatch&&!result.cached)this.event(actor,result.id,'filing_rule_matched',{category:result.review.ruleMatch});this.event(actor,result.id,result.cached?'proposal_reopened':result.review.state,{path});return{id:result.id,bundle:result.review.bundle,cached:result.cached}}
  catch(e){this.event(actor,null,'preparation_held',{path});throw e}
  }finally{release()}
 }
 async check(api,path,source,etag,limitActor=source){const current=await api.stat(path);if(!current||current.folder||current.resourceId!==source.resourceId||etag&&current.etag!==etag)return null;const bytes=await api.get(path,current.etag,(this.configuration?.settings(limitActor).limits.maxMiB??100)*1024*1024);if(sha(bytes)!==source.sha256)return null;const after=await api.stat(path);if(after?.etag!==current.etag||after?.resourceId!==source.resourceId)return null;return current}
 async approve(actor,api,id,policy,digest,manualActions,options={}){
  const check=(api,path,source,etag)=>this.check(api,path,source,etag,actor)
  const job=this.job(actor,id);if(!job.result)throw new Error('A validated proposal is required')
  const old=this.decision(actor,id);if(old&&old.state!=='rejected')throw new Error('Decision already recorded; inspect its current status')
  const review=validateBundle(JSON.parse(job.result))
  if(api.space&&api.space!==review.bundle.source.space)api=await this.transfers.adapter(actor,api,review.bundle.source.space)
  if(digest!==await reviewDigest(review,policy,manualActions))throw new Error('Review changed; reload and review again')
  if(!await check(api,review.bundle.source.path,review.bundle.source,review.bundle.source.etag))throw new Error('Source changed; prepare and review a new proposal')
  const record=await createApproval(review,policy,manualActions)
  if(record.actions.targetSpace)await this.transfers.adapter(actor,api,record.actions.targetSpace)
  if(options.automaticAuthorization){delete record.reviewedAt;record.automaticAuthorization=options.automaticAuthorization;record.authorizedAt=options.automaticAuthorization.authorizedAt}
  const saved=this.db.prepare("insert into decisions(job,actor,record,state,updated) values(?,?,?,'approved',?) on conflict(job) do update set record=excluded.record,state='approved',plan=NULL,updated=excluded.updated WHERE decisions.state='rejected'").run(id,actor.account,JSON.stringify(record),new Date().toISOString())
  if(!saved.changes)throw new Error('Another decision was recorded; reload before continuing')
  this.event(actor,id,options.automaticAuthorization?'automatically_authorized':'approved',{target:record.actions.target,tags:record.actions.addTags});return{state:'approved'}
 }
 reject(actor,id){const job=this.job(actor,id);if(this.decision(actor,id))throw new Error('A decision is already recorded');this.db.prepare("insert into decisions(job,actor,record,state,updated) values(?,?,?,'rejected',?)").run(id,actor.account,'{}',new Date().toISOString());this.event(actor,job.id,'rejected');return{state:'rejected'}}
 lock(id){const owner=randomUUID();this.db.exec('BEGIN IMMEDIATE');try{const r=this.db.prepare('select * from workflow_locks where job=?').get(id);if(r){if(r.host!==hostname())throw new Error('Another host owns this operation');try{process.kill(r.pid,0);throw new Error('Operation already running')}catch(e){if(e.code!=='ESRCH')throw e}this.db.prepare('delete from workflow_locks where job=?').run(id)}this.db.prepare('insert into workflow_locks values(?,?,?,?)').run(id,owner,process.pid,hostname());this.db.exec('COMMIT');return()=>this.db.prepare('delete from workflow_locks where job=? and owner=?').run(id,owner)}catch(e){this.db.exec('ROLLBACK');throw e}}
 set(actor,id,state,plan){this.db.prepare('update decisions set state=?,plan=?,updated=? where job=? and actor=?').run(state,JSON.stringify(plan),new Date().toISOString(),id,actor.account);this.event(actor,id,state);if(state==='done'&&plan){const approval=JSON.parse(this.decision(actor,id).record);if(!approval.actions.targetSpace&&this.transfers){const canonical=this.transfers.canonical(actor,approval.source.resourceId,approval.source.space);if(canonical!==approval.source.resourceId)this.db.prepare('update file_locations set path=?,job=? where scope=? and resource=?').run(approval.actions.target,id,this.scope(actor),canonical)}}}
 async apply(actor,api,id,{reconcileOnly=false}={}){
  this.decision(actor,id)
  const check=(api,path,source,etag)=>this.check(api,path,source,etag,actor)
  const release=this.lock(id);let releaseResource
  try{
   const decision=this.decision(actor,id);if(!decision||decision.state==='rejected')throw new Error('Human approval is required')
   const approval=JSON.parse(decision.record),source=approval.source,target=approval.actions.target,tags=approval.actions.addTags
   releaseResource=this.lock(`resource:${this.scope(actor)}:${this.transfers?.canonical(actor,source.resourceId,source.space)??source.resourceId}`)
   if(api.space&&source.space!==api.space)api=await this.transfers.adapter(actor,api,source.space)
   const review=validateBundle(JSON.parse(this.job(actor,id).result))
   if(!await approvalMatches(approval,review.bundle,approval.policy))throw new Error('Approval no longer matches the proposal')
   const guard=()=>{if(approval.automaticAuthorization){if(!this.automaticGuard)throw new Error('Automatic authorization must be checked before writing');this.automaticGuard(actor,id,approval.automaticAuthorization)}}
   let state=decision.state,plan=decision.plan?JSON.parse(decision.plan):{}
   const metadataTable=this.db.prepare("select 1 from sqlite_master where type='table' and name='metadata_changes'").get()
   if(!reconcileOnly&&state!=='done'&&metadataTable&&this.db.prepare("select id from metadata_changes where scope=? and resource=? and state='intent' limit 1").get(this.scope(actor),this.transfers?.canonical(actor,source.resourceId,source.space)??source.resourceId))throw new Error('A metadata save needs verification. Open custom fields and recheck it before filing.')
   const conflict=()=>{this.set(actor,id,'conflict',plan);throw new Error('Remote state conflicts with the approved operation; no further writes made')}
   if(state==='conflict')throw new Error('Conflict requires a new reviewed proposal')
   if(approval.actions.targetSpace){
    if(!plan.originalTags){const current=await check(api,source.path,source,source.etag);if(!current)return conflict();plan={originalTags:current.tags,expectedTags:[...new Set([...current.tags,...tags])].sort()}}
    return await this.transfers.apply(actor,api,id,approval,plan,{reconcileOnly,guard})
   }
   if(state==='done'){
    const final=await check(api,target,source);if(!final||!plan.expectedTags.every(t=>final.tags.includes(t)))return conflict()
    return{state:'done',target,tags:final.tags,verification:{checkedAt:new Date().toISOString(),resourceId:final.resourceId,sha256:source.sha256}}
   }
   if(state==='approved'){
    if(reconcileOnly)return{state:'approved',target}
    const current=await check(api,source.path,source,source.etag);if(!current)return conflict()
    if(target!==source.path&&await api.stat(target))return conflict()
    plan={originalTags:current.tags,expectedTags:[...new Set([...current.tags,...tags])].sort()}
    this.set(actor,id,'folders_pending',plan);state='folders_pending'
   }
   if(state==='folders_pending'){
    if(reconcileOnly)return{state,target}
    if(!await check(api,source.path,source,source.etag))return conflict()
    const folders=target.split('/').slice(0,-1);for(let n=1;n<=folders.length;n++){const folder=folders.slice(0,n).join('/');guard();this.event(actor,id,'folder_intent',{folder});await api.mkdir(folder)}
    if(target===source.path){this.set(actor,id,'move_done',plan);state='move_done'}else{
     if(await api.stat(target))return conflict()
     guard();this.set(actor,id,'move_intent',plan)
     try{await api.move(source.path,target,source.etag)}catch(e){this.event(actor,id,'move_response_uncertain');throw e}
     state='move_intent'
    }
   }
   if(state==='move_intent'){
    const destination=await check(api,target,source)
    if(!destination){if(await api.stat(target))return conflict();const original=await check(api,source.path,source,source.etag);if(original)return{state:'move_intent',uncertain:true,target};return conflict()}
    if(await api.stat(source.path))return conflict()
    this.set(actor,id,'move_done',plan);state='move_done'
   }
   if(state==='move_done'){
    const current=await check(api,target,source);if(!current||!plan.originalTags.every(t=>current.tags.includes(t)))return conflict()
    if(tags.every(t=>current.tags.includes(t))){this.set(actor,id,'done',plan);return{state:'done',target,tags:current.tags}}
    if(reconcileOnly)return{state:'move_done',target}
    guard();this.set(actor,id,'tags_intent',plan)
    try{await api.addTags(source.resourceId,tags)}catch(e){this.event(actor,id,'tags_response_uncertain');throw e}
    state='tags_intent'
   }
   if(state==='tags_intent'){
    const current=await check(api,target,source)
    if(!current||!plan.originalTags.every(t=>current.tags.includes(t)))return conflict()
    if(!plan.expectedTags.every(t=>current.tags.includes(t)))return{state:'tags_intent',uncertain:true,target}
    this.set(actor,id,'done',plan);return{state:'done',target,tags:current.tags}
   }
   throw new Error('Unexpected operation state')
  }finally{releaseResource?.();release()}
 }
}
