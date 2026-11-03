// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDraftAPI} from '../../companion/draft-api.mjs'
import {defaultAIConfig} from '../../src/domain/ai.ts'
import {defaultPolicy,validateBundle,reviewDigest} from '../../src/domain/review.ts'
async function call(api,operation,body={},headers={}){
 let status,data
 const req={url:`/_workflow/api/${operation}`,method:'POST',headers:{host:'127.0.0.1:5175',origin:'http://127.0.0.1:5175',...headers},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body))}}
 await api.handle(req,{writeHead:s=>{status=s},end:value=>{try{data=JSON.parse(value)}catch{data=value}}})
 return{status,data}
}
test('a fresh device resolves only its authenticated workflow and rechecks Space access',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-fresh-device-')),database=join(dir,'db.sqlite3'),origin='https://opencloud.example',verified=[]
 let owner='alex',denied=false
 const api=createDraftAPI({database,mode:'live',origin,allowOrigin:'http://127.0.0.1:5175',adapterFactory:options=>({
  async accountIdentity(){if(options.token!=='valid')throw Object.assign(new Error('expired'),{status:401});return{server:origin,account:owner}},
  async identity(){if(options.token!=='valid')throw Object.assign(new Error('expired'),{status:401});verified.push(options.space);if(denied)throw Object.assign(new Error('denied'),{status:403});return{server:origin,account:owner,space:options.space,mode:'live'}},
  async spaces(){return[{id:'personal',type:'personal'}]}
 })})
 try{
  const db=new DatabaseSync(database),put=db.prepare('insert into intake_settings(scope,value) values(?,?)')
  put.run(JSON.stringify([origin,'alex','documents']),JSON.stringify({folder:'Inbox',enabled:false}));put.run(JSON.stringify([origin,'someone-else','private-space']),JSON.stringify({folder:'Secret',enabled:true}));db.close()
  const first=await call(api,'status',{}, {authorization:'Bearer valid'});assert.equal(first.status,200);assert.equal(first.data.actor.space,'documents');assert.deepEqual(verified,['documents'])
  // Explicit verified selection becomes the cross-device default; no browser
  // storage and no fixed WORKFLOW_SPACE_ID are required.
  assert.equal((await call(api,'status',{}, {authorization:'Bearer valid','x-workflow-space':'other-authorized'})).status,200)
  assert.equal((await call(api,'status',{}, {authorization:'Bearer valid'})).data.actor.space,'other-authorized')
  denied=true;assert.equal((await call(api,'status',{}, {authorization:'Bearer valid'})).status,403);denied=false
  owner='new-user';assert.equal((await call(api,'status',{}, {authorization:'Bearer valid'})).data.actor.space,'personal')
  assert.equal((await call(api,'status',{}, {authorization:'Bearer expired'})).status,401)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('processing controls persist pause and resume independently of intake settings and reject unknown commands',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-queue-api-')),database=join(dir,'db.sqlite3');let api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
 try{
  assert.equal((await call(api,'intake-control',{action:'pause'})).data.paused,true)
  assert.equal((await call(api,'intake')).data.configuration.enabled,false)
  api.close();api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
  assert.equal((await call(api,'intake')).data.paused,true)
  assert.equal((await call(api,'intake-control',{action:'resume'})).data.paused,false)
  assert.equal((await call(api,'intake-control',{action:'retry'})).data.affected,0)
  assert.notEqual((await call(api,'intake-control',{action:'delete'})).status,200)
  assert.notEqual((await call(api,'intake-control',{action:'cancel',ids:[]})).status,200)
  assert.equal((await call(api,'intake',{},{'X-Workflow-Space':'local-archive'})).data.paused,false)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('durable API preferences and jobs are restored, and secret-shaped config fields are refused',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-api-')),database=join(dir,'db.sqlite3');let api=createDraftAPI({database,mode:'demo',ollama:'http://127.0.0.1:11434',allowOrigin:'http://127.0.0.1:5175'})
 try{assert.equal((await call(api,'status')).data.actor.mode,'demo');assert.equal((await call(api,'files',{path:'Inbox'})).data.files.length,3)
 const configuration={policy:defaultPolicy(),ai:defaultAIConfig()};configuration.ai.local.model='test-model'
 assert.equal((await call(api,'preferences',{configuration})).status,200)
 api.close();api=createDraftAPI({database,mode:'demo',ollama:'http://127.0.0.1:11434',allowOrigin:'http://127.0.0.1:5175'})
 assert.equal((await call(api,'status')).data.preferences.ai.local.model,'test-model')
 configuration.ai.local.apiKey='must-never-be-stored';assert.equal((await call(api,'preferences',{configuration})).status,409)
 assert.equal(readFileSync(database).includes(Buffer.from('must-never-be-stored')),false)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('live API requires fresh server-verified session identity and does not store its bearer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-auth-'));let seen=[]
 const api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'live',origin:'https://opencloud.example',space:'isolated-space',allowOrigin:'http://127.0.0.1:5175',adapterFactory:options=>({async identity(){seen.push(options.token);if(options.token!=='valid-test-session')throw Object.assign(new Error('denied'),{status:401});return{server:options.origin,space:options.space,account:'verified-account',mode:'live'}}})})
 try{assert.equal((await call(api,'status')).status,401)
 const r=await call(api,'status',{account:'forged-account'},{authorization:'Bearer valid-test-session'});assert.equal(r.data.actor.account,'verified-account')
 assert.equal((await call(api,'activity',{}, {authorization:'Bearer expired-session'})).status,401)
 assert.equal((await call(api,'apply',{id:'unknown'},{authorization:'Bearer valid-test-session'})).status,404)
 assert.deepEqual(seen,['valid-test-session','expired-session','valid-test-session'])
 assert.equal(readFileSync(join(dir,'db.sqlite3')).includes(Buffer.from('valid-test-session')),false)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('draft API rejects cross-origin requests before authentication or any adapter operation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-csrf-'));let calls=0
 const api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'live',origin:'https://opencloud.example',space:'isolated-space',allowOrigin:'http://127.0.0.1:5175',adapterFactory:()=>{calls++;throw new Error('must not execute')}})
 try{assert.equal((await call(api,'status',{}, {origin:'https://evil.example',authorization:'Bearer test'})).status,403);assert.equal(calls,0)}finally{api.close();rmSync(dir,{recursive:true})}
})
test('custom schema and OCR language preferences survive restart while synthetic arrivals remain demo-only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-options-')),database=join(dir,'db.sqlite3');let api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'});try{const schema={fields:[{id:'invoice',label:'Invoice',type:'text',aliases:['Invoice number'],choices:[]}],tags:[{tag:'Household',terms:['Electricity']}]};assert.equal((await call(api,'metadata-schema-save',{schema})).status,200);assert.equal((await call(api,'ocr-settings',{languages:['eng']})).status,200);assert.equal((await call(api,'demo-add-scan')).status,200);api.close();api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'});assert.deepEqual((await call(api,'metadata-schema')).data,schema);assert.deepEqual((await call(api,'status')).data.ocrLanguages,['eng']);assert.equal((await call(api,'files',{path:'Inbox'})).data.files.length,4);assert.equal((await call(api,'ocr-settings',{languages:['not_installed']})).status,409)}finally{api.close();rmSync(dir,{recursive:true})}
})
test('cloud-only configuration requires per-preparation consent and never journals the provider key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-cloud-consent-')),database=join(dir,'db.sqlite3'),key='fixture-provider-secret-not-real',api=createDraftAPI({database,mode:'demo',cloud:'https://provider.example/v1',cloudKey:key,allowOrigin:'http://127.0.0.1:5175'});const original=globalThis.fetch;let calls=0
 try{const ai=defaultAIConfig();ai.cloud={endpoint:'https://provider.example/v1',model:'mock-model'};ai.tasks={facts:'cloud',filing:'cloud',tags:'cloud'};assert.equal((await call(api,'preferences',{configuration:{policy:defaultPolicy(),ai}})).status,200)
 const {samples}=await import('../../src/domain/samples.ts');const proposal=samples()[0].proposal
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://provider.example/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+key);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(proposal)}}]})}
 assert.equal((await call(api,'prepare',{path:'Inbox/english.pdf'})).status,409);assert.equal(calls,0)
 const prepared=await call(api,'prepare',{path:'Inbox/english.pdf',cloudConsent:true});assert.equal(prepared.status,200);assert.equal(calls,1)
 const id=prepared.data.id,policy=defaultPolicy(),review=validateBundle(prepared.data.bundle)
 assert.equal((await call(api,'approve',{id,policy,reviewDigest:await reviewDigest(review,policy)})).status,200)
 const filed=await call(api,'apply',{id});assert.equal(filed.data.state,'done')
 const library=await call(api,'documents',{search:'Example'});assert.equal(library.status,200);assert.equal(library.data.documents[0].id,id);assert.equal(library.data.documents[0].path,filed.data.target)
 assert.equal((await call(api,'status',{activeOnly:true})).data.jobs.length,0);assert.equal((await call(api,'status')).data.jobs.length,1)
 assert.equal((await call(api,'job',{id})).data.job.id,id);assert.equal((await call(api,'job',{id:'unknown'})).status,404)
 assert.equal((await call(api,'document-location',{id})).data.path,filed.data.target)
 const verified=await call(api,'reconcile',{id});assert.equal(verified.data.verification.resourceId,review.bundle.source.resourceId);assert.equal(verified.data.verification.sha256,review.bundle.source.sha256)
 const db=(await import('node:sqlite')).DatabaseSync;const inspect=new db(database);assert.equal(JSON.stringify(inspect.prepare('select configuration from proposals').all()).includes(key),false);assert.equal(JSON.stringify(inspect.prepare('select configuration from preferences').all()).includes(key),false);inspect.close()
 }finally{globalThis.fetch=original;await api.stop();rmSync(dir,{recursive:true})}
})
test('inbox setup verifies the folder and processing readiness, and AI Off atomically pauses ingestion',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-setup-')),api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'demo',ollama:'http://127.0.0.1:11434',allowOrigin:'http://127.0.0.1:5175'})
 const configuration={enabled:true,folder:'Inbox',recursive:true,intervalSeconds:30,settleSeconds:10,cloudConsent:false},preferences={policy:defaultPolicy(),ai:defaultAIConfig()}
 try{
  assert.equal((await call(api,'intake-settings',{configuration})).status,409);assert.equal((await call(api,'intake')).data.configuration.enabled,false)
  assert.equal((await call(api,'intake-settings',{configuration:{...configuration,enabled:false,folder:'Missing'}})).status,409)
  preferences.ai.tasks.facts='local';preferences.ai.local.model='fixture-model';assert.equal((await call(api,'preferences',{configuration:preferences})).status,200)
  assert.equal((await call(api,'intake-settings',{configuration})).status,200)
  const invalid=structuredClone(preferences);invalid.policy.aiInput='invalid';assert.equal((await call(api,'preferences',{configuration:invalid})).status,409);assert.equal((await call(api,'intake')).data.configuration.enabled,true)
  preferences.ai.tasks.facts='off';const off=await call(api,'preferences',{configuration:preferences});assert.equal(off.status,200);assert.equal(off.data.paused,true)
  assert.equal((await call(api,'intake')).data.configuration.enabled,false);assert.equal((await call(api,'status')).data.preferences.ai.tasks.facts,'off');assert.equal((await call(api,'status')).data.atomicPreferencePause,true)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('background cloud routing requires explicit folder consent before ingestion can be enabled',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-setup-cloud-')),api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'demo',cloud:'https://provider.example/v1',cloudKey:'fixture-key',allowOrigin:'http://127.0.0.1:5175'})
 try{const ai=defaultAIConfig();ai.cloud={endpoint:'https://provider.example/v1',model:'fixture'};ai.tasks.facts='cloud';assert.equal((await call(api,'preferences',{configuration:{policy:defaultPolicy(),ai}})).status,200);const configuration={enabled:true,folder:'Inbox',recursive:true,intervalSeconds:30,settleSeconds:10,cloudConsent:false};assert.equal((await call(api,'intake-settings',{configuration})).status,409);assert.equal((await call(api,'intake-settings',{configuration:{...configuration,cloudConsent:true}})).status,200)}finally{api.close();rmSync(dir,{recursive:true})}
})

test('Space selection isolates settings, metadata, history and same-path files across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-spaces-')),database=join(dir,'db.sqlite3');let api=createDraftAPI({database,mode:'demo',ollama:'http://127.0.0.1:11434',allowOrigin:'http://127.0.0.1:5175'})
 try{
  const directory=await call(api,'spaces');assert.deepEqual(directory.data.spaces.map(s=>s.id),['local-draft','local-archive'])
  const h={'x-workflow-space':'local-archive'},configuration={policy:defaultPolicy(),ai:defaultAIConfig()};configuration.ai.local.model='archive-model'
  assert.equal((await call(api,'preferences',{configuration},h)).status,200);assert.equal((await call(api,'status')).data.preferences,null)
  assert.equal((await call(api,'status',{},h)).data.actor.space,'local-archive');assert.equal((await call(api,'files',{path:'Inbox'},h)).data.files.length,3)
  const schema={fields:[{id:'only_archive',label:'Archive',type:'text',aliases:[],choices:[]}],tags:[]};assert.equal((await call(api,'metadata-schema-save',{schema},h)).status,200);assert.deepEqual((await call(api,'metadata-schema')).data.fields,[])
  assert.ok((await call(api,'activity',{},h)).data.events.length>0);assert.equal((await call(api,'activity')).data.events.length,0)
  assert.equal((await call(api,'status',{}, {'x-workflow-space':'unknown'})).status,403);assert.equal((await call(api,'status',{}, {'x-workflow-space':'../bad'})).status,409)
  api.close();api=createDraftAPI({database,mode:'demo',ollama:'http://127.0.0.1:11434',allowOrigin:'http://127.0.0.1:5175'});assert.equal((await call(api,'status',{},h)).data.preferences.ai.local.model,'archive-model');assert.equal((await call(api,'status')).data.preferences,null)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('live Space discovery works without a configured default and still requires its bearer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-directory-')),api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'live',origin:'https://example.org',allowOrigin:'http://127.0.0.1:5175',adapterFactory:options=>({spaces:async()=>{assert.equal(options.token,'directory-session');return[{id:'accessible',name:'Work',type:'project'}]}})})
 try{assert.equal((await call(api,'spaces')).status,401);const result=await call(api,'spaces',{}, {authorization:'Bearer directory-session'});assert.equal(result.status,200);assert.equal(result.data.spaces[0].id,'accessible')}finally{api.close();rmSync(dir,{recursive:true})}
})
test('background account access verifies other enabled Spaces even if the old default root was revoked',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{defaultIntake}=await import('../../companion/intake.mjs'),dir=mkdtempSync(join(tmpdir(),'workflow-background-spaces-')),database=join(dir,'db.sqlite3'),origin='https://example.org',actor={server:origin,account:'verified-owner',space:'old-default',mode:'live'}
 const api=createDraftAPI({database,mode:'live',origin,space:'old-default',allowOrigin:'http://127.0.0.1:5175'})
 const db=new DatabaseSync(database);db.prepare('insert into intake_settings(scope,value) values(?,?)').run(JSON.stringify([origin,actor.account,'other-enabled']),JSON.stringify({...defaultIntake(),enabled:true}));db.close()
 let roots=0,listings=0
 const accountAdapter={accountIdentity:async()=>actor,identity:async()=>{throw Object.assign(new Error('revoked old root'),{status:403})},forSpace:space=>({identity:async()=>{roots++;assert.equal(space,'other-enabled');return{...actor,space}},list:async()=>{listings++;return[]}})}
 try{await api.attach(accountAdapter,{account:actor.account});assert.equal(roots,1);await api.start();const deadline=Date.now()+2500;while(!listings&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(listings>0);assert.ok(roots>=2);await api.detach(accountAdapter)}finally{await api.stop();rmSync(dir,{recursive:true})}
})
test('inbox configuration is explicit and scoped file review lookup includes older jobs without hiding replaced uploads',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{samples}=await import('../../src/domain/samples.ts'),dir=mkdtempSync(join(tmpdir(),'workflow-inbox-ui-')),database=join(dir,'db.sqlite3'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
 try{
  const actor=(await call(api,'status')).data.actor;assert.equal((await call(api,'intake')).data.configured,false)
  assert.equal((await call(api,'intake-settings',{configuration:{enabled:false,folder:'Inbox',recursive:true,intervalSeconds:30,settleSeconds:10,cloudConsent:false}})).status,200);assert.equal((await call(api,'intake')).data.configured,true)
  assert.equal((await call(api,'intake',{}, {'x-workflow-space':'local-archive'})).data.configured,false)
  const db=new DatabaseSync(database),scope=JSON.stringify([actor.server,actor.account,actor.space]),bundle=samples()[0];bundle.source={...bundle.source,server:actor.server,account:actor.account,space:actor.space,path:'Inbox/english.pdf',resourceId:'demo-english',etag:'"v1"'}
  function insert(id,resource,updated,owner=scope){const value=structuredClone(bundle);value.source.resourceId=resource;const {proposal,...input}=value;db.prepare('insert into proposals(id,scope,input,configuration,state,result,updated) values(?,?,?,?,?,?,?)').run(id,owner,JSON.stringify(input),'{}','needs_review',JSON.stringify(value),updated)}
  insert('older-resource-job','demo-english','2020-01-01T00:00:00.000Z');for(let n=0;n<205;n++)insert('filler-'+n,'filler-'+n,'2026-10-31T00:00:00.000Z');insert('other-account','demo-english','2026-10-31T00:01:00.000Z',JSON.stringify([actor.server,'someone-else',actor.space]));
  assert.equal((await call(api,'status',{activeOnly:true})).data.jobs.some(j=>j.id==='older-resource-job'),false)
  let file=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.resourceId==='demo-english');assert.equal(file.reviewJob,'older-resource-job');assert.equal(file.reviewState,'needs_review')
  db.prepare('insert into decisions(job,actor,record,state,updated) values(?,?,?,?,?)').run('older-resource-job',actor.account,'{}','done','2026-10-31T00:00:00.000Z');file=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.resourceId==='demo-english');assert.equal(file.intakeState,'processed')
  db.prepare('update demo_files set etag=? where resourceId=?').run('"replacement"','demo-english');file=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.resourceId==='demo-english');assert.equal(file.reviewJob,null);assert.equal(file.reviewState,null);assert.notEqual(file.intakeState,'processed');db.close()
 }finally{api.close();rmSync(dir,{recursive:true})}
})

test('OCR installation requires current server-verified administrator access and ignores caller-supplied roles',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-ocr-auth-'));let downloads=0;const api=createDraftAPI({database:join(dir,'state','db.sqlite3'),mode:'live',origin:'https://opencloud.example',space:'space',allowOrigin:'http://127.0.0.1:5175',ocrDirectory:join(dir,'packs'),ocrPackOptions:{installed:async()=>['eng'],fetcher:async()=>{downloads++;throw Error('not reached')}},adapterFactory:()=>({identity:async()=>({server:'https://opencloud.example',account:'person',space:'space'}),isAdministrator:async()=>false})});try{const status=await call(api,'ocr-packs',{}, {authorization:'Bearer fixture'});assert.equal(status.status,200);assert.equal(status.data.canManage,false);const install=await call(api,'ocr-pack-install',{code:'fra',admin:true,roles:['Admin']},{authorization:'Bearer fixture'});assert.equal(install.status,403);assert.equal(downloads,0)}finally{await api.stop();rmSync(dir,{recursive:true})}})

test('background app token setup receives only the authenticated owner, never journals the secret and requires same origin',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-token-api-')),secret='synthetic-app-token-never-journaled',seen=[];const api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'demo',allowOrigin:'http://127.0.0.1:5175',backgroundConnect:async(actor,value)=>{seen.push({actor,value});return{configured:true,state:'connected',method:'app_token'}},backgroundDisconnect:async()=>({configured:false})});try{const connected=await call(api,'background-connect',{username:'local-demo',appToken:secret,account:'forged'});assert.equal(connected.status,200);assert.equal(seen[0].actor.account,'local-demo');assert.equal(seen[0].value.appToken,secret);const history=await call(api,'activity');assert.equal(JSON.stringify(history).includes(secret),false);assert.equal(readFileSync(join(dir,'db.sqlite3')).includes(Buffer.from(secret)),false);assert.equal((await call(api,'background-connect',{username:'local-demo',appToken:secret},{origin:'https://foreign.example'})).status,403);assert.equal(seen.length,1);assert.equal((await call(api,'background-disconnect')).status,200)}finally{await api.stop();rmSync(dir,{recursive:true})}})

test('instance backup settings require a current administrator and hide destinations from ordinary users',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-backup-admin-'));let admin=false,writes=0;const actor={server:'https://opencloud.example',account:'person',space:'space'},settings={enabled:true,intervalMinutes:60,maxSnapshots:10,maxMiB:20,destination:{...actor,folder:'private'}};const api=createDraftAPI({database:join(dir,'db.sqlite3'),mode:'live',origin:actor.server,space:actor.space,allowOrigin:'http://127.0.0.1:5175',adapterFactory:()=>({identity:async()=>actor,isAdministrator:async()=>admin}),backupStatus:()=>({configured:true,state:'ready',settings}),backupDetails:async()=>({configured:true,state:'ready',settings,storage:{count:2,bytes:20}}),backupConfigure:async value=>{writes++;return{settings:value}}});try{const h={authorization:'Bearer fixture'},normal=await call(api,'reliability',{},h);assert.equal(normal.data.backups.settings,undefined);assert.equal((await call(api,'backup-settings-save',{settings,admin:true},h)).status,403);assert.equal(writes,0);admin=true;assert.equal((await call(api,'reliability',{},h)).data.backups.settings.destination.folder,'private');assert.equal((await call(api,'backup-settings-save',{settings},h)).status,200);assert.equal(writes,1);assert.equal((await call(api,'backup-settings-save',{settings},{...h,origin:'https://foreign.example'})).status,403)}finally{await api.stop();rmSync(dir,{recursive:true})}})

test('retry monitoring returns only the authenticated Space item and rejects missing or invalid IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-retry-api-')),database=join(dir,'db.sqlite3'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
 try{
  const actor=(await call(api,'status')).data.actor,db=new DatabaseSync(database),scope=JSON.stringify([actor.server,actor.account,actor.space])
  db.prepare("insert into intake_queue(id,scope,resource,path,etag,first_seen,state,job) values(?,?,?,?,?,?,'queued',?)").run('own-item',scope,'resource','Inbox/scan.pdf','v1',1,null);db.close()
  const r=await call(api,'intake-item',{id:'own-item'});assert.equal(r.status,200);assert.deepEqual(r.data,{state:'queued',job:null,source:{resourceId:'resource',etag:'v1'},processingIssue:null})
  assert.equal((await call(api,'intake-item',{id:'own-item'},{'x-workflow-space':'local-archive'})).status,404)
  assert.equal((await call(api,'intake-item',{id:'missing'})).status,404)
  assert.equal((await call(api,'intake-item',{})).status,409)
  assert.equal((await call(api,'intake-item',{id:'x'.repeat(129)})).status,409)
 }finally{api.close();rmSync(dir,{recursive:true})}
})
test('Inbox reports a fresh preparation batch instead of an older ready review, and Activity counts its controls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-fresh-batch-api-')),database=join(dir,'db.sqlite3'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'});let db
 try{const actor=(await call(api,'status')).data.actor,scope=JSON.stringify([actor.server,actor.account,actor.space]),file=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.path==='Inbox/english.pdf'),input={schemaVersion:1,source:{server:actor.server,account:actor.account,space:actor.space,resourceId:file.resourceId,path:file.path,etag:file.etag,sha256:'a'.repeat(64)},pages:['Synthetic prior scan']},id='00000000-0000-4000-8000-000000000017';db=new DatabaseSync(database);db.prepare('insert into proposals(id,scope,input,configuration,state,result,updated) values(?,?,?,?,?,?,?)').run('older-review',scope,JSON.stringify(input),'{}','needs_details',JSON.stringify({...input,proposal:null,manualReview:{reason:'evidence'}}),'2026-11-01');db.prepare('insert into bulk_operations values(?,?,?,?,?,?,?)').run(id,scope,'prepare','fixture','paused','2026-11-02','2026-11-02');db.prepare('insert into bulk_items values(?,?,?,?,?)').run(id,0,JSON.stringify({path:file.path,resourceId:file.resourceId,etag:file.etag,newReview:true}),'queued',null)
 let result=(await call(api,'files',{path:'Inbox',flattenInbox:true})).data;let current=result.files.find(f=>f.resourceId===file.resourceId);assert.equal(current.reviewState,'needs_details');assert.equal(current.intakeState,'queued');assert.equal(current.progress.label,'Waiting to prepare');assert.equal(result.summary.waiting,3);assert.equal(result.summary.ready,0);assert.deepEqual((await call(api,'intake')).data.bulkPreparation,{waiting:1,running:0,retryable:0,cancellable:1})
 db.prepare("update bulk_items set state='running',result=? where operation=?").run(JSON.stringify({stage:'ocr'}),id);db.prepare("update bulk_operations set state='running' where id=?").run(id);result=(await call(api,'files',{path:'Inbox',flattenInbox:true})).data;current=result.files.find(f=>f.resourceId===file.resourceId);assert.equal(current.intakeState,'running');assert.equal(current.progress.label,'Reading scanned pages');assert.equal(result.summary.running,1)
 db.prepare("update bulk_items set state='held',result=? where operation=?").run(JSON.stringify({stage:'analysing',error:'fetch failed',finishedAt:'2026-11-02T00:00:00Z'}),id);db.prepare("update bulk_operations set state='completed',updated='2026-11-02T00:00:00Z' where id=?").run(id);current=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.resourceId===file.resourceId);assert.equal(current.intakeState,'failed');assert.equal(current.progress.step,3);assert.equal(current.progress.attention,true);assert.match((await call(api,'metadata',{path:file.path})).data.processingIssue.message,/unavailable or busy/)
 db.prepare("update bulk_items set state='queued',result=NULL where operation=?").run(id);db.prepare("update bulk_operations set state='paused' where id=?").run(id);assert.equal((await call(api,'metadata',{path:file.path})).data.processingIssue,null)
 db.prepare("update bulk_items set state='held',result=? where operation=?").run(JSON.stringify({stage:'analysing',error:'fetch failed',finishedAt:'2026-11-02T00:00:00Z'}),id);db.prepare("update proposals set updated='2026-11-03T00:00:00Z' where id='older-review'").run();assert.equal((await call(api,'metadata',{path:file.path})).data.processingIssue,null);assert.notEqual((await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.resourceId===file.resourceId).intakeState,'failed')
 db.prepare("update bulk_items set state='queued',result=NULL where operation=?").run(id);db.prepare("update bulk_operations set state='paused' where id=?").run(id);assert.equal((await call(api,'intake-control',{action:'cancel'})).data.affected,1);assert.equal((await call(api,'intake')).data.bulkPreparation.waiting,0);assert.equal((await call(api,'files',{path:'Inbox'})).data.files.some(f=>f.resourceId===file.resourceId),true)
 }finally{db?.close();api.close();rmSync(dir,{recursive:true})}
})

test('native-file review and recoverable Trash are authenticated explicit operations, independent of AI setup',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-native-api-')),database=join(dir,'db.sqlite3'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'});try{const db=new DatabaseSync(database);db.prepare('insert into demo_files values(?,?,?,?,?,?)').run('Inbox/fixture.dwg','native-api','"v1"','[]',0,Buffer.from('SYNTHETIC CAD'));db.close();const metadata=await call(api,'metadata',{path:'Inbox/fixture.dwg'});assert.equal(metadata.status,200);assert.equal(metadata.data.processingIssue,null);const source=metadata.data.source,review=await call(api,'prepare-original',{path:source.path,resourceId:source.resourceId,etag:source.etag});assert.equal(review.status,200);assert.equal(review.data.bundle.manualReview.reason,'original');assert.deepEqual(review.data.bundle.pages,[]);assert.equal((await call(api,'document-trash-pending')).data.operations.length,0);const id='8f9723c3-455c-4059-815d-2667add521fd',result=await call(api,'document-trash',{id,job:review.data.id,path:source.path,documentSpace:review.data.bundle.source.space,resourceId:source.resourceId,etag:source.etag,sha256:source.sha256});assert.equal(result.status,200);assert.equal(result.data.state,'trashed');assert.equal((await call(api,'document-trash-verify',{id})).data.state,'trashed');assert.equal((await call(api,'files',{path:'Inbox'})).data.files.some(file=>file.resourceId===source.resourceId),false);assert.equal((await call(api,'job',{id:review.data.id})).data.job.decision,null)}finally{api.close();rmSync(dir,{recursive:true})}})
test('browser requests cannot replace the verified background adapter used for a manual Inbox check',async()=>{const {defaultIntake}=await import('../../companion/intake.mjs'),dir=mkdtempSync(join(tmpdir(),'workflow-background-priority-')),origin='https://fixture.example',actor={server:origin,account:'owner',space:'source',mode:'live'};let backgroundLists=0,browserLists=0;const browser={identity:async()=>actor,list:async()=>{browserLists++;return[]}},background={identity:async()=>actor,accountIdentity:async()=>actor,list:async()=>{backgroundLists++;return[]}};const api=createDraftAPI({database:join(dir,'db'),mode:'live',origin,space:actor.space,allowOrigin:'http://127.0.0.1:5175',adapterFactory:()=>browser});try{await api.attach(background,{account:actor.account});const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(dir,'db'));db.prepare('insert into intake_settings(scope,value) values(?,?)').run(JSON.stringify([origin,actor.account,actor.space]),JSON.stringify({...defaultIntake(),enabled:true,intervalSeconds:0,settleSeconds:2}));db.close();assert.equal((await call(api,'status',{}, {authorization:'Bearer synthetic-session'})).status,200);assert.equal((await call(api,'intake-scan',{}, {authorization:'Bearer synthetic-session'})).status,202);await api.start();const deadline=Date.now()+3500;while(!backgroundLists&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(backgroundLists>0);assert.equal(browserLists,0)}finally{await api.stop();rmSync(dir,{recursive:true})}})
test('a refused Trash request explicitly reports that no intent was recorded',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-trash-refusal-')),api=createDraftAPI({database:join(dir,'db'),mode:'demo',allowOrigin:'http://127.0.0.1:5175'});try{const source=(await call(api,'metadata',{path:'Inbox/english.pdf'})).data.source,id='c7caed4a-f04d-41c3-b490-6f5633dd36da',result=await call(api,'document-trash',{id,path:source.path,resourceId:source.resourceId,etag:'wrong',sha256:source.sha256});assert.equal(result.status,409);assert.equal(result.data.trashRecorded,false);assert.equal((await call(api,'document-trash-verify',{id})).data.state,'not_recorded');assert.equal((await call(api,'files',{path:'Inbox'})).data.files.some(f=>f.resourceId===source.resourceId),true)}finally{api.close();rmSync(dir,{recursive:true})}})
test('document processing status rechecks current source access and identity, stays Space-scoped and never fetches file bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-document-status-')),api=createDraftAPI({database:join(dir,'db'),mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
 try{const file=(await call(api,'files',{path:'Inbox'})).data.files.find(f=>f.path==='Inbox/english.pdf'),input={path:file.path,resourceId:file.resourceId,etag:file.etag};const status=await call(api,'document-processing',input);assert.equal(status.status,200);assert.deepEqual(status.data.source,{resourceId:file.resourceId,etag:file.etag});assert.equal(status.data.state,'idle');assert.equal((await call(api,'document-processing',{...input,etag:'stale'})).status,409);assert.equal((await call(api,'document-processing',{...input,resourceId:'other'})).status,409);assert.equal((await call(api,'document-processing',{...input,path:'../private.pdf'})).status,409);assert.equal((await call(api,'document-processing',input,{'x-workflow-space':'other'})).status,403)}finally{api.close();rmSync(dir,{recursive:true})}
})

test('current Activity reads the complete live inbox and keeps absent attempts read-only and out of retry-all',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-current-activity-')),database=join(dir,'db'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'})
 try{
  const actor=(await call(api,'status')).data.actor,scope=JSON.stringify([actor.server,actor.account,actor.space]),db=new DatabaseSync(database)
  db.prepare("insert into intake_queue(id,scope,resource,path,etag,first_seen,state,attempts) values(?,?,?,?,?,?,'failed',3)").run('gone',scope,'old-resource','Inbox/old.pdf','old-etag',1)
  db.prepare('delete from demo_files where folder=0').run()
  const current=await call(api,'intake',{currentInbox:true});assert.equal(current.status,200);assert.equal(current.data.summary.attention,0);assert.equal(current.data.queue.length,0);assert.equal(current.data.historicalTotal,1)
  assert.equal((await call(api,'intake-control',{currentInbox:true,action:'retry'})).data.affected,0)
  assert.equal(db.prepare("select state from intake_queue where id='gone'").get().state,'failed')
  const history=(await call(api,'intake',{currentInbox:true,includeHistory:true})).data;assert.equal(history.queue[0].historical,true);assert.equal(history.queue[0].retryable,false);assert.equal(history.summary.total,0)
  assert.notEqual((await call(api,'intake-retry',{id:'gone'})).status,200)
  db.close()
 }finally{api.close();rmSync(dir,{recursive:true})}
})

test('document tag removal API is exact-source scoped, preserves metadata, and cannot operate from a foreign origin',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-tag-remove-api-')),api=createDraftAPI({database:join(dir,'db'),mode:'demo',allowOrigin:'http://127.0.0.1:5175'});try{await call(api,'status');const d=(await call(api,'metadata',{path:'Inbox/english.pdf'})).data,request={path:d.source.path,documentSpace:d.source.space,resourceId:d.source.resourceId,etag:d.source.etag,sha256:d.source.sha256,version:d.record.version,tag:'Keep existing'};assert.equal((await call(api,'metadata-tag-remove',request,{origin:'https://foreign.example'})).status,403);assert.equal((await call(api,'metadata',{path:d.source.path})).data.source.tags.length,1);assert.equal((await call(api,'metadata-tag-remove',request)).data.state,'done');assert.deepEqual((await call(api,'metadata',{path:d.source.path})).data.source.tags,[])}finally{api.close();rmSync(dir,{recursive:true})}})
test('AI-off preparation keeps local text, OCR and extraction rules without any model calls or automatic writes',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-rules-only-')),api=createDraftAPI({database:join(dir,'db'),mode:'demo',allowOrigin:'http://127.0.0.1:5175'}),fetchBefore=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('AI must not be called')};try{const policy={...defaultPolicy(),aiInput:'off',aiOutput:'off',ocr:'off'},ai=defaultAIConfig();assert.equal((await call(api,'preferences',{configuration:{policy,ai}})).status,200);assert.equal((await call(api,'metadata-schema-save',{schema:{fields:[{id:'invoice',label:'Invoice',type:'text',aliases:['Invoice number'],choices:[]}],tags:[{tag:'Utilities',terms:['Electricity']}]}})).status,200);const before=(await call(api,'metadata',{path:'Inbox/english.pdf'})).data;const result=await call(api,'prepare',{path:'Inbox/english.pdf',resourceId:before.source.resourceId,etag:before.source.etag});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.bundle.manualReview.reason,'rules');assert.equal(result.data.bundle.proposal,null);const detail=(await call(api,'metadata',{path:'Inbox/english.pdf'})).data;assert.equal(detail.suggestions.fields.invoice.value,'SYN-EN-20261029');assert.equal(detail.suggestions.tags[0].value,'Utilities');assert.deepEqual(detail.source,before.source);assert.equal(detail.record.version,0);assert.equal((await call(api,'job',{id:result.data.id})).data.job.decision,null);assert.equal((await call(api,'intake-settings',{configuration:{enabled:true,folder:'Inbox',recursive:true,intervalSeconds:0,settleSeconds:2,cloudConsent:false}})).status,200);assert.equal((await call(api,'preferences',{configuration:{policy,ai}})).data.paused,false);assert.equal((await call(api,'intake')).data.configuration.enabled,true);await call(api,'intake-control',{action:'pause'});const scan=(await call(api,'demo-add-scan')).data;assert.equal((await call(api,'ocr-settings',{languages:['eng']})).status,200);assert.equal((await call(api,'preferences',{configuration:{policy:{...policy,ocr:'automatic'},ai}})).status,200);const scanned=await call(api,'prepare',{path:scan.path,resourceId:scan.resourceId});assert.equal(scanned.status,200,JSON.stringify(scanned.data));assert.ok(scanned.data.bundle.pages.some(page=>page.trim()));assert.equal(scanned.data.bundle.proposal,null);assert.equal(calls,0)}finally{globalThis.fetch=fetchBefore;await api.stop();rmSync(dir,{recursive:true})}})
test('a fresh explicit review updates only the matching current intake record and retains earlier results',async()=>{const dir=mkdtempSync(join(tmpdir(),'workflow-review-current-')),database=join(dir,'db'),api=createDraftAPI({database,mode:'demo',allowOrigin:'http://127.0.0.1:5175'});try{const policy={...defaultPolicy(),aiInput:'off',aiOutput:'off',ocr:'off'};await call(api,'preferences',{configuration:{policy,ai:defaultAIConfig()}});const first=(await call(api,'prepare',{path:'Inbox/english.pdf'})).data,db=new DatabaseSync(database),scope=JSON.stringify([first.bundle.source.server,first.bundle.source.account,first.bundle.source.space]);db.prepare("insert into intake_queue(id,scope,resource,path,etag,first_seen,state,attempts,job) values(?,?,?,?,?,?,'prepared',1,?)").run('current',scope,first.bundle.source.resourceId,first.bundle.source.path,first.bundle.source.etag,Date.now(),first.id);db.close();const next=await call(api,'prepare',{path:'Inbox/english.pdf',newReview:true,resourceId:first.bundle.source.resourceId,etag:first.bundle.source.etag});assert.equal(next.status,200);assert.notEqual(next.data.id,first.id);const after=new DatabaseSync(database);assert.equal(after.prepare('select job from intake_queue where id=?').get('current').job,next.data.id);assert.equal(after.prepare('select count(*) n from proposals').get().n,2);assert.equal(after.prepare('select count(*) n from decisions').get().n,0);after.close()}finally{await api.stop();rmSync(dir,{recursive:true})}})
