// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,chmod,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SessionSupervisor,PrivateSessionFile} from '../../companion/session.mjs'
import {ProposalJournal} from '../../companion/journal.mjs'
import {Workflow} from '../../companion/workflow.mjs'
import {Intake,defaultIntake} from '../../companion/intake.mjs'
import {DemoAdapter} from '../../companion/demo.mjs'

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'workflow-session-')),file=join(directory,'credential'),database=join(directory,'state.sqlite3')
 let now=1000000,attached=null,attachCount=0,fetchCount=0,denied=false,identityAccount='fixture-account'
 const actor={server:'https://opencloud.example',space:'fixture-space',account:identityAccount,mode:'live'}
 const options={file,origin:actor.server,space:actor.space,account:actor.account,now:()=>now,tokenEndpoint:'https://auth.example/token',clientId:'fixture-client',adapterFactory:({token})=>({token,identity:async()=>{if(denied)throw Object.assign(new Error('private revoked response'),{status:401});return{...actor,account:identityAccount}}}),attach:async(api,pin)=>{const who=await api.identity();if(who.account!==pin.account)throw Object.assign(new Error('wrong account'),{status:403});attached=api;attachCount++;return who},detach:api=>{if(attached===api)attached=null},fetcher:async(url,request)=>{fetchCount++;assert.equal(url,'https://auth.example/token');assert.equal(request.redirect,'error');assert.equal(request.body.get('grant_type'),'refresh_token');assert.equal(request.body.get('client_id'),'fixture-client');assert.equal(request.body.has('scope'),false);return Response.json({access_token:'fixture-new-access',refresh_token:'fixture-new-refresh',token_type:'Bearer',expires_in:3600})}}
 const save=async value=>writeFile(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600})
 await save({version:1,access_token:'fixture-old-access',refresh_token:'fixture-old-refresh',expires_at:now+3600000})
 return{directory,file,database,actor,options,save,get attached(){return attached},get attachCount(){return attachCount},get fetchCount(){return fetchCount},advance(ms){now+=ms},deny(){denied=true},changeAccount(){identityAccount='other-account'},close:()=>rm(directory,{recursive:true})}
}

test('private background access survives a browser-free restart and prepares stable arrivals only once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workflow-browser-free-')),file=join(dir,'credential'),database=join(dir,'state.sqlite3');await writeFile(file,'fixture-private-session',{mode:0o600})
 let j=new ProposalJournal(database),w=new Workflow(j),api=new DemoAdapter(j.db),now=1000000,calls=0;api.seed();const actor=await api.identity()
 let intake=new Intake(w,{now:()=>now,prepare:async()=>({id:'prepared-'+ ++calls})})
 intake.save(actor,{...defaultIntake(),enabled:true,settleSeconds:2},api);intake.sessions.clear()
 const manager=()=>new SessionSupervisor({file,origin:actor.server,space:actor.space,account:actor.account,now:()=>now,adapterFactory:()=>api,attach:async adapter=>{intake.attach(actor,adapter);return actor},detach:adapter=>{for(const [scope,s]of intake.sessions)if(s.api===adapter)intake.sessions.delete(scope)}})
 let session=manager()
 try{
  await session.tick();assert.equal(session.status(actor).state,'connected');await intake.tick({force:true});now+=3000;await intake.tick({force:true});assert.equal(calls,3)
  await session.stop();j.close();j=new ProposalJournal(database);w=new Workflow(j);api=new DemoAdapter(j.db);intake=new Intake(w,{now:()=>now,prepare:async()=>({id:'unexpected-'+ ++calls})});session=manager();await session.tick();now+=30000;await intake.tick();assert.equal(calls,3)
  assert.equal(intake.status(actor).health.state,'ready');assert.equal(j.db.prepare('select count(*) n from decisions').get().n,0)
  assert.equal((await readFile(database)).includes(Buffer.from('fixture-private-session')),false)
 }finally{await session.stop();j.close();await rm(dir,{recursive:true})}
})

test('expiring access renews with the existing scope and durably rotates before restart attachment',async()=>{
 const f=await fixture();await f.save({version:1,access_token:'fixture-old-access',refresh_token:'fixture-old-refresh',expires_at:1000001});let s=new SessionSupervisor(f.options)
 try{
  await s.tick();assert.equal(f.fetchCount,1);assert.equal(s.status(f.actor).state,'connected');assert.equal(f.attached.token,'fixture-new-access');const saved=JSON.parse(await readFile(f.file,'utf8'));assert.equal(saved.refresh_token,'fixture-new-refresh');assert.equal(saved.expires_at,4600000);await assert.rejects(readFile(f.file+'.refresh-intent'),{code:'ENOENT'})
  await s.stop();s=new SessionSupervisor(f.options);await s.tick();assert.equal(f.fetchCount,1);assert.equal(f.attached.token,'fixture-new-access')
  assert.equal(JSON.stringify(s.status(f.actor)).includes('fixture-new-access'),false);assert.deepEqual(s.status({...f.actor,account:'other'}),{configured:false,state:'not_configured'})
 }finally{await s.stop();await f.close()}
})

test('an uncertain rotating refresh is never retried after a process restart; a new private grant recovers',async()=>{
 const f=await fixture();let calls=0;await f.save({version:1,access_token:'fixture-old-access',refresh_token:'fixture-secret',expires_at:1000001});const options={...f.options,fetcher:async()=>{calls++;throw new Error('fixture-secret upstream body')}};let s=new SessionSupervisor(options)
 try{
  await s.tick();assert.equal(s.status(f.actor).reason,'refresh_uncertain');assert.equal(f.attached,null);assert.equal(calls,1);await s.stop();s=new SessionSupervisor(options);await s.tick();await s.tick({force:true});assert.equal(calls,1)
  await f.save({version:1,access_token:'operator-new-grant',expires_at:9000000});await s.tick({force:true});assert.equal(s.status(f.actor).state,'connected');assert.equal(f.attached.token,'operator-new-grant');assert.equal(calls,1);assert.equal(JSON.stringify(s.status(f.actor)).includes('fixture-secret'),false)
 }finally{await s.stop();await f.close()}
})

test('revoked background access detaches its adapter and respects retry backoff',async()=>{
 const f=await fixture(),s=new SessionSupervisor(f.options)
 try{await s.tick();assert.ok(f.attached);f.deny();f.advance(30000);await s.tick();assert.equal(f.attached,null);assert.equal(s.status(f.actor).reason,'sign_in_required');const count=f.attachCount;await s.tick();assert.equal(f.attachCount,count);assert.equal(s.status(f.actor).nextAttempt,1060000)}finally{await s.stop();await f.close()}
})

test('changed account, expired nonrenewable access and unsafe credential files cannot attach',async()=>{
 const f=await fixture();let s=new SessionSupervisor(f.options)
 try{f.changeAccount();await s.tick();assert.equal(f.attached,null);await s.stop();await f.save({version:1,access_token:'expired-fixture',expires_at:1});s=new SessionSupervisor({...f.options,tokenEndpoint:undefined});await s.tick();assert.equal(s.status(f.actor).reason,'sign_in_required');await s.stop();await chmod(f.file,0o644);s=new SessionSupervisor(f.options);await s.tick();assert.equal(s.status(f.actor).reason,'private_file_required');assert.equal(f.attached,null)}finally{await s.stop();await f.close()}
})

test('credential files reject symlinks and paths in document state',async()=>{
 const f=await fixture()
 try{const link=join(f.directory,'link');await symlink(f.file,link);await assert.rejects(new PrivateSessionFile(link).read());await assert.rejects(new PrivateSessionFile(f.file,{excludedDirectory:f.directory}).read(),/private_file_required/);await f.save('{"version":');await assert.rejects(new PrivateSessionFile(f.file).read(),/credential_format/)}finally{await f.close()}
})

test('a refresh cannot overwrite an operator replacement made while the request was in flight',async()=>{
 const f=await fixture();await f.save({version:1,access_token:'fixture-old-access',refresh_token:'fixture-old-refresh',expires_at:1});let finish,entered
 const began=new Promise(resolve=>{entered=resolve}),s=new SessionSupervisor({...f.options,fetcher:()=>{entered();return new Promise(resolve=>{finish=resolve})}})
 try{const pending=s.tick();await began;await f.save({version:1,access_token:'operator-replacement',expires_at:9000000});finish(Response.json({access_token:'stale-response',refresh_token:'stale-refresh',token_type:'Bearer',expires_in:3600}));await pending;assert.equal(JSON.parse(await readFile(f.file,'utf8')).access_token,'operator-replacement');await s.tick({force:true});assert.equal(f.attached.token,'operator-replacement')}finally{await s.stop();await f.close()}
})

test('a revoked refresh grant retains an honest sign-in hold across restart without replay',async()=>{
 const f=await fixture();await f.save({version:1,access_token:'fixture-expired',refresh_token:'fixture-revoked',expires_at:1});let calls=0,s=new SessionSupervisor({...f.options,fetcher:async()=>{calls++;return new Response('private provider body',{status:400})}})
 try{await s.tick();assert.equal(s.status(f.actor).reason,'sign_in_required');await s.stop();s=new SessionSupervisor({...f.options,fetcher:async()=>{calls++;throw new Error('must not retry')}});await s.tick();assert.equal(s.status(f.actor).reason,'sign_in_required');assert.equal(calls,1);assert.equal(JSON.stringify(s.status(f.actor)).includes('private provider'),false)}finally{await s.stop();await f.close()}
})

test('an incomplete refresh intent cannot regain authority to refresh',async()=>{
 const f=await fixture();await f.save({version:1,access_token:'fixture-expired',refresh_token:'fixture-refresh',expires_at:1});await writeFile(f.file+'.refresh-intent','{}',{mode:0o600});const s=new SessionSupervisor(f.options)
 try{await s.tick();assert.equal(s.status(f.actor).reason,'refresh_uncertain');assert.equal(f.fetchCount,0);assert.equal(f.attached,null)}finally{await s.stop();await f.close()}
})

test('renewal never sends a rotating grant before its intent directory is durable',async()=>{
 const f=await fixture();await f.save({version:1,access_token:'fixture-expired',refresh_token:'fixture-refresh',expires_at:1});let s=new SessionSupervisor(f.options)
 try{s.store.syncDirectory=async()=>{throw new Error('simulated directory sync failure')};await s.tick();assert.equal(f.fetchCount,0);assert.equal(f.attached,null);assert.equal(s.status(f.actor).state,'held');await s.stop();s=new SessionSupervisor(f.options);await s.tick();assert.equal(s.status(f.actor).reason,'refresh_uncertain');assert.equal(f.fetchCount,0)}finally{await s.stop();await f.close()}
})
