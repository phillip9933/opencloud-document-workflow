// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {ProposalJournal} from '../../companion/journal.mjs'
import {Workflow} from '../../companion/workflow.mjs'
import {DemoAdapter} from '../../companion/demo.mjs'
import {extractPDFBytes} from '../../companion/extract.mjs'
import {defaultAIConfig} from '../../src/domain/ai.ts'
import {samples} from '../../src/domain/samples.ts'
import {defaultPolicy,validateBundle,reviewDigest} from '../../src/domain/review.ts'
const config={endpoint:'http://127.0.0.1:11434',model:'fixture-model',policy:defaultPolicy()}
async function setup(){const dir=mkdtempSync(join(tmpdir(),'workflow-service-')),path=join(dir,'db.sqlite3'),j=new ProposalJournal(path),w=new Workflow(j),api=new DemoAdapter(j.db);api.seed();const actor=await api.identity(),s=await api.stat('Inbox/english.pdf'),input=await extractPDFBytes(await api.get(s.path),{server:actor.server,account:actor.account,space:actor.space,path:s.path,resourceId:s.resourceId,etag:s.etag,sha256:'a'.repeat(64)})
 const proposal=structuredClone(samples()[0].proposal);proposal.tags=proposal.tags.filter(t=>t.value!=='Synthetic');const result=await j.prepare(input,config,{planner:async i=>validateBundle({...i,proposal})});return{dir,path,j,w,api,actor,result,close(){this.j.close();rmSync(dir,{recursive:true})}}}
async function approve(s,policy=defaultPolicy()){return s.w.approve(s.actor,s.api,s.result.id,policy,await reviewDigest(s.result.review,policy))}
test('approved filing preserves bytes, resource identity and existing tags; repeated applies do not write',async()=>{
 const s=await setup();try{let moves=0,tags=0;const move=s.api.move.bind(s.api),add=s.api.addTags.bind(s.api);s.api.move=async(...a)=>{moves++;return move(...a)};s.api.addTags=async(...a)=>{tags++;return add(...a)}
 await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/approval/);assert.equal(moves,0)
 await approve(s);const result=await s.w.apply(s.actor,s.api,s.result.id);assert.equal(result.state,'done');const final=await s.api.stat(result.target);assert.equal(final.resourceId,'demo-english');assert.ok(final.tags.includes('Keep existing'));assert.ok(final.tags.includes('Electricity'));assert.equal(createHash('sha256').update(await s.api.get(result.target)).digest('hex'),s.result.review.bundle.source.sha256);assert.equal(await s.api.stat('Inbox/english.pdf'),null)
 const verified=await s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true});assert.equal(verified.verification.resourceId,'demo-english');assert.equal(verified.verification.sha256,s.result.review.bundle.source.sha256);assert.ok(Date.parse(verified.verification.checkedAt));assert.equal(moves,1);assert.equal(tags,1)
 s.j.close();s.j=new ProposalJournal(s.path);s.w=new Workflow(s.j);s.api=new DemoAdapter(s.j.db);s.api.move=async()=>{moves++;throw new Error('unexpected replay')};s.api.addTags=async()=>{tags++;throw new Error('unexpected replay')};await s.w.apply(s.actor,s.api,s.result.id);assert.equal(moves,1);assert.equal(tags,1)
 }finally{s.close()}
})
test('lost MOVE response reconciles its committed outcome without replay',async()=>{
 const s=await setup();try{let moves=0;const move=s.api.move.bind(s.api);s.api.move=async(...a)=>{moves++;await move(...a);throw new Error('lost response')};await approve(s);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/lost/);assert.equal(s.w.decision(s.actor,s.result.id).state,'move_intent');const recheck=await s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true});assert.equal(recheck.state,'move_done');const done=await s.w.apply(s.actor,s.api,s.result.id);assert.equal(done.state,'done');assert.equal(moves,1)}finally{s.close()}
})
test('unconfirmed MOVE and tag requests are not blindly resent',async()=>{
 const s=await setup();try{let moves=0;s.api.move=async()=>{moves++;throw new Error('request outcome unknown')};await approve(s);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id));const result=await s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true});assert.equal(result.uncertain,true);assert.equal(moves,1)}finally{s.close()}
})
test('a lost committed tag response reconciles without another tag request',async()=>{
 const s=await setup();try{let tags=0;const add=s.api.addTags.bind(s.api);s.api.addTags=async(...a)=>{tags++;await add(...a);throw new Error('lost tag response')};await approve(s);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id));assert.equal((await s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true})).state,'done');assert.equal(tags,1)}finally{s.close()}
})
test('stale source, stale digest and other-account decisions cannot authorize a mutation',async()=>{
 const s=await setup();try{await assert.rejects(s.w.approve(s.actor,s.api,s.result.id,defaultPolicy(),'wrong'),/changed/);assert.throws(()=>s.w.job({...s.actor,account:'someone-else'},s.result.id),/not found/);s.j.db.prepare('update demo_files set etag=? where path=?').run('"changed"','Inbox/english.pdf');await assert.rejects(approve(s),/Source changed/);assert.equal(s.w.decision(s.actor,s.result.id),undefined)}finally{s.close()}
})
test('destination collisions are held and never overwritten',async()=>{
 const s=await setup();try{await approve(s);const target=JSON.parse(s.w.decision(s.actor,s.result.id).record).actions.target;await s.api.mkdir(target);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/conflicts/);assert.equal((await s.api.stat(target)).folder,true);assert.ok(await s.api.stat('Inbox/english.pdf'))}finally{s.close()}
})
test('manual tag removal after completion is held without silently reapplying',async()=>{
 const s=await setup();try{await approve(s);const done=await s.w.apply(s.actor,s.api,s.result.id);s.j.db.prepare('update demo_files set tags=? where path=?').run('[]',done.target);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/conflicts/);assert.deepEqual((await s.api.stat(done.target)).tags,[])}finally{s.close()}
})
test('a conflicted filed document is located by resource identity before a fresh review, without changing the old decision',async()=>{
 const s=await setup();try{
  await approve(s);const done=await s.w.apply(s.actor,s.api,s.result.id)
  s.j.db.prepare('update demo_files set tags=? where path=?').run('[]',done.target)
  await assert.rejects(s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true}),/conflicts/)
  const current=await s.w.location(s.actor,s.api,s.result.id);assert.equal(current.path,done.target);assert.equal(current.resourceId,s.result.review.bundle.source.resourceId)
  const input=JSON.parse(s.w.job(s.actor,s.result.id).input)
  for(let n=0;n<205;n++)s.j.db.prepare('insert into proposals(id,scope,input,configuration,state,updated) values(?,?,?,?,?,?)').run(createHash('sha256').update('later-'+n).digest('hex'),s.w.scope(s.actor),JSON.stringify({...input,source:{...input.source,resourceId:'later-'+n}}),'{}','pending','2099-01-01T00:00:00.000Z')
  assert.equal(s.w.jobs(s.actor).some(job=>job.id===s.result.id),false)
  const original=s.j.prepare.bind(s.j);s.j.prepare=(input,configuration,options)=>original(input,configuration,{...options,planner:async value=>validateBundle({...value,proposal:s.result.review.bundle.proposal})})
  const fresh=await s.w.prepare(s.actor,s.api,current.path,config,{newReview:true});assert.notEqual(fresh.id,s.result.id);assert.equal(s.w.decision(s.actor,s.result.id).state,'conflict');assert.equal(s.w.decision(s.actor,fresh.id),undefined)
  await assert.rejects(s.w.location({...s.actor,account:'other'},s.api,s.result.id),/not found/)
  s.j.db.prepare('update demo_files set resourceId=? where path=?').run('different-file',done.target)
  await assert.rejects(s.w.location(s.actor,s.api,s.result.id),/could not be located/)
 }finally{s.close()}
})
test('decisions and activity survive reopen and remain account scoped and append-only',async()=>{
 const s=await setup();try{await approve(s);s.w.savePreference(s.actor,{policy:defaultPolicy(),ai:defaultAIConfig()});assert.equal(s.w.history({...s.actor,account:'other'}).length,0);assert.throws(()=>s.j.db.exec("delete from activity"),/append-only/);s.j.close();s.j=new ProposalJournal(s.path);s.w=new Workflow(s.j);assert.equal(s.w.decision(s.actor,s.result.id).state,'approved');assert.equal(s.w.history(s.actor).length,2)}finally{s.close()}
})
test('concurrent decisions cannot replace an approval already recorded by another request',async()=>{
 const s=await setup();try{const results=await Promise.allSettled([approve(s),approve(s,{...defaultPolicy(),rename:'off'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(s.w.decision(s.actor,s.result.id).state,'approved')}finally{s.close()}
})
test('an explicit new review after rejection preserves the old decision and requires a new approval',async()=>{
 const s=await setup();try{s.w.reject(s.actor,s.result.id);const original=s.j.prepare.bind(s.j);s.j.prepare=(i,c,o)=>original(i,c,{...o,planner:async value=>validateBundle({...value,proposal:s.result.review.bundle.proposal})});const fresh=await s.w.prepare(s.actor,s.api,'Inbox/english.pdf',config,{newReview:true});assert.notEqual(fresh.id,s.result.id);assert.equal(s.w.decision(s.actor,s.result.id).state,'rejected');await assert.rejects(s.w.apply(s.actor,s.api,fresh.id),/approval/)}finally{s.close()}
})
test('a human-adjusted filename, folder and additional tags are bound to approval and survive restart',async()=>{
 const s=await setup();try{const manual={target:'Archive/Household/2026-10-29 TEST-42.pdf',addTags:['Household','Paid']},policy=defaultPolicy();await assert.rejects(s.w.approve(s.actor,s.api,s.result.id,policy,await reviewDigest(s.result.review,policy),manual),/changed/);await s.w.approve(s.actor,s.api,s.result.id,policy,await reviewDigest(s.result.review,policy,manual),manual);const result=await s.w.apply(s.actor,s.api,s.result.id);assert.equal(result.target,manual.target);assert.ok(result.tags.includes('Household'));assert.ok(result.tags.includes('Keep existing'));s.j.close();s.j=new ProposalJournal(s.path);s.w=new Workflow(s.j);s.api=new DemoAdapter(s.j.db);assert.equal((await s.w.apply(s.actor,s.api,s.result.id)).state,'done')}finally{s.close()}
})
test('tampering stored actions cannot reuse an otherwise matching approval digest',async()=>{const s=await setup();try{await approve(s);const record=JSON.parse(s.w.decision(s.actor,s.result.id).record);record.actions.target='Filed/unapproved.pdf';s.j.db.prepare('update decisions set record=? where job=?').run(JSON.stringify(record),s.result.id);await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/no longer matches/);assert.ok(await s.api.stat('Inbox/english.pdf'))}finally{s.close()}})
test('unconfirmed metadata holds filing before any folder, MOVE or tag write and can be read-only reconciled',async()=>{
 const s=await setup();try{
  const {Metadata}=await import('../../companion/metadata.mjs'),metadata=new Metadata(s.w);metadata.saveSchema(s.actor,{fields:[{id:'invoice',label:'Invoice',type:'text',aliases:[],choices:[]}],tags:[]})
  const view=await metadata.get(s.actor,s.api,'Inbox/english.pdf'),reconcile=metadata.reconcile.bind(metadata)
  metadata.reconcile=async()=>{throw new Error('Simulated interruption before field-save verification')}
  await assert.rejects(metadata.save(s.actor,s.api,{path:view.source.path,resourceId:view.source.resourceId,etag:view.source.etag,sha256:view.source.sha256,version:0,fields:{invoice:'TEST-42'},addTags:[]}),/interruption/)
  metadata.reconcile=reconcile;await approve(s)
  let moves=0,tags=0,folders=0;const move=s.api.move.bind(s.api),add=s.api.addTags.bind(s.api),mkdir=s.api.mkdir.bind(s.api)
  s.api.move=async(...a)=>{moves++;return move(...a)};s.api.addTags=async(...a)=>{tags++;return add(...a)};s.api.mkdir=async(...a)=>{folders++;return mkdir(...a)}
  await assert.rejects(s.w.apply(s.actor,s.api,s.result.id),/metadata save needs verification/);assert.equal(s.w.decision(s.actor,s.result.id).state,'approved');assert.equal(moves+tags+folders,0)
  assert.equal((await s.w.apply(s.actor,s.api,s.result.id,{reconcileOnly:true})).state,'approved')
  const pending=(await metadata.get(s.actor,s.api,'Inbox/english.pdf')).pending;assert.equal(pending.length,1);assert.equal((await metadata.reconcile(s.actor,s.api,pending[0].id)).state,'done')
  assert.equal(metadata.read(s.actor,view.source.resourceId).fields.invoice,'TEST-42');assert.equal((await s.w.apply(s.actor,s.api,s.result.id)).state,'done');assert.equal(moves,1);assert.equal(tags,1)
 }finally{s.close()}
})
