// SPDX-License-Identifier: AGPL-3.0-only
import {DatabaseSync,backup} from 'node:sqlite'
import {constants,createReadStream} from 'node:fs'
import {mkdir,lstat,realpath,open,rename,readdir,copyFile,stat,unlink,readFile,rm} from 'node:fs/promises'
import {resolve,join,dirname,basename} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {hostname} from 'node:os'
import {safePath} from '../src/domain/review.ts'

const fail=code=>Object.assign(new Error(code),{backupReason:code})
export function validateBackupSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['enabled,intervalMinutes,maxMiB,maxSnapshots','destination,enabled,intervalMinutes,maxMiB,maxSnapshots'].includes(Object.keys(value).sort().join(','))||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.intervalMinutes)||value.intervalMinutes<1||value.intervalMinutes>43200||!Number.isSafeInteger(value.maxSnapshots)||value.maxSnapshots<1||value.maxSnapshots>1000||!Number.isSafeInteger(value.maxMiB)||value.maxMiB<1||value.maxMiB>8192)throw new Error('Invalid backup settings')
 const destination=value.destination
 if(destination!==undefined){if(!destination||Object.keys(destination).sort().join(',')!=='account,folder,server,space'||typeof destination.server!=='string'||new URL(destination.server).origin!==destination.server||!destination.server.startsWith('https://')||typeof destination.account!=='string'||!destination.account||typeof destination.space!=='string'||!destination.space||/[\/\\?#%\x00-\x20]/.test(destination.space))throw new Error('Invalid backup destination');safePath(destination.folder)}
 return{enabled:value.enabled,intervalMinutes:value.intervalMinutes,maxSnapshots:value.maxSnapshots,maxMiB:value.maxMiB,...(destination?{destination:{...destination}}:{})}
}
const required=['proposals','decisions','activity','metadata','metadata_schema','metadata_changes','intake_settings','intake_queue','preferences']
async function privateDirectory(path,{create=false}={}){if(create)await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||await realpath(path)!==path)throw fail('private_directory_required')}
async function privateFile(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw fail('private_file_required');return s}
async function hash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
async function syncDirectory(path){const f=await open(path,constants.O_RDONLY);try{await f.sync()}finally{await f.close()}}
async function durableJSON(path,value,{exclusive=false}={}){const tmp=exclusive?path:path+'.pending-'+randomUUID();const f=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync()}finally{await f.close()}if(!exclusive)await rename(tmp,path);await syncDirectory(dirname(path))}
function inspect(db){
 const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw fail('integrity_failed')
 const schema=db.prepare("select name,sql from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all()
 if(required.some(name=>!schema.some(s=>s.name===name)))throw fail('schema_incomplete')
 const counts=Object.fromEntries(required.map(name=>[name,db.prepare(`select count(*) n from ${name}`).get().n]))
 return{schemaHash:createHash('sha256').update(JSON.stringify(schema)).digest('hex'),counts}
}
async function usage(directory){let bytes=0,count=0;for(const entry of await readdir(directory,{withFileTypes:true})){if(!/^(snapshot-|\.pending-snapshot-)/.test(entry.name))continue;count++;if(!entry.isDirectory()||entry.isSymbolicLink())throw fail('unexpected_backup_entry');for(const name of await readdir(join(directory,entry.name))){const s=await lstat(join(directory,entry.name,name));if(!s.isFile()||s.isSymbolicLink())throw fail('unexpected_backup_entry');bytes+=s.size}}return{bytes,count}}

export async function verifySnapshot(directory){
 directory=resolve(directory);await privateDirectory(directory);const manifestPath=join(directory,'manifest.json');const m=await privateFile(manifestPath);if(m.size>32768)throw fail('manifest_invalid')
 const f=await open(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW);let manifest;try{manifest=JSON.parse(await f.readFile('utf8'))}finally{await f.close()}
 if(manifest.version!==1||(manifest.database!=='database.sqlite3'&&!/^workflow-[0-9TZ-]+-[a-f0-9-]+\.sqlite3$/.test(manifest.database))||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0||manifest.bytes>8*1024**3||!manifest.schemaHash||!manifest.counts)throw fail('manifest_invalid')
 const file=join(directory,manifest.database),s=await privateFile(file);if(s.size!==manifest.bytes||await hash(file)!==manifest.sha256)throw fail('checksum_failed')
 const db=new DatabaseSync(file,{readOnly:true});try{const found=inspect(db);if(found.schemaHash!==manifest.schemaHash||JSON.stringify(found.counts)!==JSON.stringify(manifest.counts))throw fail('manifest_mismatch')}finally{db.close()}
 return{...manifest,file}
}

// Restoring always creates a NEW local database. It never activates a service,
// contacts OpenCloud, overwrites a current journal, or resumes an old worker.
export async function restoreSnapshot(snapshot,target){
 const manifest=await verifySnapshot(snapshot);target=resolve(target);await privateDirectory(dirname(target),{create:true})
 for(const path of [target,target+'-wal',target+'-shm',target+'.recovery.json']){try{await lstat(path);throw fail('restore_target_exists')}catch(e){if(e.code!=='ENOENT')throw e}}
 await copyFile(manifest.file,target,constants.COPYFILE_EXCL)
 const db=new DatabaseSync(target);let before
 try{before=inspect(db);db.exec('BEGIN IMMEDIATE');try{for(const row of db.prepare('select scope,value from intake_settings').all()){const config=JSON.parse(row.value);config.enabled=false;db.prepare('update intake_settings set value=?,last_scan=0 where scope=?').run(JSON.stringify(config),row.scope)}db.exec('delete from workflow_locks');db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}db.exec('PRAGMA wal_checkpoint(TRUNCATE)');inspect(db)}finally{db.close()}
 const receipt={version:1,created:new Date().toISOString(),sourceSHA256:manifest.sha256,restoredSHA256:await hash(target),counts:before.counts,ingestionPaused:true,staleLocksCleared:true,networkRequests:0};await durableJSON(target+'.recovery.json',receipt,{exclusive:true});return receipt
}

export class BackupManager {
 constructor({database,directory,intervalMs=6*3600000,maxSnapshots=28,maxBytes=1024**3,now=()=>Date.now(),copy=backup}){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>30*86400000||!Number.isSafeInteger(maxSnapshots)||maxSnapshots<1||maxSnapshots>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1024*1024||maxBytes>8*1024**3)throw new Error('Invalid backup limits')
  Object.assign(this,{database:resolve(database),directory:resolve(directory),intervalMs,maxSnapshots,maxBytes,now,copy});this.nextAttempt=0;this.active=null;this.stopped=false;this.health={configured:true,state:'starting',lastAttempt:null,lastSuccess:null,reason:null};this.initialized=false;this.enabled=true;this.settingsLoaded=false;this.settingsOperations=Promise.resolve();this.sessions=new Map();this.backgroundSessions=new Map();this.destination=null;this.remoteStorage=null
 }
 settings(){return{enabled:this.enabled,intervalMinutes:this.intervalMs/60000,maxSnapshots:this.maxSnapshots,maxMiB:this.maxBytes/1048576,...(this.destination?{destination:{...this.destination}}:{})}}
 status(){return{...this.health,...(!this.enabled?{state:'disabled'}:{}),nextAttempt:this.enabled?this.nextAttempt||null:null,intervalHours:this.intervalMs/3600000,settings:this.settings()}}
 async report(){await this.loadSettings();let storage=null;try{storage=this.destination?await this.remoteUsage():await usage(this.directory)}catch{}return{...this.status(),storage,storageType:this.destination?'opencloud':'local'}}
 attach(actor,api,{background=false}={}){const key=JSON.stringify([actor.server,actor.account]);if(background)this.backgroundSessions.set(key,api);this.sessions.set(key,this.backgroundSessions.get(key)??api);if(this.health.reason==='backup_access_required')this.nextAttempt=0}
 detach(api){for(const [key,value]of this.backgroundSessions)if(value===api)this.backgroundSessions.delete(key);for(const [key,value]of this.sessions)if(value===api)this.sessions.delete(key)}
 async remoteAPI(){const target=this.destination,session=this.sessions.get(JSON.stringify([target.server,target.account]));if(!session)throw fail('backup_access_required');const api=session.space===target.space?session:session.forSpace(target.space);let actor;try{actor=await api.identity()}catch(e){if([401,403].includes(e.status))throw fail('backup_access_required');throw e}if(actor.server!==target.server||actor.account!==target.account||actor.space!==target.space||await api.isAdministrator?.()!==true)throw fail('backup_access_required');return api}
 async remoteUsage(){const api=await this.remoteAPI(),files=await api.list(this.destination.folder),owned=files.filter(f=>!f.folder&&/^workflow-[0-9TZ-]+-[a-f0-9-]+\.(sqlite3|json)$/.test(basename(f.path)));return{count:owned.filter(f=>f.path.endsWith('.sqlite3')).length,bytes:owned.reduce((n,f)=>n+f.size,0)}}
 async publishRemote(stage,manifest){
  const path=join(this.directory,'backup-upload.json');let intent
  try{await privateFile(path);intent=JSON.parse(await readFile(path,'utf8'));if(intent.state==='done')intent=null}catch(e){if(e.code!=='ENOENT')throw fail('backup_upload_held')}
  if(!intent){if(!stage) return null;const name='workflow-'+new Date(this.now()).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();intent={state:'pending',stage,manifest:{...manifest,database:name+'.sqlite3'},destination:{...this.destination},name,databaseIntent:false,manifestIntent:false};await durableJSON(path,intent)}
  if(JSON.stringify(intent.destination)!==JSON.stringify(this.destination)||dirname(intent.stage)!==this.directory||!basename(intent.stage).startsWith('.pending-snapshot-'))throw fail('backup_upload_held')
  const api=await this.remoteAPI(),file=join(intent.stage,'database.sqlite3');await privateDirectory(intent.stage);await privateFile(file);if((await stat(file)).size!==intent.manifest.bytes||await hash(file)!==intent.manifest.sha256)throw fail('backup_upload_held')
  const manifestBytes=Buffer.from(JSON.stringify(intent.manifest,null,2)+'\n')
  for(const item of [{suffix:'.sqlite3',file,size:intent.manifest.bytes,sha:intent.manifest.sha256,type:'application/vnd.sqlite3',key:'databaseIntent'},{suffix:'.json',bytes:manifestBytes,size:manifestBytes.length,sha:createHash('sha256').update(manifestBytes).digest('hex'),type:'application/json',key:'manifestIntent'}]){
   const target=intent.destination.folder+'/'+intent.name+item.suffix;let found=await api.stat(target)
   if(!found){if(intent[item.key])throw fail('backup_upload_held');intent[item.key]=true;await durableJSON(path,intent);try{if(item.file&&api.putFile)await api.putFile(target,item.file,{contentType:item.type});else await api.put(target,item.bytes??await readFile(item.file),{contentType:item.type})}catch{/* Read-only verification after a lost response; no PUT replay. */}found=await api.stat(target)}
   if(!found||found.folder||found.size!==item.size)throw fail('backup_upload_held');let actual;if(api.digest)actual=await api.digest(target,found.etag,item.size+1);else{const data=await api.get(target,found.etag,item.size+1);actual={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}}const after=await api.stat(target);if(actual.bytes!==item.size||actual.sha256!==item.sha||after?.resourceId!==found.resourceId||after?.etag!==found.etag)throw fail('backup_upload_held')
  }
  intent.state='done';await durableJSON(path,intent);const result={...intent.manifest,storage:'opencloud',path:intent.destination.folder+'/'+intent.name+'.sqlite3'}
  // Only this newly generated temporary snapshot is removed after both remote files verify.
  await rm(intent.stage,{recursive:true});return result
 }
 applySettings(value){if(JSON.stringify(this.destination)!==JSON.stringify(value.destination??null))this.health={...this.health,state:'starting',lastSuccess:null,reason:null};this.destination=value.destination??null;this.enabled=value.enabled;this.intervalMs=value.intervalMinutes*60000;this.maxSnapshots=value.maxSnapshots;this.maxBytes=value.maxMiB*1048576;this.nextAttempt=this.health.lastSuccess===null?0:this.health.lastSuccess+this.intervalMs}
 async loadSettings(){if(this.settingsLoaded)return;await privateDirectory(this.directory,{create:true});const path=join(this.directory,'backup-settings.json');try{await privateFile(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let value;try{if((await handle.stat()).size>4096)throw fail('backup_settings_invalid');value=JSON.parse(await handle.readFile('utf8'))}finally{await handle.close()}if(value.version!==1||Object.keys(value).sort().join(',')!=='settings,version')throw fail('backup_settings_invalid');this.applySettings(validateBackupSettings(value.settings))}catch(e){if(e.code!=='ENOENT')throw fail('backup_settings_invalid')}this.settingsLoaded=true}
 async configureFor(actor,api,value){
  await this.loadSettings()
  if(!value?.enabled)value={...value,...(this.destination?{destination:this.destination}:{})}
  else{if(!value.destination)throw new Error('Choose an OpenCloud backup destination');value={...value,destination:{server:actor.server,account:actor.account,space:value.destination.space,folder:value.destination.folder}}}
  value=validateBackupSettings(value)
  if(value.enabled){const scoped=api.forSpace(value.destination.space),verified=await scoped.identity();if(verified.server!==actor.server||verified.account!==actor.account||verified.space!==value.destination.space)throw new Error('Backup Space unavailable');const parts=value.destination.folder.split('/');for(let n=1;n<=parts.length;n++)await scoped.mkdir(parts.slice(0,n).join('/'));this.attach(actor,api)}
  return this.configure(value)
 }
 configure(value){const settings=validateBackupSettings(value);const task=this.settingsOperations.catch(()=>{}).then(async()=>{if(this.stopped)throw new Error('Backup service is stopping');this.reconfiguring=true;try{await this.active;await this.loadSettings();let pending;try{pending=JSON.parse(await readFile(join(this.directory,'backup-upload.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}if(pending?.state==='pending'&&JSON.stringify(settings.destination??null)!==JSON.stringify(this.destination))throw new Error('Verify the pending backup before changing its destination');await durableJSON(join(this.directory,'backup-settings.json'),{version:1,settings});this.applySettings(settings);return await this.report()}finally{this.reconfiguring=false}});this.settingsOperations=task;return task}

 async lock(){
  const path=join(this.directory,'.backup-lock'),value=JSON.stringify({host:hostname(),pid:process.pid,nonce:randomUUID()})
  for(let attempt=0;attempt<2;attempt++)try{const f=await open(path,'wx',0o600);try{await f.writeFile(value);await f.sync()}finally{await f.close()}return async()=>{if(await readFile(path,'utf8')===value)await unlink(path)}}catch(e){if(e.code!=='EEXIST')throw e;await privateFile(path);let owner;try{owner=JSON.parse(await readFile(path,'utf8'))}catch{throw fail('backup_busy')}if(owner.host!==hostname()||!Number.isSafeInteger(owner.pid)||owner.pid<1)throw fail('backup_busy');try{process.kill(owner.pid,0);throw fail('backup_busy')}catch(e){if(e.code!=='ESRCH')throw e}await unlink(path)}
  throw fail('backup_busy')
 }
 async initialize(){
  if(this.initialized)return
  await this.loadSettings()
  await privateDirectory(this.directory,{create:true})
  const names=(await readdir(this.directory)).filter(n=>/^snapshot-[\dTZ-]+-[a-f0-9-]+$/.test(n)).sort()
  if(names.length>1000)throw fail('capacity_hold')
  if(names.length&&!this.destination){const latest=await verifySnapshot(join(this.directory,names.at(-1))),when=Date.parse(latest.created);if(!Number.isFinite(when)||when>this.now()+60000)throw fail('backup_clock_mismatch');this.health={...this.health,state:'ready',lastSuccess:when};this.nextAttempt=when+this.intervalMs}
  if(this.destination){try{await privateFile(join(this.directory,'backup-health.json'));const h=JSON.parse(await readFile(join(this.directory,'backup-health.json'),'utf8'));if(Number.isFinite(h.lastSuccess)&&JSON.stringify(h.destination??null)===JSON.stringify(this.destination)){this.health.lastSuccess=h.lastSuccess;this.nextAttempt=h.lastSuccess+this.intervalMs}}catch(e){if(e.code!=='ENOENT')throw e}}
  this.initialized=true
 }
 async run(){
  this.health={...this.health,state:'running',lastAttempt:this.now(),reason:null};let source,stage,release
  try{
   await this.initialize();release=await this.lock();await privateFile(this.database)
   if(this.destination){const pending=await this.publishRemote();if(pending){this.health={...this.health,state:'ready',lastSuccess:this.now(),reason:null};this.nextAttempt=this.now()+this.intervalMs;await durableJSON(join(this.directory,'backup-health.json'),{...this.health,destination:this.destination});return pending}}
   const used=this.destination?await this.remoteUsage():await usage(this.directory);source=new DatabaseSync(this.database,{readOnly:true});const pages=source.prepare('PRAGMA page_count').get().page_count,pageSize=source.prepare('PRAGMA page_size').get().page_size
   if(used.count>=this.maxSnapshots||used.bytes+pages*pageSize+32768>this.maxBytes)throw fail('capacity_hold')
   stage=join(this.directory,'.pending-snapshot-'+randomUUID());await mkdir(stage,{mode:0o700});const destination=join(stage,'database.sqlite3');const reserved=await open(destination,'wx',0o600);await reserved.close()
   await this.copy(source,destination);source.close();source=null
   const snapshot=new DatabaseSync(destination);let facts;try{snapshot.exec('PRAGMA journal_mode=DELETE');facts=inspect(snapshot)}finally{snapshot.close()}
   const bytes=(await stat(destination)).size;if(used.bytes+bytes+32768>this.maxBytes)throw fail('capacity_hold')
   const manifest={version:1,created:new Date(this.now()).toISOString(),database:'database.sqlite3',sha256:await hash(destination),bytes,...facts,node:process.version}
   await durableJSON(join(stage,'manifest.json'),manifest,{exclusive:true});await verifySnapshot(stage)
   if(this.destination){const published=await this.publishRemote(stage,manifest);stage=null;this.health={...this.health,state:'ready',lastSuccess:this.now(),reason:null};this.nextAttempt=this.now()+this.intervalMs;await durableJSON(join(this.directory,'backup-health.json'),{...this.health,destination:this.destination});return published}
   const final=join(this.directory,'snapshot-'+new Date(this.now()).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());await syncDirectory(stage);await rename(stage,final);await syncDirectory(this.directory);stage=null
   this.health={...this.health,state:'ready',lastSuccess:this.now(),reason:null};this.nextAttempt=this.now()+this.intervalMs;await durableJSON(join(this.directory,'backup-health.json'),{...this.health,destination:this.destination});return{...manifest,directory:final}
  }catch(e){this.health={...this.health,state:'held',reason:e.backupReason??'backup_unavailable'};this.nextAttempt=this.now()+Math.min(this.intervalMs,300000);if(this.initialized)await durableJSON(join(this.directory,'backup-health.json'),{...this.health,destination:this.destination}).catch(()=>{});return null}
  finally{source?.close();if(release)try{await release()}catch{this.health={...this.health,state:'held',reason:'backup_busy'}}}
 }
 tick({force=false}={}){if(this.reconfiguring)return Promise.resolve(null);if(this.active||this.stopped)return this.active??Promise.resolve(null);this.active=(async()=>{try{await this.initialize()}catch(e){this.health={...this.health,state:'held',reason:e.backupReason??'backup_unavailable'};return null}if(!this.enabled||!force&&this.now()<this.nextAttempt)return null;return this.run()})().finally(()=>{this.active=null});return this.active}
 async start(){await this.tick();if(!this.stopped){this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref()}}
 async stop(){this.stopped=true;clearInterval(this.timer);await this.active;await this.settingsOperations.catch(()=>{})}
}
