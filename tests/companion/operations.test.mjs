// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ProposalJournal} from '../../companion/journal.mjs'
import {Workflow} from '../../companion/workflow.mjs'
import {Operations} from '../../companion/operations.mjs'
const actor={server:'https://example.org',account:'person',space:'one'}
test('bulk work retains per-document results and cannot be replayed using the same operation ID',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-bulk-')),j=new ProposalJournal(join(dir,'db.sqlite3')),w=new Workflow(j);let calls=0
 const operations=new Operations(w,{prepare:async(_actor,_api,path)=>{calls++;if(path.includes('held'))throw new Error('Source changed');return{id:path,state:'needs_review'}}}),api={identity:async()=>actor},request={id:randomUUID(),kind:'prepare',items:[{path:'Inbox/one.pdf'},{path:'Inbox/held.pdf'},{path:'Inbox/three.pdf'}]}
 try{operations.start(actor,api,request);await operations.active.get(request.id);const result=operations.status(actor,request.id);assert.equal(result.state,'completed');assert.deepEqual(result.items.map(i=>i.state),['done','held','done']);assert.equal(calls,3);operations.start(actor,api,request);operations.launch(actor,api,request.id);await operations.active.get(request.id);assert.equal(calls,3);assert.throws(()=>operations.start(actor,api,{...request,items:[{path:'different.pdf'}]}),/different request/);assert.throws(()=>operations.status({...actor,space:'other'},request.id),/not found/)}finally{await operations.stop();j.close();rmSync(dir,{recursive:true})}
})
test('access expiry holds each remaining item before processing and interrupted items are never blindly retried',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-bulk-recovery-')),path=join(dir,'db.sqlite3'),j=new ProposalJournal(path),w=new Workflow(j);let calls=0
 const operations=new Operations(w,{prepare:async()=>{calls++;return{state:'done'}}}),request={id:randomUUID(),kind:'prepare',items:[{path:'Inbox/one.pdf'},{path:'Inbox/two.pdf'}]}
 try{operations.stopped=true;operations.start(actor,{identity:async()=>actor},request);w.db.prepare("update bulk_items set state='running' where operation=? and position=0").run(request.id);operations.stopped=false;operations.launch(actor,{identity:async()=>({...actor,account:'different'})},request.id);await operations.active.get(request.id);assert.deepEqual(operations.status(actor,request.id).items.map(i=>i.state),['held','held']);assert.equal(calls,0);assert.match(operations.status(actor,request.id).items[0].result.error,/not repeated/)}finally{await operations.stop();j.close();rmSync(dir,{recursive:true})}
})
test('bulk filing verifies each plan, preserves successful files around a collision, and remains non-replaying after reopen',async()=>{
 const {DemoAdapter}=await import('../../companion/demo.mjs'),{Metadata}=await import('../../companion/metadata.mjs'),{samples}=await import('../../src/domain/samples.ts'),{defaultPolicy,reviewDigest,validateBundle}=await import('../../src/domain/review.ts')
 const dir=mkdtempSync(join(tmpdir(),'workflow-bulk-filing-')),path=join(dir,'db.sqlite3'),j=new ProposalJournal(path),w=new Workflow(j),api=new DemoAdapter(j.db),metadata=new Metadata(w);api.seed();const actor=await api.identity(),original=j.db.prepare("select data from demo_files where resourceId='demo-english'").get();j.db.prepare('insert into demo_files values(?,?,?,?,?,?)').run('Inbox/alias.pdf','english-alias','"v1"','[]',0,original.data)
 const policy=defaultPolicy(),configuration={endpoint:'http://127.0.0.1:11434',model:'fixture',policy},prepare=j.prepare.bind(j);j.prepare=(input,config,options)=>prepare(input,config,{...options,planner:async value=>{const proposal=structuredClone(samples()[value.source.resourceId.includes('japanese')?1:0].proposal);proposal.tags=proposal.tags.filter(t=>!['Japanese'].includes(t.value));return validateBundle({...value,proposal})}})
 const operations=new Operations(w,{metadata}),items=[];let moves=0;const move=api.move.bind(api);api.move=async(...args)=>{moves++;return move(...args)}
 try{
  for(const path of ['Inbox/english.pdf','Inbox/alias.pdf','Inbox/japanese.pdf']){const job=await w.prepare(actor,api,path,configuration);items.push({id:job.id,policy,reviewDigest:await reviewDigest(validateBundle(job.bundle),policy)})}
  const id=randomUUID();operations.start(actor,api,{id,kind:'file',items});await operations.active.get(id);assert.deepEqual(operations.status(actor,id).items.map(i=>i.state),['done','held','done']);assert.equal(moves,2);assert.ok(await api.stat('Inbox/alias.pdf'));assert.equal(w.decision(actor,items[1].id).state,'conflict');assert.ok(JSON.parse(w.decision(actor,items[0].id).record).reviewedAt)
  const second=new ProposalJournal(path);try{const restored=new Operations(new Workflow(second),{metadata:new Metadata(new Workflow(second))});restored.launch(actor,{identity:async()=>{assert.fail('Completed/held items must not authenticate or mutate again')}},id);await restored.active.get(id);assert.deepEqual(restored.status(actor,id).items.map(i=>i.state),['done','held','done']);await restored.stop()}finally{second.close()}
 }finally{await operations.stop();j.close();rmSync(dir,{recursive:true})}
})
