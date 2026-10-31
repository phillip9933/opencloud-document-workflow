// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from 'node:crypto'
import {validateBundle,validatePolicy,actions,reviewDigest} from '../src/domain/review.ts'
import {suggestMetadata,validateFieldValue} from '../src/domain/metadata.ts'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class Automation {
 constructor(workflow,metadata,intake){Object.assign(this,{w:workflow,db:workflow.db,metadata,intake});this.db.exec(`CREATE TABLE IF NOT EXISTS automatic_runs(job TEXT PRIMARY KEY,scope TEXT NOT NULL,authorization TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,updated TEXT NOT NULL)`);workflow.automation=this;workflow.automaticGuard=(actor,id,record)=>this.guard(actor,id,record)}
 settings(actor){const preferences=this.w.preference(actor),inbox=this.intake.configuration(actor);return{preferences,inbox,schema:this.metadata.schema(actor),processing:this.w.configuration?{...this.w.configuration.settings(actor),...(this.w.configuration.destinationSpace(actor)!==actor.space?{destinationSpace:this.w.configuration.destinationSpace(actor)}:{})}:null,ocr:this.db.prepare("select 1 from sqlite_master where type='table' and name='ocr_settings'").get()?this.db.prepare('select languages from ocr_settings where scope=?').get(this.w.scope(actor))?.languages??'[]':'[]'}}
 snapshot(actor){const value=this.settings(actor);return{...value,hash:digest(value)}}
 eligibility(actor,source){const {preferences,inbox}=this.settings(actor);if(!preferences||!inbox.enabled)return'Background ingestion is paused';const policy=validatePolicy(preferences.policy);if(policy.aiInput!=='automatic'||policy.aiOutput!=='automatic')return'AI processing is set to review';if(['rename','move','tags'].some(key=>policy[key]==='suggest'))return'Filing has stages set to Suggest';if(policy.ocr==='suggest')return'OCR is set to Suggest';if((policy.fields??'suggest')==='suggest')return'Fields are set to Suggest';if(!source.path.startsWith(inbox.folder+'/')||!inbox.recursive&&source.path.slice(inbox.folder.length+1).includes('/'))return'The document is outside the saved inbox';return null}
 guard(actor,id,record){const saved=this.db.prepare('select * from automatic_runs where job=? and scope=?').get(id,this.w.scope(actor));if(!saved||!['pending','running'].includes(saved.state)||saved.authorization!==JSON.stringify(record)||this.snapshot(actor).hash!==record.hash||!this.intake.configuration(actor).enabled)throw new Error('Automatic processing settings changed or were paused; inspect this operation before continuing')}
 update(actor,id,state,detail=null){this.db.prepare('update automatic_runs set state=?,detail=?,updated=? where job=? and scope=?').run(state,detail,new Date().toISOString(),id,this.w.scope(actor));this.w.event(actor,id,'automatic_'+state,detail?{reason:detail}:{})}
 async resume(actor,api){for(const row of this.db.prepare("select job from automatic_runs where scope=? and state in ('pending','running') order by created").all(this.w.scope(actor)))await this.run(actor,api,row.job,{resume:true})}
 async run(actor,api,id,options={}){
  this.w.job(actor,id);let release
  try{release=this.w.lock('automatic:'+id)}catch(e){if(e.message==='Operation already running')return{state:'running'};throw e}
  try{return await this.execute(actor,api,id,options)}finally{release()}
 }
 async execute(actor,api,id,{resume=false,retry=false}={}){
  const job=this.w.job(actor,id),source=JSON.parse(job.input).source;let prior=this.db.prepare('select * from automatic_runs where job=? and scope=?').get(id,this.w.scope(actor))
  if(retry&&prior&&['review','held'].includes(prior.state)){if(this.w.decision(actor,id))throw new Error('Inspect or take over the existing filing decision first');this.w.event(actor,id,'automatic_reauthorized',{previousAuthorization:JSON.parse(prior.authorization)});const snap=this.snapshot(actor),authorization={kind:'automatic',hash:snap.hash,configuration:snap,account:actor.account,space:actor.space,authorizedAt:new Date().toISOString()};this.db.prepare("update automatic_runs set state='pending',authorization=?,detail=NULL,updated=? where job=? and scope=?").run(JSON.stringify(authorization),authorization.authorizedAt,id,this.w.scope(actor));prior=this.db.prepare('select * from automatic_runs where job=?').get(id)}
  if(prior&&['done','review','held'].includes(prior.state))return{state:prior.state,detail:prior.detail}
  const issue=this.eligibility(actor,source);if(issue){if(prior)this.update(actor,id,'held',issue);return{state:'review',detail:issue}}
  const queue=this.db.prepare("select id from intake_queue where scope=? and job=? and state='prepared'").get(this.w.scope(actor),id);if(!queue)throw new Error('Automatic processing requires a prepared arrival from the saved inbox')
  const review=job.result?validateBundle(JSON.parse(job.result)):null;if(!review?.proposal)return{state:'review',detail:'The document needs text extraction or valid evidence'}
  if(!prior){const snap=this.snapshot(actor),authorization={kind:'automatic',hash:snap.hash,configuration:snap,account:actor.account,space:actor.space,authorizedAt:new Date().toISOString()};this.db.prepare("insert or ignore into automatic_runs values(?,?,?,'pending',NULL,?,?)").run(id,this.w.scope(actor),JSON.stringify(authorization),authorization.authorizedAt,authorization.authorizedAt)}
  const authorization=JSON.parse(this.db.prepare('select authorization from automatic_runs where job=?').get(id).authorization)
  try{
   this.guard(actor,id,authorization);const identity=await api.identity();if(this.w.scope(identity)!==this.w.scope(actor))throw new Error('The authenticated workspace changed')
   const policy=authorization.configuration.preferences.policy,decision=this.w.decision(actor,id)
   if(decision&&!JSON.parse(decision.record).automaticAuthorization){this.update(actor,id,'review','A separate document decision already exists');return{state:'review',detail:'A separate document decision already exists'}}
   if(review.ruleAmbiguous)throw new Error('More than one explicit filing category matches; inspect the rules and destination')
   if(review.excluded.length)throw new Error('Some proposed tags lack supporting evidence and need review')
   this.update(actor,id,'running')
   // Existing field values are preserved; only grounded, unambiguous missing values are filled.
   if(!decision){
    if(!await this.w.check(api,source.path,source,source.etag))throw new Error('The source changed before automatic processing')
    const schema=this.metadata.schema(actor),suggestions=suggestMetadata(schema,review.bundle.pages),current=this.metadata.read(actor,source.resourceId)
    if(policy.fields==='automatic'){
     for(const field of schema.fields)if(current.fields[field.id]!==undefined)validateFieldValue(field,current.fields[field.id])
     for(const field of schema.fields){const recognized=review.bundle.pages.some(page=>page.split(/\r?\n/).some(line=>field.aliases.some(alias=>line.trimStart().toLowerCase().startsWith(alias.toLowerCase())&&/^\s*[:：=]/.test(line.trimStart().slice(alias.length)))));if(recognized&&!suggestions.fields[field.id]&&current.fields[field.id]===undefined)throw new Error('A field is ambiguous or invalid and needs review: '+field.label)}
     const fields=Object.fromEntries(Object.entries(current.fields).filter(([id])=>schema.fields.some(field=>field.id===id)));for(const[id,value]of Object.entries(suggestions.fields))if(fields[id]===undefined)fields[id]=value.value
     if(Object.entries(fields).some(([id,value])=>current.fields[id]!==value)){this.guard(actor,id,authorization);await this.metadata.save(actor,api,{path:source.path,resourceId:source.resourceId,etag:source.etag,sha256:source.sha256,version:current.version,fields,addTags:[]})}
    }
    const planned=actions(review,policy),manual={target:planned.target,addTags:policy.tags==='automatic'?[...new Set([...planned.addTags,...suggestions.tags.map(t=>t.value)])]:[]}
    this.guard(actor,id,authorization)
    if(!planned.targetSpace&&manual.target===source.path&&!manual.addTags.length){this.update(actor,id,'done');return{state:'done',metadataOnly:true}}
    await this.w.approve(actor,api,id,policy,await reviewDigest(review,policy,manual),manual,{automaticAuthorization:authorization})
   }
   this.guard(actor,id,authorization);const result=await this.w.apply(actor,api,id);if(result.uncertain){this.update(actor,id,'held','The last file or tag outcome needs read-only verification');return result}
   this.update(actor,id,'done');return result
  }catch(e){this.update(actor,id,'held',e.message?.length<200?e.message:'Automatic processing needs attention');return{state:'held',detail:e.message}}
 }
 async takeOver(actor,api,id,shownDigest){
  const release=this.w.lock('automatic:'+id)
  try{
   const decision=this.w.decision(actor,id),run=this.statusFor(actor,id)
   if(!run)throw new Error('No automatic operation exists for this document')
   if(!decision){this.update(actor,id,'review','Taken over for manual review');return{state:'review'}}
   const record=JSON.parse(decision.record)
   if(!record.automaticAuthorization||shownDigest!==record.reviewDigest)throw new Error('Reload and inspect the saved filing plan before taking over')
   if(['done','conflict','rejected'].includes(decision.state))throw new Error('This decision cannot be taken over; inspect its current status')
   const checked=await this.w.apply(actor,api,id,{reconcileOnly:true})
   if(checked.uncertain)throw new Error('The last request outcome is uncertain; verify it before taking over')
   if(checked.state==='done'){this.update(actor,id,'done','Outcome confirmed by read-only verification');return checked}
   const releaseDecision=this.w.lock(id)
   try{
    const current=this.w.decision(actor,id)
    if(current.record!==decision.record)throw new Error('The filing plan changed; reload it')
    this.w.event(actor,id,'automatic_taken_over',{previousAuthorization:record.automaticAuthorization,state:current.state})
    record.manualTakeover={previousAuthorization:record.automaticAuthorization,reviewedAt:new Date().toISOString()};delete record.automaticAuthorization;record.reviewedAt=record.manualTakeover.reviewedAt
    this.db.prepare('update decisions set record=?,updated=? where job=? and actor=?').run(JSON.stringify(record),record.reviewedAt,id,actor.account)
    this.update(actor,id,'review','Taken over for manual filing');return{state:current.state}
   }finally{releaseDecision()}
  }finally{release()}
 }
 statusFor(actor,id){return this.db.prepare('select job,state,detail,created,updated from automatic_runs where job=? and scope=?').get(id,this.w.scope(actor))??null}
 status(actor){return this.db.prepare('select job,state,detail,created,updated from automatic_runs where scope=? order by created desc').all(this.w.scope(actor))}
}
