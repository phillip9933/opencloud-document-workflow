// SPDX-License-Identifier: AGPL-3.0-only
import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path'
import{ProposalJournal}from'../../companion/journal.mjs';import{Workflow}from'../../companion/workflow.mjs';import{samples}from'../../src/domain/samples.ts';import{defaultPolicy}from'../../src/domain/review.ts'
test('manual-review diagnostics retain verified facts without exposing raw AI or changing the recorded review',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'preparation-diagnostics-')),j=new ProposalJournal(join(dir,'test.sqlite3')),w=new Workflow(j),bundle=samples()[0],{proposal,...input}=bundle,actor={server:input.source.server,account:input.source.account,space:input.source.space},raw=structuredClone(proposal);raw.date.value='2099-12-31'
 try{
  const prepared=await j.prepare(input,{endpoint:'http://127.0.0.1:11434',model:'test',policy:defaultPolicy()},{manualFallback:true,planner:async(_input,_model,_endpoint,_fetch,onResponse)=>{onResponse({route:{provider:'local'},proposal:raw});throw Error('Fact is not present in its evidence')}})
  const before=j.get(prepared.id),view=w.jobView(actor,prepared.id)
  assert.equal(view.bundle.proposal,null);assert.equal(view.preparationReview.verified.issuer.value,proposal.issuer.value);assert.equal(view.preparationReview.verified.date,undefined);assert.deepEqual(view.preparationReview.issues,[{field:'date',code:'literal'}]);assert.equal(view.raw,undefined);assert.equal(JSON.stringify(j.get(prepared.id)),JSON.stringify(before));assert.throws(()=>w.jobView({...actor,account:'another-person'},prepared.id),/not found/)
 }finally{j.close();rmSync(dir,{recursive:true,force:true})}
})
