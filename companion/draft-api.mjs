// SPDX-License-Identifier: AGPL-3.0-only
import {tagNameKey} from '../src/domain/tag-names.ts'
import {ProposalJournal} from './journal.mjs'
import {Workflow} from './workflow.mjs'
import {Metadata} from './metadata.mjs'
import {DocumentLibrary} from './documents.mjs'
import {DocumentTrash} from './document-trash.mjs'
import {validatePolicy,safePath} from '../src/domain/review.ts'
import {Conversions} from './conversions.mjs'
import {definitionUsage} from './metadata-usage.mjs'
import {Operations} from './operations.mjs'
import {processingHistory} from './processing-history.mjs'
import {Configuration} from './configuration.mjs'
import {Automation} from './automation.mjs'
import {Transfers} from './transfers.mjs'
import {Duplicates} from './duplicates.mjs'
import {SimilarDocuments} from './similarity.mjs'
import {Intake,validateIntake} from './intake.mjs'
import {DemoAdapter} from './demo.mjs'
import {inboxFiles,inboxSummary} from './inbox.mjs'
import {processingIssue,bulkPreparation,preparationState} from './processing-issues.mjs'
import {processingProgress} from '../src/domain/processing.ts'
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
 journal.db.exec('CREATE TABLE IF NOT EXISTS workspace_selection(server TEXT NOT NULL,account TEXT NOT NULL,space TEXT NOT NULL,PRIMARY KEY(server,account))')
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
 const conversions=new Conversions(workflow)
 const operations=new Operations(workflow,{metadata,prepare,convert:(actor,api,input)=>conversions.convert(actor,api,input),session:actor=>intake.sessions.get(workflow.scope(actor))?.api,invalidateSession:api=>intake.detach(api)})
 let automation
 const intake=new Intake(workflow,{prepare,processPrepared:(actor,api,id,options)=>automation.run(actor,api,id,options),resume:async(actor,api)=>{await automation.resume(actor,api);await duplicates.resume(actor,api)}})
 workflow.intake=intake
 automation=new Automation(workflow,metadata,intake)
 const duplicates=new Duplicates(workflow,intake),transfers=new Transfers(workflow),similarities=new SimilarDocuments(workflow),documentTrash=new DocumentTrash(workflow)
 const packs=new OCRPacks(workflow,{directory:ocrDirectory,installed:ocrLanguages,validate:path=>runOCRTool('combine_tessdata',['-d',path]),...ocrPackOptions})
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
 const managedSessions=new WeakMap()
 const attach=async(api,{account}={})=>{
  const actor=api.accountIdentity?await api.accountIdentity():await api.identity()
  if(mode==='live'&&(actor.server!==origin||account&&actor.account!==account))throw Object.assign(new Error('Background identity mismatch'),{status:403})
  const group=[];try{const verified=await api.identity();if(workflow.scope(verified)!==workflow.scope(actor))throw new Error('Space identity changed');intake.attach(verified,api,{background:true});group.push(api)}catch{workflow.event(actor,null,'background_space_held',{reason:'Space access could not be verified'})}
  for(const row of journal.db.prepare("select scope from intake_settings").all()){
   const [server,owner,target]=JSON.parse(row.scope)
   if(server!==actor.server||owner!==actor.account||target===actor.space)continue
   try{const scoped=api.forSpace(target),verified=await scoped.identity();if(workflow.scope(verified)!==row.scope)throw new Error('Space identity changed');intake.attach(verified,scoped,{background:true});group.push(scoped)}catch{workflow.event({server,account:owner,space:target},null,'background_space_held',{reason:'Space access could not be verified'})}
  }
  managedSessions.set(api,group);for(const session of intake.sessions.values())if(group.includes(session.api)&&!intake.paused(session.actor))operations.resumeProcessing(session.actor,session.api);return actor
 }
 function describeFiles(actor,listing){return listing.map(f=>{
     const queued=journal.db.prepare('select id,state,job,stage from intake_queue where scope=? and resource=? and etag=? order by first_seen desc limit 1').get(workflow.scope(actor),f.resourceId,f.etag)
     const latest=journal.db.prepare("select p.id,p.state,p.input,d.state decision from proposals p left join decisions d on d.job=p.id where p.scope=? and json_extract(p.input,'$.source.resourceId')=? order by p.updated desc,p.id desc limit 1").get(workflow.scope(actor),f.resourceId)
     const current=latest&&(JSON.parse(latest.input).source.etag===f.etag||queued?.job===latest.id),automatic=current?automation.statusFor(actor,latest.id):null,processed=current&&(latest.decision==='done'||automatic?.state==='done')
     const bulk=bulkPreparation(workflow,actor,f)
     const latestRunning=current&&!latest.decision&&['running','pending','failed'].includes(latest.state),state=processed?'processed':bulk?.state==='running'?'running':bulk?.state==='queued'?'queued':bulk?.state==='held'?'failed':latestRunning?(latest.state==='pending'?'queued':latest.state):queued?.state
     let stage=queued?.stage??null;if(bulk&&['running','held'].includes(bulk.state)){stage=bulk.result.stage??'reading'}else if(latestRunning)stage=['running','failed'].includes(latest.state)?'analysing':'reading'
     const progress=!/\.pdf$/i.test(f.path)&&!current?{step:1,total:5,label:'Choose filing details',attention:false}:processingProgress({state,stage,reviewState:current?(latest.decision??latest.state):null,automatic})
     return{...f,reviewJob:current?latest.id:null,reviewState:current?(latest.decision??latest.state):null,fields:metadata.read(actor,f.resourceId).fields,stage,progress,intakeState:state??null,...(queued?.state==='duplicate'?{duplicate:{id:queued.id,job:queued.job,uncertain:!!duplicates.record(actor,queued.id)}}:{})}
    })
 }
 async function readCurrentInbox(actor,api){const configuration=intake.configuration(actor),listing=await inboxFiles(api,configuration);if(JSON.stringify(configuration)!==JSON.stringify(intake.configuration(actor)))throw new Error('The inbox settings changed. Refresh Activity.');return describeFiles(actor,listing)}
 const service={close:()=>{clearInterval(intake.timer);intake.stopped=true;journal.close()},async stop(){await packs.stop();await operations.stop();await intake.stop();journal.close()},async start(){if(demo)await attach(demo);intake.start()},attach,detach(api){const group=managedSessions.get(api)??[api];for(const adapter of group)intake.detach(adapter);managedSessions.delete(api)},async handle(req,res){
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
   let bootstrapAccount
   if(!api){
    const auth=req.headers.authorization;if(!auth?.startsWith('Bearer '))throw Object.assign(new Error('OpenCloud sign-in required'),{status:401})
    let target=selectedSpace??space
    if(!target&&operation!=='spaces'){
     const directory=adapterFactory({origin,space:'__space_directory__',token:auth.slice(7)}),identity=await directory.accountIdentity()
     if(identity.server!==origin||typeof identity.account!=='string'||!identity.account)throw Object.assign(new Error('Authenticated account could not be verified'),{status:403})
     bootstrapAccount=identity.account
     target=journal.db.prepare('select space from workspace_selection where server=? and account=?').get(origin,identity.account)?.space
     if(!target){
      const configured=journal.db.prepare('select scope from intake_settings').all().map(row=>JSON.parse(row.scope)).filter(([server,account])=>server===origin&&account===identity.account)
      const choices=[...new Set(configured.map(([, ,id])=>id))]
      if(choices.length===1)target=choices[0]
      else if(choices.length>1)throw new Error('Choose a workflow Space from a previously connected browser before connecting this device')
      else{const available=await directory.spaces(),personal=available.filter(value=>value.type==='personal');if(personal.length===1)target=personal[0].id;else if(available.length===1)target=available[0].id;else throw new Error('Select an OpenCloud Space before setting up this workflow')}
     }
    }
    api=adapterFactory({origin,space:target??'__space_directory__',token:auth.slice(7)})
   }
   if(operation==='spaces'){send(res,200,{spaces:await api.spaces()});return true}
   if(api instanceof DemoAdapter)api.seed()
   const actor=await api.identity()
   if(bootstrapAccount&&actor.account!==bootstrapAccount||mode==='live'&&actor.server!==origin)throw Object.assign(new Error('Workspace identity changed'),{status:403})
   if(operation==='status'&&mode==='live')journal.db.prepare('insert into workspace_selection values(?,?,?) on conflict(server,account) do update set space=excluded.space').run(actor.server,actor.account,actor.space)
   intake.attach(actor,api);observeSession(actor,api)
   let documentAPI=api
   if(body.documentSpace!==undefined){if(!['files','metadata','metadata-save','metadata-reconcile','metadata-tag-remove','preview','prepare','document-processing','document-trash','prepare-original'].includes(operation))throw new Error('Unexpected document Space');documentAPI=await transfers.adapter(actor,api,body.documentSpace)}
   if(operation==='demo-add-scan'){if(!demo)throw new Error('Synthetic fixtures are only available in demo mode');send(res,200,api.addScannedFixture());return true}
   if(operation==='status'){const options={activeOnly:body.activeOnly===true};send(res,200,{actor,ollama:local,cloud:cloudBase,cloudEnabled:!!(cloudBase&&cloudKey),atomicPreferencePause:true,preferences:workflow.preference(actor),jobs:workflow.jobs(actor,options),jobsHasMore:workflow.jobsHaveMore(actor,options),jobsCursor:workflow.jobPage(actor,options).nextCursor,ocrLanguages:languages(actor)});return true}
   if(operation==='preferences'){
    const configuration=body.configuration;configuration.ai=validateAIConfig(configuration.ai);configuration.policy=validatePolicy(configuration.policy)
    if(local&&configuration.ai.local.endpoint!==local||!local&&Object.values(configuration.ai.tasks).includes('local'))throw new Error('Local endpoint must match the companion configuration')
    const prior=intake.configuration(actor),paused=prior.enabled&&configuration.policy.aiInput!=='off'&&configuration.policy.aiOutput!=='off'&&configuration.ai.tasks.facts==='off'
    journal.db.exec('BEGIN IMMEDIATE')
    let saved
    try{saved=workflow.savePreference(actor,configuration);if(paused)intake.save(actor,{...prior,enabled:false},api);journal.db.exec('COMMIT')}catch(e){journal.db.exec('ROLLBACK');throw e}
    send(res,200,{...saved,paused});return true
   }
   if(operation==='models'){if(!local)throw new Error('Configure a local Ollama endpoint');send(res,200,{models:await listModels(local)});return true}
   if(operation==='ocr-packs'||operation==='ocr-pack-install'){const canManage=await api.isAdministrator?.()===true;if(operation==='ocr-pack-install'){if(!canManage)throw Object.assign(new Error('OpenCloud administrator access required'),{status:403});await packs.start(body.code);workflow.event(actor,null,'ocr_language_install_requested',{code:body.code})}send(res,200,await packs.status(canManage));return true}
   if(operation==='ocr-languages'){send(res,200,{installed:await ocrLanguages(),selected:languages(actor)});return true}
   if(operation==='ocr-settings'){const installed=await ocrLanguages();if(!Array.isArray(body.languages)||body.languages.length>10||body.languages.some(l=>!installed.includes(l)))throw new Error('Choose installed OCR languages');journal.db.prepare('insert into ocr_settings values(?,?) on conflict(scope) do update set languages=excluded.languages').run(workflow.scope(actor),JSON.stringify([...new Set(body.languages)]));workflow.event(actor,null,'ocr_languages_saved');send(res,200,{languages:languages(actor)});return true}
   if(operation==='intake-history'){send(res,200,processingHistory(workflow,actor,body.id));return true}
   if(operation==='intake'){const currentFiles=body.currentInbox===true?await readCurrentInbox(actor,api):null;const status=intake.status(actor,body,currentFiles);send(res,200,{...status,bulkPreparation:operations.processingSummary(actor,currentFiles),queue:status.queue.map(row=>({...row,trash:duplicates.record(actor,row.id)})),duplicateAction:duplicates.action(actor),destinationSpace:configurationStore.destinationSpace(actor),destinationRoot:configurationStore.settings(actor).rules.root,backgroundSession:backgroundSession(actor)});return true}
   if(operation==='background-connect'){if(!backgroundConnect)throw new Error('Private background token storage is not configured');let result;try{result=await backgroundConnect(actor,{username:body.username,appToken:body.appToken})}catch{throw new Error('App token connection failed. Check account name, expiry and permissions.')} workflow.event(actor,null,'background_app_token_connected');send(res,200,result);return true}
   if(operation==='background-disconnect'){if(!backgroundDisconnect)throw new Error('Private background token storage is not configured');send(res,200,await backgroundDisconnect(actor));workflow.event(actor,null,'background_app_token_disconnected');return true}
   if(operation==='reliability'){const canManage=await api.isAdministrator?.()===true;const backups={...(canManage?await backupDetails(actor,api):backupStatus()),canManage};if(!canManage){delete backups.settings;delete backups.storage;delete backups.destination}send(res,200,{backgroundSession:backgroundSession(actor),backups});return true}
   if(operation==='backup-settings-save'){if(await api.isAdministrator?.()!==true)throw Object.assign(new Error('OpenCloud administrator access required'),{status:403});if(!backupConfigure)throw new Error('Backup storage is not configured');const result=await backupConfigure(body.settings,actor,api);workflow.event(actor,null,'backup_settings_saved');send(res,200,{...result,canManage:true});return true}
   if(operation==='intake-settings'){
    const checked=validateIntake(body.configuration),folder=await api.stat(checked.folder)
    if(!folder?.folder)throw new Error('Choose an existing inbox folder in the configured Space')
    if(checked.enabled){
     const preferences=workflow.preference(actor)
     if(!preferences)throw new Error('Save processing settings before starting ingestion')
     const configuration=executionConfig(preferences,{local,cloud:cloudBase,cloudKey,ocrLanguages:languages(actor)})
     if(Object.values(configuration.routes).some(route=>route?.provider==='cloud')&&!checked.cloudConsent)throw new Error('Folder cloud consent is required for the selected cloud provider')
     if(preferences.policy.ocr!=='off'&&!languages(actor).length)throw new Error('Choose installed OCR languages in processing settings before starting ingestion')
    }
    if(body.duplicateAction!==undefined&&!['keep','trash'].includes(body.duplicateAction))throw new Error('Choose a duplicate action')
    let config;journal.db.exec('BEGIN IMMEDIATE');try{config=intake.save(actor,checked,api);if(body.duplicateAction!==undefined)duplicates.save(actor,body.duplicateAction,checked.folder);journal.db.exec('COMMIT')}catch(e){journal.db.exec('ROLLBACK');throw e}send(res,200,{configuration:config,duplicateAction:duplicates.action(actor)});return true
   }
   if(operation==='operations'){send(res,200,{operations:operations.list(actor)});return true}
   if(operation==='operation'){send(res,200,operations.status(actor,body.id));return true}
   if(operation==='conversion-settings'){send(res,200,conversions.settings(actor));return true}
   if(operation==='conversion-settings-save'){send(res,200,conversions.save(actor,body.archive));return true}
   if(operation==='conversion-reformat'){send(res,200,await conversions.reformat(actor,api,body.id));return true}
   if(operation==='conversion-reformat-verify'){send(res,200,await conversions.verifyReformat(actor,api,body.id));return true}
   if(operation==='conversion-archive'){send(res,200,await conversions.continueArchive(actor,api,body.id));return true}
   if(operation==='conversion-verify'){send(res,200,await conversions.reconcile(actor,api,body.id));return true}
   if(operation==='operation-start'){send(res,202,operations.start(actor,api,body));return true}
   if(operation==='operation-retry'){send(res,200,operations.retryHeld(actor,api,body.id));return true}
   if(operation==='operation-resume'){operations.launch(actor,api,body.id);send(res,202,operations.status(actor,body.id));return true}
   if(operation==='automation-takeover'){send(res,200,await automation.takeOver(actor,api,body.id,body.reviewDigest));return true}
   if(operation==='automation-run'){send(res,200,await automation.run(actor,api,body.id,{retry:body.retry===true}));return true}
   if(operation==='intake-scan'){send(res,202,intake.requestCheck(actor));return true}
   if(operation==='duplicate-trash'||operation==='duplicate-verify'){send(res,200,await duplicates.process(actor,api,body.id,{reconcileOnly:operation==='duplicate-verify'}));return true}
   if(operation==='intake-item'){
    if(typeof body.id!=='string'||!body.id||body.id.length>128)throw new Error('Choose processing items')
    const row=journal.db.prepare('select state,job,path,resource,etag from intake_queue where id=? and scope=?').get(body.id,workflow.scope(actor))
    if(!row)throw Object.assign(new Error('Processing item not found'),{status:404})
    send(res,200,{state:row.state,job:row.job,source:{resourceId:row.resource,etag:row.etag},processingIssue:processingIssue(workflow,actor,{path:row.path,resourceId:row.resource,etag:row.etag})});return true
   }
   if(operation==='intake-retry'){const row=journal.db.prepare('select resource,etag,path from intake_queue where id=? and scope=?').get(body.id,workflow.scope(actor));const current=row?await api.stat(row.path):null;if(!current||current.folder||current.resourceId!==row.resource||current.etag!==row.etag)throw new Error('This import is no longer current. Refresh Activity.');intake.retry(actor,body.id);send(res,200,{state:'queued'});return true}
   if(operation==='intake-control'){
    if(body.ids!==undefined&&(!['retry','cancel'].includes(body.action)||!Array.isArray(body.ids)||!body.ids.length||body.ids.some(id=>typeof id!=='string'||!id||id.length>128)))throw new Error('Choose processing items')
    const currentFiles=body.currentInbox===true&&['retry','cancel'].includes(body.action)?await readCurrentInbox(actor,api):null
    let ids=body.ids
    if(currentFiles){const present=new Set(currentFiles.map(file=>JSON.stringify([file.resourceId,file.etag,file.path])));const allowed=journal.db.prepare('select id,resource,etag,path from intake_queue where scope=?').all(workflow.scope(actor)).filter(row=>present.has(JSON.stringify([row.resource,row.etag,row.path]))).map(row=>row.id);if(ids!==undefined&&(!Array.isArray(ids)||!ids.length))throw new Error('Choose processing items');ids=ids===undefined?allowed:ids.filter(id=>allowed.includes(id))}
    const result=ids?.length===0?{affected:0,paused:intake.paused(actor),summary:intake.summary(actor)}:intake.manage(actor,body.action,ids);
    if(body.action==='cancel'&&!body.ids&&currentFiles&&ids.length===0)result.paused=intake.manage(actor,'pause').paused;
if(!body.ids){if(body.action==='cancel')result.affected+=operations.cancelProcessing(actor);if(body.action==='retry')result.affected+=operations.retryProcessing(actor,api,currentFiles);if(body.action==='resume')operations.resumeProcessing(actor,api)}if(['retry','resume'].includes(body.action)&&intake.configuration(actor).enabled&&!result.paused)intake.requestCheck(actor);send(res,200,result);return true}
   if(operation==='filing-settings'){send(res,200,{...configurationStore.settings(actor),destinationSpace:configurationStore.destinationSpace(actor)});return true}
   if(operation==='filing-settings-save'){const targetSpace=body.destinationSpace??configurationStore.destinationSpace(actor);await transfers.adapter(actor,api,targetSpace);journal.db.exec('BEGIN IMMEDIATE');try{configurationStore.saveDestination(actor,targetSpace);const result=configurationStore.save(actor,body);journal.db.exec('COMMIT');send(res,200,{...result,destinationSpace:targetSpace})}catch(e){journal.db.exec('ROLLBACK');throw e}return true}
   if(operation==='tag-options'){let remote=[],available=true;try{remote=await api.listTags?.()??[]}catch{available=false}send(res,200,{tags:[...new Set([...remote,...metadata.schema(actor).tags.map(tag=>tag.tag).filter(tag=>!remote.some(name=>tagNameKey(name)===tagNameKey(tag)))])].filter(tag=>typeof tag==='string'&&tag.trim()&&tag.length<=80&&!/[\x00-\x1f\x7f,]/.test(tag)),available});return true}
   if(operation==='metadata-usage'){send(res,200,await definitionUsage(workflow,documents,actor,api));return true}
   if(operation==='metadata-schema'){send(res,200,metadata.schema(actor));return true}
   if(operation==='saved-views'){send(res,200,{views:documents.views(actor)});return true}
   if(operation==='saved-view-save'){send(res,200,{views:documents.saveView(actor,body)});return true}
   if(operation==='saved-view-delete'){send(res,200,{views:documents.deleteView(actor,body.id)});return true}
   if(operation==='document-trash-pending'){send(res,200,{operations:documentTrash.list(actor)});return true}
   if(operation==='document-trash'||operation==='document-trash-verify'){send(res,200,await documentTrash.process(actor,api,body,{verifyOnly:operation==='document-trash-verify'}));return true}
   if(operation==='prepare-original'){send(res,200,await workflow.prepareOriginal(actor,documentAPI,body));return true}
   if(operation==='library-files'){send(res,200,await documents.browse(actor,api,body));return true}
   if(operation==='documents'){send(res,200,await documents.currentList(actor,api,body));return true}
   if(operation==='jobs'){send(res,200,workflow.jobPage(actor,body));return true}
   if(operation==='job'){const job=workflow.jobView(actor,body.id);let potentialDuplicates=[],duplicateCheck='complete';try{potentialDuplicates=await similarities.forJob(actor,api,body.id)}catch{duplicateCheck='unavailable'}send(res,200,{job:{...job,potentialDuplicates,duplicateCheck}});return true}
   if(operation==='document-location'){send(res,200,await workflow.location(actor,api,body.id));return true}
   if(operation==='metadata-schema-save'){send(res,200,await metadata.saveConnectedSchema(actor,api,body.schema));return true}
   if(operation==='document-processing'){
    safePath(body.path);const source=await documentAPI.stat(body.path)
    if(!source||source.folder||source.resourceId!==body.resourceId||source.etag!==body.etag)throw new Error('The source document changed. Reload document details before continuing.')
    send(res,200,{source:{resourceId:source.resourceId,etag:source.etag},...preparationState(workflow,actor,{...source,space:documentAPI.space??actor.space})});return true
   }
   if(operation==='metadata'){const result=await metadata.get(actor,documentAPI,body.path);send(res,200,{...result,conversion:conversions.association(actor,result.source.resourceId),processingIssue:processingIssue(workflow,actor,result.source)});return true}
   if(operation==='metadata-tag-remove'){send(res,200,await metadata.removeTag(actor,documentAPI,body));return true}
   if(operation==='metadata-save'){send(res,200,await metadata.save(actor,documentAPI,body));return true}
   if(operation==='metadata-reconcile'){send(res,200,await metadata.reconcile(actor,documentAPI,body.id));return true}
   if(operation==='files'){
    const flat=body.flattenInbox===true
    if(flat&&(body.documentSpace!==undefined||body.path!==intake.configuration(actor).folder))throw new Error('Choose the configured inbox')
    const listing=flat?await inboxFiles(api,intake.configuration(actor)):await documentAPI.list(body.path??'Inbox')
    const files=describeFiles(actor,listing)
    send(res,200,{files,...(flat?{summary:inboxSummary(files)}:{})});return true
   }
   if(operation==='preview'){
    const current=await documentAPI.stat(body.path);if(!current||current.folder)throw new Error('Document not found');const bytes=await documentAPI.get(body.path,current.etag,configurationStore.settings(actor).limits.maxMiB*1024*1024)
    res.writeHead(200,{'Content-Type':'application/pdf','Cache-Control':'no-store','Content-Disposition':'inline; filename="document.pdf"','X-Content-Type-Options':'nosniff'});res.end(bytes);return true
   }
   if(operation==='prepare'){send(res,200,await prepare(actor,documentAPI,body.path,{retry:body.retry===true,newReview:body.newReview===true,cloudConsent:body.cloudConsent===true,expectedResourceId:body.resourceId,expectedEtag:body.etag}));return true}
   if(operation==='approve'){send(res,200,await workflow.approve(actor,api,body.id,body.policy,body.reviewDigest,body.manualActions));return true}
   if(operation==='reject'){send(res,200,workflow.reject(actor,body.id));return true}
   if(operation==='apply'||operation==='reconcile'){const result=await workflow.apply(actor,api,body.id,{reconcileOnly:operation==='reconcile'});if(result.state==='done'&&automation.statusFor(actor,body.id)&&automation.statusFor(actor,body.id).state!=='done')automation.update(actor,body.id,'done',operation==='reconcile'?'Outcome confirmed by read-only verification':'Completed after explicit manual filing');send(res,200,result);return true}
   if(operation==='activity'){send(res,200,workflow.activityPage(actor,body));return true}
   send(res,404,{error:'Unknown operation'});return true
  }catch(e){send(res,[401,403,404].includes(e.status)?e.status:409,{error:e.status===401?'OpenCloud sign-in required':e.status===403?'OpenCloud access denied':e.status===404?'Resource not found':e.message?.startsWith('OpenCloud HTTP ')?e.message:'Operation held. '+(e.message?.length<180&&!/[\r\n]/.test(e.message)?e.message:'Inspect the local activity and retry only after checking its state.'),...(e.trashRecorded===false?{trashRecorded:false}:{})});return true}
 }}
 return service
}
