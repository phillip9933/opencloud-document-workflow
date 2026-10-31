// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { samples } from '../../src/domain/samples.ts'
import { defaultPolicy, validateBundle } from '../../src/domain/review.ts'
import { ProposalJournal } from '../../companion/journal.mjs'
import { generateProposal, localEndpoint, listModels } from '../../companion/ollama.mjs'
import {defaultFilingRules} from '../../src/domain/filing.ts'
import {suggestMetadata} from '../../src/domain/metadata.ts'
const input=()=>{const {proposal,...b}=samples()[0];return b}
const config={endpoint:'http://127.0.0.1:11434',model:'test-local',policy:defaultPolicy()}
const reply=()=>new Response(JSON.stringify({done:true,message:{content:JSON.stringify(samples()[0].proposal)}}))
function setup(){const dir=mkdtempSync(join(tmpdir(),'workflow-'));const path=join(dir,'jobs.sqlite3');return{dir,path,j:new ProposalJournal(path)}}
test('persists completed proposals across process objects without replay',async()=>{
 const s=setup();let calls=0
 try{const planner=async()=>{calls++;return validateBundle(samples()[0])};const a=await s.j.prepare(input(),config,{planner});s.j.close();s.j=new ProposalJournal(s.path);const b=await s.j.prepare(input(),config,{planner});assert.equal(b.cached,true);assert.equal(a.id,b.id);assert.equal(calls,1)}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('scopes jobs by account, Space, resource, ETag, bytes and input text',async()=>{
 const s=setup();try{const ids=new Set();const planner=async i=>validateBundle({...i,proposal:samples()[0].proposal});ids.add((await s.j.prepare(input(),config,{planner})).id)
 for(const key of ['account','space','resourceId','etag','sha256']){const i=input();i.source[key]=key==='sha256'?'d'.repeat(64):'other';ids.add((await s.j.prepare(i,config,{planner})).id)}
 assert.equal(ids.size,6)
 }finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('holds image-only pages without a model call',async()=>{
 const s=setup();try{const {proposal,...i}=samples()[2];const r=await s.j.prepare(i,config,{planner:()=>{throw new Error('must not call')}});assert.equal(r.review.state,'needs_ocr')}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('failures require an explicit retry for every further attempt and never trigger fallback',async()=>{
 const s=setup();let calls=0;try{const planner=async()=>{calls++;throw new Error('offline')};await assert.rejects(s.j.prepare(input(),config,{planner}));await assert.rejects(s.j.prepare(input(),config,{planner}),/explicit retry/);for(let n=0;n<2;n++)await assert.rejects(s.j.prepare(input(),config,{planner,retry:true}));await assert.rejects(s.j.prepare(input(),config,{planner,retry:true}),/offline/);assert.equal(calls,4)}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('does not steal a running request or repeat a concurrent request',async()=>{
 const s=setup();let release;try{const pending=s.j.prepare(input(),config,{planner:()=>new Promise(r=>{release=r})});await assert.rejects(s.j.prepare(input(),config,{retry:true}),/still running/);release(validateBundle(samples()[0]));await pending}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('rejects unsupported evidence and enforces AI Off switches',async()=>{
 const s=setup();try{await assert.rejects(s.j.prepare(input(),{...config,policy:{...defaultPolicy(),aiInput:'off'}}),/enabled/)
 const b=samples()[0];b.proposal.issuer.value='Invented city';await assert.rejects(s.j.prepare(input(),config,{planner:async()=>({bundle:b})}),/Fact/)}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
test('adapter uses structured output, no redirects, and validates actual quotes',async()=>{
 let payload;const r=await generateProposal(input(),'test-local',config.endpoint,async(url,options)=>{if(url.endsWith('/api/tags'))return new Response(JSON.stringify({models:[{name:'test-local'}]}));assert.match(url,/\/api\/chat$/);assert.equal(options.redirect,'error');payload=JSON.parse(options.body);return reply()});assert.equal(payload.stream,false);assert.equal(payload.think,false);assert.equal(payload.format.additionalProperties,false);assert.equal(r.state,'needs_review');assert.equal(r.excluded[0].value,'Japanese')
})
test('zero AI tags use valid empty-array structured output while independent metadata aliases still work',async()=>{
 const i=input(),rules=defaultFilingRules(),proposal=structuredClone(samples()[0].proposal);rules.tags=[];i.rules=rules;i.pages[0]+='\nName: Example';proposal.tags=[];let format
 const emptyEnum=value=>!!value&&typeof value==='object'&&(Array.isArray(value.enum)&&value.enum.length===0||Object.values(value).some(emptyEnum))
 const result=await generateProposal(i,'test-local',config.endpoint,async(url,options)=>{if(url.endsWith('/api/tags'))return Response.json({models:[{name:'test-local'}]});format=JSON.parse(options.body).format;if(emptyEnum(format))return Response.json({error:'enum must contain at least one value'},{status:400});return Response.json({done:true,message:{content:JSON.stringify(proposal)}})})
 assert.equal(format.properties.tags.maxItems,0);assert.equal(Object.hasOwn(format.properties.tags.items.properties.value,'enum'),false);assert.equal(result.state,'needs_review');assert.deepEqual(result.proposal.tags,[])
 assert.deepEqual(suggestMetadata({fields:[],tags:[{tag:'Person: Example',terms:['Example'],match:'name'}]},i.pages).tags.map(tag=>tag.value),['Person: Example'])
 assert.throws(()=>validateBundle({...i,proposal:{...proposal,tags:[{value:'Synthetic',evidence:[{page:1,quote:'SYNTHETIC DOCUMENT'}]}]}}),/Invalid tag proposals/)
})
test('restricts endpoints and local models, and rejects incomplete responses',async()=>{
 for(const u of ['https://hosted.example','http://169.254.169.254','http://192.168.1.2?key=secret','http://user:pass@localhost'])assert.throws(()=>localEndpoint(u))
 await assert.rejects(generateProposal(input(),'example:cloud',config.endpoint),/model/)
 await assert.rejects(generateProposal(input(),'test',config.endpoint,async url=>new Response(JSON.stringify(url.endsWith('/api/tags')?{models:[{name:'test'}]}:{done:false,message:{content:'{}'}}))),/Incomplete/)
 const models=await listModels(config.endpoint,async()=>new Response(JSON.stringify({models:[{name:'local'},{name:'remote:cloud'},{name:'alias',remote_host:'cloud.example'}]})))
 assert.deepEqual(models.map(m=>m.name),['local'])
})
test('refuses a provider result that changes scope or extracted evidence',async()=>{
 const s=setup();try{const changed=samples()[0];changed.source.account='other';await assert.rejects(s.j.prepare(input(),config,{planner:async()=>validateBundle(changed)}),/changed source/)}finally{s.j.close();rmSync(s.dir,{recursive:true})}
})
