// SPDX-License-Identifier: AGPL-3.0-only
import {ProposalJournal} from './journal.mjs'
import {Workflow} from './workflow.mjs'
import {Metadata} from './metadata.mjs'
import {DocumentLibrary} from './documents.mjs'
import {validatePolicy} from '../src/domain/review.ts'
import {Operations} from './operations.mjs'
import {Configuration} from './configuration.mjs'
import {Automation} from './automation.mjs'
import {Transfers} from './transfers.mjs'
import {Duplicates} from './duplicates.mjs'
import {Intake,validateIntake} from './intake.mjs'
import {DemoAdapter} from './demo.mjs'
import {OpenCloudAdapter} from './opencloud.mjs'
import {listModels,localEndpoint} from './ollama.mjs'
import {executionConfig,cloudEndpoint} from './providers.mjs'
import {OCRPacks} from './ocr-packs.mjs'
import {ocrLanguages,runOCRTool} from './ocr.mjs'
import {validateAIConfig} from '../src/domain/ai.ts'
export function createDraftAPI({database,mode='demo',origin,space,ollama,cloud,cloudKey,allowOrigin,backgroundConnect,backgroundDisconnect,backgroundSession=()=>({configured:false,state:'not_configured'}),backupStatus=()=>({configured:false,state:'not_configured'}),backupDetails=backupStatus,backupConfigure,observeSession=()=>{},ocrDirectory,ocrPackOptions={},adapterFactory=options=>new OpenCloudAdapter(options)}){
 if(!['demo','live'].includes(mode))throw new Error('Invalid runtime mode')
 if(mode==='live'&&!origin)throw new Error('Live mode requires an explicit OpenCloud origin')
 const journal=new ProposalJournal(database),workflow=new Workflow(journal),metadata=new Metadata(workflow),documents=new DocumentLibrary(workflow),configurationStore=new Configuration(workflow)
 const local=ollama?localEndpoint(ollama):null,cloudBase=cloud?cloudEndpoint(cloud):null
 journal.db.exec('CREATE TABLE IF NOT EXISTS ocr_settings(scope TEXT PRIMARY KEY,languages TEXT NOT NULL)')
 const languages=actor=>JSON.parse(journal.db.prepare('select languages from ocr_settings where scope=?').get(workflow.scope(actor))?.languages??'[]')
 const demo=mode==='demo'?new DemoAdapter(journal.db):null
 demo?.seed()
 const prepare=async(actor,api,path,options={})=>{
  const preferences=workflow.preference(actor);if(!preferences)throw new Error('Save AI settings before preparing a review')
  const execution=executionConfig(preferences,{local,cloud:cloudBase,cloudKey,ocrLanguages:languages(actor)})
  const configuration={...execution,contextTokens:configurationStore.settings(actor).limits.contextTokens}
  if(Object.values(configuration.routes).some(r=>r?.provider==='cloud')&&options.cloudConsent!==true)throw new Error('Confirm sending extracted document text to the selected cloud provider')
  return workflow.prepare(actor,api,path,configuration,{...options,cloudKey})
 }
 const operations=new Operations(workflow,{metadata,prepare})
 let automation
 const intake=new Intake(workflow,{prepare,processPrepared:(actor,api,id)=>automation.run(actor,api,id),resume:async(actor,api)=>{await automation.resume(actor,api);await duplicates.resume(actor,api)}})
 automation=new Automation(workflow,metadata,intake)
 const duplicates=new Duplicates(workflow,intake),transfers=new Transfers(workflow)
 const packs=new OCRPacks(workflow,{directory:ocrDirectory,installed:ocrLanguages,validate:path=>runOCRTool('combine_tessdata',['-d',path]),...ocrPackOptions})
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
 const managedSessions=new WeakMap()
 const attach=async(api,{account}={})=>{
  const actor=api.accountIdentity?await api.accountIdentity():await api.identity()
  if(mode==='live'&&(actor.server!==origin||account&&actor.account!==account))throw Object.assign(new Error('Background identity mismatch'),{status:403})
  const group=[];try{const verified=await api.identity();if(workflow.scope(verified)!==workflow.scope(actor))throw new Error('Space identity changed');intake.attach(verified,api);group.push(api)}catch{workflow.event(actor,null,'background_space_held',{reason:'Space access could not be verified'})}
  for(const row of journal.db.prepare("select scope from intake_settings where json_extract(value,'$.enabled')=1").all()){
   const [server,owner,target]=JSON.parse(row.scope)
   if(server!==actor.server||owner!==actor.account||target===actor.space)continue
   try{const scoped=api.forSpace(target),verified=await scoped.identity();if(workflow.scope(verified)!==row.scope)throw new Error('Space identity changed');intake.attach(verified,scoped);group.push(scoped)}catch{workflow.event({server,account:owner,space:target},null,'background_space_held',{reason:'Space access could not be verified'})}
  }
  managedSessions.set(api,group);return actor
 }
 const service={close:()=>{clearInterval(intake.timer);intake.stopped=true;journal.close()},async stop(){await packs.stop();await operations.stop();await intake.stop();journal.close()},async start(){if(demo)await attach(demo);intake.start()},attach,detach(api){const group=managedSessions.get(api)??[api];for(const [scope,session] of intake.sessions)if(group.includes(session.api))intake.sessions.delete(scope);managedSessions.delete(api)},async handle(req,res){
  if(!req.url?.startsWith('/_workflow/api/'))return false
  const expected=allowOrigin instanceof Function?allowOrigin():allowOrigin
  if(req.headers.host!==new URL(expected).host||req.method!=='POST'||req.headers.origin!==expected){send(res,403,{error:'Same-origin POST required'});return true}
  let body={}
  try{
   const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>32_000_000)throw new Error('Request exceeds limit');parts.push(part)}
   body=JSON.parse(Buffer.concat(parts).toString())
   const operation=req.url.slice('/_workflow/api/'.length),selectedSpace=req.headers['x-workflow-space']
   if(selectedSpace!==undefined&&(typeof selectedSpace!=='string'||!selectedSpace||selectedSpace.length>400||/[\/\\?#%\x00-\x20]/.test(selectedSpace)))throw new Error('Invalid selected Space')
   let api=demo?(selectedSpace?demo.forSpace(selectedSpace):demo):null
   if(!api){const auth=req.headers.authorization;if(!auth?.startsWith('Bearer '))throw Object.assign(new Error('OpenCloud sign-in required'),{status:401});api=adapterFactory({origin,space:selectedSpace??space??(operation==='spaces'?'__space_directory__':undefined),token:auth.slice(7)})}
   if(operation==='spaces'){send(res,200,{spaces:await api.spaces()});return true}
   if(api instanceof DemoAdapter)api.seed()
   const actor=await api.identity()
   intake.attach(actor,api);observeSession(actor,api)
   let documentAPI=api
   if(body.documentSpace!==undefined){if(!['files','metadata','metadata-save','metadata-reconcile','preview','prepare'].includes(operation))throw new Error('Unexpected document Space');documentAPI=await transfers.adapter(actor,api,body.documentSpace)}
   if(operation==='demo-add-scan'){if(!demo)throw new Error('Synthetic fixtures are only available in demo mode');send(res,200,api.addScannedFixture());return true}
   if(operation==='status'){const options={activeOnly:body.activeOnly===true};send(res,200,{actor,ollama:local,cloud:cloudBase,cloudEnabled:!!(cloudBase&&cloudKey),atomicPreferencePause:true,preferences:workflow.preference(actor),jobs:workflow.jobs(actor,options),jobsHasMore:workflow.jobsHaveMore(actor,options),jobsCursor:workflow.jobPage(actor,options).nextCursor,ocrLanguages:languages(actor)});return true}
   if(operation==='preferences'){
    const configuration=body.configuration;configuration.ai=validateAIConfig(configuration.ai);configuration.policy=validatePolicy(configuration.policy)
    if(local&&configuration.ai.local.endpoint!==local||!local&&Object.values(configuration.ai.tasks).includes('local'))throw new Error('Local endpoint must match the companion configuration')
    const prior=intake.configuration(actor),paused=prior.enabled&&(configuration.policy.aiInput==='off'||configuration.policy.aiOutput==='off'||configuration.ai.tasks.facts==='off')
    journal.db.exec('BEGIN IMMEDIATE')
    let saved
    try{saved=workflow.savePreference(actor,configuration);if(paused)intake.save(actor,{...prior,enabled:false},api);journal.db.exec('COMMIT')}catch(e){journal.db.exec('ROLLBACK');throw e}
    send(res,200,{...saved,paused});return true
   }
   if(operation==='models'){if(!local)throw new Error('Configure a local Ollama endpoint');send(res,200,{models:await listModels(local)});return true}
   if(operation==='ocr-packs'||operation==='ocr-pack-install'){const canManage=await api.isAdministrator?.()===true;if(operation==='ocr-pack-install'){if(!canManage)throw Object.assign(new Error('OpenCloud administrator access required'),{status:403});await packs.start(body.code);workflow.event(actor,null,'ocr_language_install_requested',{code:body.code})}send(res,200,await packs.status(canManage));return true}
   if(operation==='ocr-languages'){send(res,200,{installed:await ocrLanguages(),selected:languages(actor)});return true}
   if(operation==='ocr-settings'){const installed=await ocrLanguages();if(!Array.isArray(body.languages)||body.languages.length>10||body.languages.some(l=>!installed.includes(l)))throw new Error('Choose installed OCR languages');journal.db.prepare('insert into ocr_settings values(?,?) on conflict(scope) do update set languages=excluded.languages').run(workflow.scope(actor),JSON.stringify([...new Set(body.languages)]));workflow.event(actor,null,'ocr_languages_saved');send(res,200,{languages:languages(actor)});return true}
   if(operation==='intake'){const status=intake.status(actor,body);send(res,200,{...status,queue:status.queue.map(row=>({...row,trash:duplicates.record(actor,row.id)})),duplicateAction:duplicates.action(actor),destinationSpace:configurationStore.destinationSpace(actor),destinationRoot:configurationStore.settings(actor).rules.root,backgroundSession:backgroundSession(actor)});return true}
   if(operation==='background-connect'){if(!backgroundConnect)throw new Error('Private background token storage is not configured');let result;try{result=await backgroundConnect(actor,{username:body.username,appToken:body.appToken})}catch{throw new Error('App token connection failed. Check account name, expiry and permissions.')} workflow.event(actor,null,'background_app_token_connected');send(res,200,result);return true}
   if(operation==='background-disconnect'){if(!backgroundDisconnect)throw new Error('Private background token storage is not configured');send(res,200,await backgroundDisconnect(actor));workflow.event(actor,null,'background_app_token_disconnected');return true}
   if(operation==='reliability'){const canManage=await api.isAdministrator?.()===true;const backups={...(canManage?await backupDetails(actor,api):backupStatus()),canManage};if(!canManage){delete backups.settings;delete backups.storage;delete backups.destination}send(res,200,{backgroundSession:backgroundSession(actor),backups});return true}
   if(operation==='backup-settings-save'){if(await api.isAdministrator?.()!==true)throw Object.assign(new Error('OpenCloud administrator access required'),{status:403});if(!backupConfigure)throw new Error('Backup storage is not configured');const result=await backupConfigure(body.settings,actor,api);workflow.event(actor,null,'backup_settings_saved');send(res,200,{...result,canManage:true});return true}
   if(operation==='intake-settings'){
    const checked=validateIntake(body.configuration),folder=await api.stat(checked.folder)
    if(!folder?.folder)throw new Error('Choose an existing inbox folder in the configured Space')
    if(checked.enabled){
     const preferences=workflow.preference(actor)
     if(!preferences||preferences.policy.aiInput==='off'||preferences.policy.aiOutput==='off')throw new Error('Save enabled AI input/output and model settings before starting ingestion')
     const configuration=executionConfig(preferences,{local,cloud:cloudBase,cloudKey,ocrLanguages:languages(actor)})
     if(Object.values(configuration.routes).some(route=>route?.provider==='cloud')&&!checked.cloudConsent)throw new Error('Folder cloud consent is required for the selected cloud provider')
     if(preferences.policy.ocr!=='off'&&!languages(actor).length)throw new Error('Choose installed OCR languages in processing settings before starting ingestion')
    }
    if(body.duplicateAction!==undefined&&!['keep','trash'].includes(body.duplicateAction))throw new Error('Choose a duplicate action')
    let config;journal.db.exec('BEGIN IMMEDIATE');try{config=intake.save(actor,checked,api);if(body.duplicateAction!==undefined)duplicates.save(actor,body.duplicateAction,checked.folder);journal.db.exec('COMMIT')}catch(e){journal.db.exec('ROLLBACK');throw e}send(res,200,{configuration:config,duplicateAction:duplicates.action(actor)});return true
   }
   if(operation==='operations'){send(res,200,{operations:operations.list(actor)});return true}
   if(operation==='operation'){send(res,200,operations.status(actor,body.id));return true}
   if(operation==='operation-start'){send(res,202,operations.start(actor,api,body));return true}
   if(operation==='operation-resume'){operations.launch(actor,api,body.id);send(res,202,operations.status(actor,body.id));return true}
   if(operation==='automation-takeover'){send(res,200,await automation.takeOver(actor,api,body.id,body.reviewDigest));return true}
   if(operation==='automation-run'){send(res,200,await automation.run(actor,api,body.id,{retry:body.retry===true}));return true}
   if(operation==='intake-scan'){send(res,202,intake.requestCheck(actor));return true}
   if(operation==='duplicate-trash'||operation==='duplicate-verify'){send(res,200,await duplicates.process(actor,api,body.id,{reconcileOnly:operation==='duplicate-verify'}));return true}
   if(operation==='intake-retry'){intake.retry(actor,body.id);send(res,200,{state:'queued'});return true}
   if(operation==='filing-settings'){send(res,200,{...configurationStore.settings(actor),destinationSpace:configurationStore.destinationSpace(actor)});return true}
   if(operation==='filing-settings-save'){const targetSpace=body.destinationSpace??configurationStore.destinationSpace(actor);await transfers.adapter(actor,api,targetSpace);journal.db.exec('BEGIN IMMEDIATE');try{configurationStore.saveDestination(actor,targetSpace);const result=configurationStore.save(actor,body);journal.db.exec('COMMIT');send(res,200,{...result,destinationSpace:targetSpace})}catch(e){journal.db.exec('ROLLBACK');throw e}return true}
   if(operation==='metadata-schema'){send(res,200,metadata.schema(actor));return true}
   if(operation==='saved-views'){send(res,200,{views:documents.views(actor)});return true}
   if(operation==='saved-view-save'){send(res,200,{views:documents.saveView(actor,body)});return true}
   if(operation==='saved-view-delete'){send(res,200,{views:documents.deleteView(actor,body.id)});return true}
   if(operation==='documents'){send(res,200,documents.list(actor,body));return true}
   if(operation==='jobs'){send(res,200,workflow.jobPage(actor,body));return true}
   if(operation==='job'){send(res,200,{job:workflow.jobView(actor,body.id)});return true}
   if(operation==='document-location'){send(res,200,await workflow.location(actor,api,body.id));return true}
   if(operation==='metadata-schema-save'){send(res,200,metadata.saveSchema(actor,body.schema));return true}
   if(operation==='metadata'){send(res,200,await metadata.get(actor,documentAPI,body.path));return true}
   if(operation==='metadata-save'){send(res,200,await metadata.save(actor,documentAPI,body));return true}
   if(operation==='metadata-reconcile'){send(res,200,await metadata.reconcile(actor,documentAPI,body.id));return true}
   if(operation==='files'){send(res,200,{files:(await documentAPI.list(body.path??'Inbox')).map(f=>{const queued=journal.db.prepare('select id,state,job from intake_queue where scope=? and resource=? and etag=? order by first_seen desc limit 1').get(workflow.scope(actor),f.resourceId,f.etag),latest=journal.db.prepare("select p.id,p.state,p.input,d.state decision from proposals p left join decisions d on d.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId')=? order by p.updated desc,p.id desc limit 1").get(workflow.scope(actor),f.resourceId),current=latest&&(JSON.parse(latest.input).source.etag===f.etag||queued?.job===latest.id),processed=current&&(latest.decision==='done'||automation.statusFor(actor,latest.id)?.state==='done');return{...f,reviewJob:current?latest.id:null,reviewState:current?(latest.decision??latest.state):null,fields:metadata.read(actor,f.resourceId).fields,intakeState:processed?'processed':queued?.state??null,...(queued?.state==='duplicate'?{duplicate:{id:queued.id,job:queued.job,uncertain:!!duplicates.record(actor,queued.id)}}:{})}})});return true}
   if(operation==='preview'){
    const current=await documentAPI.stat(body.path);if(!current||current.folder)throw new Error('Document not found');const bytes=await documentAPI.get(body.path,current.etag,configurationStore.settings(actor).limits.maxMiB*1024*1024)
    res.writeHead(200,{'Content-Type':'application/pdf','Cache-Control':'no-store','Content-Disposition':'inline; filename="document.pdf"','X-Content-Type-Options':'nosniff'});res.end(bytes);return true
   }
   if(operation==='prepare'){send(res,200,await prepare(actor,documentAPI,body.path,{retry:body.retry===true,newReview:body.newReview===true,cloudConsent:body.cloudConsent===true}));return true}
   if(operation==='approve'){send(res,200,await workflow.approve(actor,api,body.id,body.policy,body.reviewDigest,body.manualActions));return true}
   if(operation==='reject'){send(res,200,workflow.reject(actor,body.id));return true}
   if(operation==='apply'||operation==='reconcile'){const result=await workflow.apply(actor,api,body.id,{reconcileOnly:operation==='reconcile'});if(result.state==='done'&&automation.statusFor(actor,body.id)&&automation.statusFor(actor,body.id).state!=='done')automation.update(actor,body.id,'done',operation==='reconcile'?'Outcome confirmed by read-only verification':'Completed after explicit manual filing');send(res,200,result);return true}
   if(operation==='activity'){send(res,200,workflow.activityPage(actor,body));return true}
   send(res,404,{error:'Unknown operation'});return true
  }catch(e){send(res,[401,403,404].includes(e.status)?e.status:409,{error:e.status===401?'OpenCloud sign-in required':e.status===403?'OpenCloud access denied':e.status===404?'Resource not found':e.message?.startsWith('OpenCloud HTTP ')?e.message:'Operation held. '+(e.message?.length<180&&!/[\r\n]/.test(e.message)?e.message:'Inspect the local activity and retry only after checking its state.')});return true}
 }}
 return service
}
