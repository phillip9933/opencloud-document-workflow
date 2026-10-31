// SPDX-License-Identifier: AGPL-3.0-only
import {lstat,realpath,readdir,open,rename,unlink} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {OpenCloudAdapter} from './opencloud.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const valid=(value,max=16384)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
export class AppTokenSessions {
 constructor({directory,origin,excludedDirectories=[],attach,detach,adapterFactory=options=>new OpenCloudAdapter(options),now=()=>Date.now()}={}){Object.assign(this,{directory:directory?resolve(directory):null,origin,excludedDirectories:excludedDirectories.map(p=>resolve(p)),attach,detach,adapterFactory,now});this.sessions=new Map();this.operations=new Map();this.active=null;this.stopped=false}
 status(actor){const current=this.sessions.get(actor.account);return{available:!!this.directory,method:'app_token',configured:!!current,...(current?.health??{state:'not_configured'}),renewable:false}}
 async checkDirectory(){if(!this.directory)throw new Error('Private background token storage is not configured');const root=await realpath(this.directory),s=await lstat(this.directory);if(root!==this.directory||!s.isDirectory()||s.mode&0o077||this.excludedDirectories.some(p=>root===p||root.startsWith(p+'/')))throw new Error('Private token storage is unavailable')}
 path(account){return join(this.directory,hash(account)+'.json')}
 validate(value){if(!value||Object.keys(value).sort().join(',')!=='account,appToken,server,username,version'||value.version!==1||value.server!==this.origin||!valid(value.account,400)||!valid(value.username,400)||value.username.includes(':')||!valid(value.appToken))throw new Error('Invalid background app token');return value}
 async read(path){await this.checkDirectory();const handle=await open(path,'r');try{const s=await handle.stat(),link=await lstat(path);if(link.isSymbolicLink()||!s.isFile()||s.size>32768||s.mode&0o077||s.uid!==process.getuid?.()&&s.uid!==0)throw new Error('Unsafe token file');return this.validate(JSON.parse(await handle.readFile('utf8')))}finally{await handle.close()}}
 adapter(value,space){return this.adapterFactory({origin:this.origin,space,username:value.username,appToken:value.appToken})}
 withAccount(account,run){if(this.stopped)return Promise.reject(new Error('Background service is stopping'));const task=(this.operations.get(account)??Promise.resolve()).catch(()=>{}).then(run);this.operations.set(account,task);void task.finally(()=>{if(this.operations.get(account)===task)this.operations.delete(account)}).catch(()=>{});return task}
 connect(actor,value){return this.withAccount(actor.account,()=>this.connectPrivate(actor,value))}
 disconnect(actor){return this.withAccount(actor.account,()=>this.disconnectPrivate(actor))}
 async connectPrivate(actor,{username,appToken}){
  await this.checkDirectory();const value=this.validate({version:1,server:this.origin,account:actor.account,username,appToken}),api=this.adapter(value,actor.space),identity=await api.identity()
  if(identity.server!==actor.server||identity.account!==actor.account||identity.space!==actor.space)throw new Error('The app token belongs to a different OpenCloud account')
  const path=this.path(actor.account),temp=path+'.pending-'+randomUUID(),f=await open(temp,'wx',0o600)
  try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();await f.close();if(this.stopped)throw new Error('Background service is stopping');await rename(temp,path);const dir=await open(this.directory,'r');try{await dir.sync()}finally{await dir.close()}}
  finally{await f.close().catch(()=>{});await unlink(temp).catch(()=>{})}
  const previous=this.sessions.get(actor.account);if(previous?.api)await this.detach(previous.api)
  const entry={value,space:actor.space,api:null,health:{state:'connecting',lastSuccess:null},nextAttempt:0};this.sessions.set(actor.account,entry);await this.run(entry);return this.status(actor)
 }
 async disconnectPrivate(actor){await this.checkDirectory();const entry=this.sessions.get(actor.account);this.sessions.delete(actor.account);if(entry?.api)await this.detach(entry.api);await unlink(this.path(actor.account)).catch(e=>{if(e.code!=='ENOENT')throw e});const dir=await open(this.directory,'r');try{await dir.sync()}finally{await dir.close()}return this.status(actor)}
 async run(entry){
  try{const api=this.adapter(entry.value,entry.space),identity=await api.accountIdentity?.()??await api.identity();if(identity.account!==entry.value.account||identity.server!==this.origin)throw new Error('Account changed');if(this.sessions.get(identity.account)!==entry||this.stopped)return;await this.attach(api,{account:entry.value.account});if(this.sessions.get(identity.account)!==entry||this.stopped){await this.detach(api);return}const prior=entry.api;entry.api=api;if(prior)await this.detach(prior);entry.health={state:'connected',lastSuccess:this.now()};entry.nextAttempt=this.now()+30000}
  catch{if(entry.api)await this.detach(entry.api);entry.api=null;entry.health={...entry.health,state:'held',reason:'app_token_access_required'};entry.nextAttempt=this.now()+30000}
 }
 async tick(){if(this.active||this.stopped)return;this.active=(async()=>{for(const entry of this.sessions.values())if(this.now()>=entry.nextAttempt)await this.run(entry)})().finally(()=>{this.active=null});await this.active}
 async start(space='__space_directory__'){if(!this.directory)return;await this.checkDirectory();for(const name of await readdir(this.directory)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;try{const value=await this.read(join(this.directory,name));if(name!==hash(value.account)+'.json')continue;this.sessions.set(value.account,{value,space,api:null,health:{state:'connecting',lastSuccess:null},nextAttempt:0})}catch{/* A malformed credential never attaches or appears in logs. */}}await this.tick();this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref()}
 async stop(){this.stopped=true;clearInterval(this.timer);await this.active;await Promise.allSettled([...this.operations.values()]);for(const entry of this.sessions.values())if(entry.api)await this.detach(entry.api)}
}
