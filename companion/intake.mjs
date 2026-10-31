// SPDX-License-Identifier: AGPL-3.0-only
import {createHash,randomUUID} from 'node:crypto'
import {pageOptions,pageCursor} from './pagination.mjs'
import {safePath} from '../src/domain/review.ts'
export const defaultIntake=()=>({enabled:false,folder:'Inbox',recursive:true,intervalSeconds:30,settleSeconds:10,cloudConsent:false})
export function validateIntake(c){if(!c||Object.keys(c).sort().join(',')!=='cloudConsent,enabled,folder,intervalSeconds,recursive,settleSeconds'||typeof c.cloudConsent!=='boolean'||typeof c.enabled!=='boolean'||typeof c.recursive!=='boolean'||!Number.isInteger(c.intervalSeconds)||(c.intervalSeconds!==0&&c.intervalSeconds<5)||c.intervalSeconds>86400||!Number.isInteger(c.settleSeconds)||c.settleSeconds<2||c.settleSeconds>3600)throw new Error('Invalid intake settings');safePath(c.folder);return structuredClone(c)}
const sha=b=>createHash('sha256').update(b).digest('hex')
export class Intake {
 constructor(workflow,{prepare,processPrepared,resume,now=()=>Date.now(),schedule=setTimeout,cancel=clearTimeout}={}){this.w=workflow;this.db=workflow.db;this.prepare=prepare;this.processPrepared=processPrepared;this.resume=resume;this.now=now;this.schedule=schedule;this.cancel=cancel;this.manualChecks=new Map();this.sessions=new Map();this.running=false;this.activeScope=null;this.stopped=false;this.db.exec(`CREATE TABLE IF NOT EXISTS intake_settings(scope TEXT PRIMARY KEY,value TEXT NOT NULL,last_scan INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS intake_health(scope TEXT PRIMARY KEY,last_attempt INTEGER,last_success INTEGER,reason TEXT,message TEXT);
 CREATE TABLE IF NOT EXISTS intake_queue(id TEXT PRIMARY KEY,scope TEXT NOT NULL,resource TEXT NOT NULL,path TEXT NOT NULL,etag TEXT NOT NULL,first_seen INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,job TEXT,detail TEXT);
 CREATE INDEX IF NOT EXISTS intake_scope ON intake_queue(scope,state);
 CREATE TABLE IF NOT EXISTS intake_content(scope TEXT NOT NULL,sha TEXT NOT NULL,resource TEXT NOT NULL,job TEXT,PRIMARY KEY(scope,sha));`);if(!this.db.prepare('pragma table_info(intake_queue)').all().some(c=>c.name==='last_seen'))this.db.exec('ALTER TABLE intake_queue ADD COLUMN last_seen TEXT')}
 configuration(actor){const r=this.db.prepare('select value from intake_settings where scope=?').get(this.w.scope(actor));return r?JSON.parse(r.value):defaultIntake()}
 save(actor,value,api){const checked=validateIntake(value),destination=this.w.configuration?.settings(actor).rules.root??'Filed',sameFolder=this.configuration(actor).folder===checked.folder,scope=this.w.scope(actor);if((this.w.configuration?.destinationSpace(actor)??actor.space)===actor.space&&(checked.folder===destination||checked.folder.startsWith(destination+'/')))throw new Error('Choose an inbox outside the filing destination');this.db.prepare('insert into intake_settings(scope,value) values(?,?) on conflict(scope) do update set value=excluded.value,last_scan=0').run(scope,JSON.stringify(checked));this.db.prepare('insert into intake_health(scope) values(?) on conflict(scope) do update set last_attempt=NULL,reason=NULL,message=NULL,last_success=case when ? then last_success else NULL end').run(scope,sameFolder?1:0);if(JSON.stringify(checked)!==this.manualChecks.get(scope)?.configuration)this.cancelCheck(scope);this.attach(actor,api);this.w.event(actor,null,checked.enabled?'intake_enabled':'intake_paused',{folder:checked.folder});return checked}
 attach(actor,api){this.sessions.set(this.w.scope(actor),{actor,api})}
 status(actor,options={}){
  const scope=this.w.scope(actor),configuration=this.configuration(actor),sessionAttached=this.sessions.has(scope),active=this.activeScope===scope
  const health=this.db.prepare('select last_attempt lastAttempt,last_success lastSuccess,reason,message from intake_health where scope=?').get(scope)??{lastAttempt:null,lastSuccess:null,reason:null,message:null}
  const state=!configuration.enabled?(active?'pausing':'paused'):active?'running':!sessionAttached?'waiting_for_session':health.reason==='session'?'resuming':health.reason?'held':health.lastSuccess!==null?'ready':'starting'
  const {limit,after}=pageOptions(options,'number'),rows=this.db.prepare('select q.id,q.resource,q.path,q.etag,q.state,q.attempts,q.job,q.detail,q.first_seen firstSeen,d.state decision from intake_queue q left join decisions d on d.job=q.job and d.actor=? where q.scope=? and (? is null or q.first_seen<? or(q.first_seen=? and q.id<?)) order by q.first_seen desc,q.id desc limit ?').all(actor.account,scope,after?.time??null,after?.time??null,after?.time??null,after?.id??null,limit+1),queue=rows.slice(0,limit).map(row=>({...row,automation:row.state==='prepared'?(this.w.automation?.statusFor(actor,row.job)??null):null}))
  return{configuration,configured:!!this.db.prepare('select 1 from intake_settings where scope=?').get(scope),queue,nextCursor:rows.length>limit?pageCursor(queue.at(-1).firstSeen,queue.at(-1).id):null,sessionAttached,health:{...health,state,manualCheck:this.manualChecks.get(scope)?.state??null,manualOnly:configuration.intervalSeconds===0,nextScanAt:configuration.enabled&&configuration.intervalSeconds>0&&sessionAttached&&!active?Math.max(this.now(),(health.lastAttempt??0)+configuration.intervalSeconds*1000):null}}

 }
 cancelCheck(scope){const check=this.manualChecks.get(scope);if(check?.timer!==undefined)this.cancel(check.timer);this.manualChecks.delete(scope)}
 requestCheck(actor){
  const scope=this.w.scope(actor),configuration=this.configuration(actor)
  if(!configuration.enabled)throw new Error('Enable inbox processing before checking for documents')
  if(this.stopped||!this.sessions.has(scope))throw new Error('Reconnect OpenCloud before checking the inbox')
  if(this.manualChecks.has(scope))return{state:'scheduled'}
  const check={state:'checking',configuration:JSON.stringify(configuration),cohort:null,timer:undefined}
  this.manualChecks.set(scope,check);this.scheduleCheck(scope,check,0)
  return{state:'scheduled'}
 }
 scheduleCheck(scope,check,delay){check.timer=this.schedule(()=>{check.timer=undefined;void this.runCheck(scope,check).catch(()=>{if(this.manualChecks.get(scope)===check)this.cancelCheck(scope)})},delay);check.timer?.unref?.()}
 async runCheck(scope,check){
  if(this.stopped||this.manualChecks.get(scope)!==check)return
  const session=this.sessions.get(scope)
  if(!session||JSON.stringify(this.configuration(session.actor))!==check.configuration){this.cancelCheck(scope);return}
  if(this.running){this.scheduleCheck(scope,check,250);return}
  check.state='checking'
  const completed=await this.tick({force:true,scope,queueIds:check.cohort})
  if(this.stopped||this.manualChecks.get(scope)!==check)return
  if(!completed){this.scheduleCheck(scope,check,250);return}
  const health=this.db.prepare('select reason from intake_health where scope=?').get(scope)
  if(!check.cohort&&!health?.reason){
   // One explicit check includes a single settling recheck of this exact cohort.
   // Later arrivals and changing uploads wait for the next check in manual mode.
   const config=JSON.parse(check.configuration),pending=this.db.prepare("select id,first_seen from intake_queue where scope=? and state='settling' and first_seen+?>?").all(scope,config.settleSeconds*1000,this.now())
   if(pending.length){check.cohort=pending.map(row=>row.id);check.state='settling';this.scheduleCheck(scope,check,Math.max(...pending.map(row=>row.first_seen+config.settleSeconds*1000))-this.now());return}
  }
  this.cancelCheck(scope)
 }
 retry(actor,id){const r=this.db.prepare('select * from intake_queue where id=? and scope=?').get(id,this.w.scope(actor));if(!r||r.state!=='failed')throw new Error('Only failed jobs can be retried');this.db.prepare("update intake_queue set state='queued',attempts=0,next_attempt=0 where id=?").run(id);this.w.event(actor,r.job,'intake_retry',{id,previousAttempts:r.attempts})}
 async scan(actor,api,config){
  const destination=this.w.configuration?.settings(actor).rules.root??'Filed',paths=[config.folder],visited=new Set(),scan=randomUUID(),scope=this.w.scope(actor)
  if((this.w.configuration?.destinationSpace(actor)??actor.space)===actor.space&&(config.folder===destination||config.folder.startsWith(destination+'/')))throw new Error('The inbox is inside the filing destination')
  while(paths.length){
   if(this.stopped||!this.configuration(actor).enabled)throw new Error('Ingestion paused')
   const path=paths.pop();if(visited.has(path))throw new Error('Repeated inbox folder');visited.add(path)
   const files=await api.list(path)
   for(const f of files){
    safePath(f.path);if(!f.path.startsWith(path+'/')||f.path.slice(path.length+1).includes('/'))throw new Error('Intake listing outside requested folder')
    if(f.folder){if(config.recursive&&((this.w.configuration?.destinationSpace(actor)??actor.space)!==actor.space||f.path!==destination&&!f.path.startsWith(destination+'/')))paths.push(f.path)}
    else if(/\.pdf$/i.test(f.path)){
     if(!f.resourceId||!f.etag)throw new Error('Intake file identity missing')
     const id=sha(JSON.stringify([scope,f.resourceId,f.etag,f.path]))
     this.db.prepare("insert into intake_queue(id,scope,resource,path,etag,first_seen,state,last_seen) values(?,?,?,?,?,?,'settling',?) on conflict(id) do update set last_seen=excluded.last_seen,detail=case when state='trashed' then 'Restored from OpenCloud Trash; automatic duplicate handling is paused for this copy.' else detail end,state=case when state='trashed' then 'restored' else state end").run(id,scope,f.resourceId,f.path,f.etag,this.now(),scan)
    }
   }
  }
  return scan
 }

 async tick({force=false,scope:requestedScope,queueIds=null}={}){
  if(this.running||this.stopped)return false;this.running=true
  let release
  try{release=this.w.lock('__intake__')
   for(const [scope,session] of this.sessions){if(requestedScope&&scope!==requestedScope)continue;const {actor,api}=session,c=this.configuration(actor);if(!c.enabled)continue
    const setting=this.db.prepare('select last_scan from intake_settings where scope=?').get(scope),health=this.db.prepare('select last_attempt from intake_health where scope=?').get(scope);if(!force&&(c.intervalSeconds===0||this.manualChecks.has(scope)||this.now()-(health?.last_attempt??setting.last_scan)<c.intervalSeconds*1000))continue
    this.activeScope=scope
    this.db.prepare('insert into intake_health(scope,last_attempt) values(?,?) on conflict(scope) do update set last_attempt=excluded.last_attempt').run(scope,this.now())
    try{
     const verified=await api.identity();if(this.w.scope(verified)!==scope)throw Object.assign(new Error('Intake identity changed'),{status:403})
     this.db.prepare('update intake_settings set last_scan=? where scope=?').run(this.now(),scope);const seen=await this.scan(actor,api,c)
     // Interrupted attempts can be retried only under the process ownership lock.
     this.db.prepare("update intake_queue set state='queued' where scope=? and state='running' and attempts<3").run(scope)
     this.db.prepare("update intake_queue set state='failed',detail='Attempt limit reached' where scope=? and state='running' and attempts>=3").run(scope)
     const queue=this.db.prepare("select * from intake_queue where scope=? and state in ('settling','queued','failed') and attempts<3 and next_attempt<=? and (? is null or id in (select value from json_each(?))) order by first_seen limit ?").all(scope,this.now(),queueIds?JSON.stringify(queueIds):null,queueIds?JSON.stringify(queueIds):null,this.w.configuration?.settings(actor).limits.documentsPerCycle??20)
     for(const item of queue){
      if(JSON.stringify(this.configuration(actor))!==JSON.stringify(c)||!c.enabled||this.stopped||!force&&this.configuration(actor).intervalSeconds===0)break
      if(item.first_seen+c.settleSeconds*1000>this.now())continue
      const visible=item.last_seen===seen
      if(!visible){this.db.prepare("update intake_queue set state='superseded' where id=?").run(item.id);continue}
      this.db.prepare("update intake_queue set state='running',attempts=attempts+1 where id=?").run(item.id)
      try{
       const bytes=await api.get(item.path,item.etag,(this.w.configuration?.settings(actor).limits.maxMiB??100)*1024*1024),contentHash=sha(bytes)
       // The first attempted resource keeps ownership even if inference fails.
       // Later failed duplicate attempts must not reverse the link on a retry.
       const prior=this.db.prepare("select id,json_extract(input,'$.source.resourceId') resource from proposals where scope=? and json_extract(input,'$.source.sha256')=? and (result is not null or state in ('failed','running')) order by updated,id limit 1").get(scope,contentHash)
       this.db.prepare('insert or ignore into intake_content values(?,?,?,?)').run(scope,contentHash,prior?.resource??item.resource,prior?.id??null)
       const owner=this.db.prepare('select resource,job from intake_content where scope=? and sha=?').get(scope,contentHash)
       if(owner.resource!==item.resource){this.db.prepare("update intake_queue set state='duplicate',detail=?,job=? where id=?").run('Identical bytes already have a review attempt; inspect the original resource',owner.job,item.id);this.w.event(actor,owner.job,'duplicate_held',{path:item.path,resourceId:item.resource});continue}
       const done=this.db.prepare("select p.id from proposals p join decisions d on d.job=p.id where p.scope=? and d.state='done' and json_extract(p.input,'$.source.resourceId')=? and json_extract(p.input,'$.source.sha256')=? and json_extract(d.record,'$.actions.target')=? limit 1").get(scope,item.resource,contentHash,item.path)
       const result=done??await this.prepare(actor,api,item.path,{retry:item.attempts>0,cloudConsent:c.cloudConsent});this.db.prepare('update intake_content set job=? where scope=? and sha=? and resource=?').run(result.id,scope,contentHash,item.resource);this.db.prepare("update intake_queue set state='prepared',job=?,detail=NULL where id=?").run(result.id,item.id);this.w.event(actor,result.id,'intake_prepared',{path:item.path});if(this.processPrepared)await this.processPrepared(actor,api,result.id)
      }catch{this.db.prepare("update intake_content set job=(select p.id from proposals p where p.scope=intake_content.scope and json_extract(p.input,'$.source.sha256')=intake_content.sha and json_extract(p.input,'$.source.resourceId')=intake_content.resource order by p.updated desc,p.id desc limit 1) where scope=? and resource=?").run(scope,item.resource);const attempts=item.attempts+1;this.db.prepare("update intake_queue set state='failed',next_attempt=?,detail=? where id=?").run(this.now()+Math.min(3600,30*2**attempts)*1000,'Preparation held; inspect AI settings, OCR and Activity',item.id);this.w.event(actor,null,'intake_held',{path:item.path,attempts})}
     }
     if(this.resume&&!this.stopped)await this.resume(actor,api)
     this.db.prepare('update intake_health set last_success=?,reason=NULL,message=NULL where scope=?').run(this.now(),scope)
    }catch(e){
     const sessionFailure=[401,403].includes(e.status),message=sessionFailure?'Session expired or access revoked':'Check source folder access, session and connectivity'
     this.db.prepare('update intake_health set reason=?,message=? where scope=?').run(sessionFailure?'session':'source',message,scope)
     this.w.event(actor,null,'intake_scan_held',{reason:message})
     // A request may attach a freshly verified adapter while the old scan awaits I/O.
     // Failure of the older credential must never discard that newer session.
     if(sessionFailure&&this.sessions.get(scope)===session)this.sessions.delete(scope)
    }finally{this.activeScope=null}
   }
  return true
  }catch(e){if(!e.message.includes('already running'))throw e;return false}finally{release?.();this.running=false}
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{})},1000);this.timer.unref()}
 async stop(){this.stopped=true;clearInterval(this.timer);for(const scope of this.manualChecks.keys())this.cancelCheck(scope);while(this.running)await new Promise(r=>setTimeout(r,20))}
}
