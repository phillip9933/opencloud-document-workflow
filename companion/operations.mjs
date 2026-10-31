// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from 'node:crypto'
export class Operations {
 constructor(workflow,{metadata,prepare}){Object.assign(this,{w:workflow,db:workflow.db,metadata,prepare});this.active=new Map();this.stopped=false;this.db.exec(`CREATE TABLE IF NOT EXISTS bulk_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bulk_items(operation TEXT NOT NULL,position INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(operation,position));`)}
 status(actor,id){const row=this.db.prepare('select id,kind,state,created,updated from bulk_operations where id=? and scope=?').get(id,this.w.scope(actor));if(!row)throw Object.assign(new Error('Operation not found'),{status:404});return{...row,items:this.db.prepare('select position,input,state,result from bulk_items where operation=? order by position').all(id).map(i=>({...i,input:JSON.parse(i.input),result:i.result?JSON.parse(i.result):null}))}}
 list(actor){return this.db.prepare('select id,kind,state,created,updated from bulk_operations where scope=? order by created desc').all(this.w.scope(actor))}
 start(actor,api,{id,kind,items}){
  if(!/^[a-f0-9-]{36}$/.test(id)||!['prepare','file','metadata','automatic'].includes(kind)||!Array.isArray(items)||!items.length||items.length>10000||items.some(i=>!i||typeof i!=='object'||Array.isArray(i)))throw new Error('Choose between 1 and 10000 documents for this operation')
  const scope=this.w.scope(actor),request=createHash('sha256').update(JSON.stringify({kind,items})).digest('hex'),old=this.db.prepare('select scope,request from bulk_operations where id=?').get(id)
  if(old){if(old.scope!==scope||old.request!==request)throw new Error('Operation ID is already used by a different request');return this.status(actor,id)}
  const now=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE')
  try{this.db.prepare("insert into bulk_operations values(?,?,?,?,'queued',?,?)").run(id,scope,kind,request,now,now);items.forEach((input,index)=>this.db.prepare("insert into bulk_items values(?,?,?,'queued',NULL)").run(id,index,JSON.stringify(input)));this.w.event(actor,null,'bulk_queued',{id,kind,count:items.length});this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}
  this.launch(actor,api,id);return this.status(actor,id)
 }
 launch(actor,api,id){this.status(actor,id);if(this.stopped||this.active.has(id))return;const task=this.run(actor,api,id);this.active.set(id,task);void task.finally(()=>this.active.delete(id)).catch(()=>{})}
 async run(actor,api,id){let release;try{
  release=this.w.lock('bulk:'+id);const operation=this.status(actor,id)
  this.db.prepare("update bulk_operations set state='running',updated=? where id=?").run(new Date().toISOString(),id)
  for(const item of operation.items){
   if(this.stopped)break
   if(item.state==='running'){this.item(id,item.position,'held',{error:'An interrupted operation needs inspection; it was not repeated'});continue}
   if(item.state!=='queued')continue
   this.item(id,item.position,'running',null)
   try{
    const verified=await api.identity();if(this.w.scope(verified)!==this.w.scope(actor))throw new Error('Workspace access changed')
    const physical=item.input.documentSpace?await this.w.transfers.adapter(actor,api,item.input.documentSpace):api
    let result
    if(operation.kind==='prepare')result=await this.prepare(actor,physical,item.input.path,{retry:item.input.retry===true,cloudConsent:item.input.cloudConsent===true,newReview:item.input.newReview===true})
    if(operation.kind==='metadata')result=await this.metadata.save(actor,physical,item.input)
    if(operation.kind==='automatic')result=await this.w.automation.run(actor,api,item.input.id)
    if(operation.kind==='file'){
     const {id:job,policy,reviewDigest,manualActions}=item.input,decision=this.w.decision(actor,job)
     if(decision){const approval=JSON.parse(decision.record);if(approval.reviewDigest!==reviewDigest||approval.automaticAuthorization)throw new Error('The saved approval needs individual inspection')}
     else await this.w.approve(actor,api,job,policy,reviewDigest,manualActions)
     result=await this.w.apply(actor,api,job)
    }
    this.item(id,item.position,result?.uncertain||['held','review'].includes(result?.state)?'held':'done',result)
   }catch(e){this.item(id,item.position,'held',{error:e.message?.length<220&&!/[\r\n]/.test(e.message)?e.message:'Inspect the document and its Activity before continuing'})}
  }
  const unfinished=this.db.prepare("select 1 from bulk_items where operation=? and state in ('queued','running') limit 1").get(id),state=unfinished?'paused':'completed'
  this.db.prepare('update bulk_operations set state=?,updated=? where id=?').run(state,new Date().toISOString(),id);this.w.event(actor,null,'bulk_'+state,{id})
 }catch{this.db.prepare("update bulk_operations set state='held',updated=? where id=?").run(new Date().toISOString(),id)}finally{release?.()}}
 item(id,position,state,result){this.db.prepare('update bulk_items set state=?,result=? where operation=? and position=?').run(state,result?JSON.stringify(result):null,id,position)}
 async stop(){this.stopped=true;await Promise.allSettled([...this.active.values()])}
}
