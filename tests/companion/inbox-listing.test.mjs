// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inboxFiles} from '../../companion/inbox.mjs'
import {preparationIssue} from '../../companion/processing-issues.mjs'
test('flat inbox includes every nested file and retains paths without exposing folder rows',async()=>{
 const api={list:async path=>path==='Inbox'?[{path:'Inbox/Employment',folder:true},{path:'Inbox/new.pdf',folder:false}]:[{path:path+'/contract.pdf',folder:false},{path:path+'/scan.jpg',folder:false},{path:path+'/source.doc',folder:false}]}
 const files=await inboxFiles(api,{folder:'Inbox',recursive:true});assert.equal(files.length,4);assert.equal(files.some(f=>f.folder),false);assert.ok(files.some(f=>f.path==='Inbox/Employment/scan.jpg'))
 assert.equal((await inboxFiles(api,{folder:'Inbox',recursive:false})).length,1)
})
test('flat listing rejects foreign paths and never follows folders outside the inbox',async()=>{
 const requested=[];await assert.rejects(inboxFiles({list:async path=>{requested.push(path);return[{path:'Private/tax.pdf',folder:false}]}},{folder:'Inbox',recursive:true}),/outside requested folder/);assert.deepEqual(requested,['Inbox'])
})
test('processing diagnoses explain known failures without copying unknown private provider errors',()=>{
 assert.match(preparationIssue(Error('fetch failed')).message,/unavailable/)
 assert.match(preparationIssue(Error('Document exceeds configured model context capacity; increase it in Processing settings or select a model with a larger context')).nextStep,/context/)
 const unknown=preparationIssue(Error('private-token-123 https://private-provider.example/?secret=example'));assert.equal(JSON.stringify(unknown).includes('private-token'),false);assert.equal(JSON.stringify(unknown).includes('private-provider'),false)
})
test('evidence and printed date holds identify the actual issue instead of suggesting an AI connection failure',()=>{
 assert.match(preparationIssue(Error('Fact is not present in its evidence')).message,/verified against the document/)
 assert.match(preparationIssue(Error('Quote is absent from its page')).nextStep,/cited text/)
 assert.match(preparationIssue(Error('Unsupported printed date format; add an explicit language/date rule')).message,/date needs review/)
})
test('Inbox totals count only listed files, while preserving each current processing outcome',async()=>{
 const {inboxSummary}=await import('../../companion/inbox.mjs')
 const files=[{folder:true},{intakeState:'running',progress:{step:3}},{intakeState:'queued',progress:{step:1}},{reviewState:'needs_details',progress:{step:4}},{reviewState:'needs_review',progress:{step:4}},{intakeState:'prepared',reviewState:'done',progress:{step:5}},{progress:{step:1,attention:true}},{intakeState:'duplicate',progress:{step:2}},{intakeState:'cancelled',progress:{step:3,cancelled:true}},{reviewState:'move_intent',progress:{step:4}}]
 const result=inboxSummary(files);assert.equal(result.total,9);assert.deepEqual([result.waiting,result.running,result.ready,result.completed,result.attention,result.cancelled,result.duplicates],[1,1,2,1,2,1,1]);assert.equal(inboxSummary([]).total,0)
})
