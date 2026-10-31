// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
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
