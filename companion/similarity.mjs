// SPDX-License-Identifier: AGPL-3.0-only
import{createHash}from'node:crypto'
import{documentFingerprint,compareFingerprints,documentIdentifiers}from'../src/domain/similarity.ts'
import{safePath}from'../src/domain/review.ts'
// Advisory only: no MOVE, DELETE, tag write, approval or duplicate-Trash intent.
export class SimilarDocuments {
 constructor(workflow){this.w=workflow;this.db=workflow.db;this.signals=new Map();workflow.similarities=this}
 signal(id,input){const key=JSON.stringify([id,input.source.server,input.source.account,input.source.space,input.source.resourceId,input.source.sha256]);if(this.signals.has(key))return this.signals.get(key);const signal=documentIdentifiers(input.pages);if(this.signals.size>=128)this.signals.delete(this.signals.keys().next().value);this.signals.set(key,signal);return signal}
 async present(actor,api,id,source){
  const direct=await api.stat(source.path)
  if(direct&&!direct.folder&&direct.resourceId===source.resourceId&&direct.etag===source.etag)return{path:source.path}
  // Filing may change the path or ETag. Only recorded locations with the same
  // bytes can connect historical OCR to a currently accessible file.
  const location=await this.w.location(actor,api,id),physical=location.space===actor.space?api:api.forSpace(location.space)
  const limit=(this.w.configuration?.settings(actor).limits.maxMiB??100)*1024*1024,bytes=await physical.get(location.path,location.etag,limit)
  if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)return null
  const after=await physical.stat(location.path)
  return after&&!after.folder&&after.resourceId===location.resourceId&&after.etag===location.etag?{path:location.path}:null
 }
 async forJob(actor,api,id){
  const current=this.w.job(actor,id),input=JSON.parse(current.input)
  if(input.source.space!==actor.space)return[]
  const original=await api.stat(input.source.path)
  if(!original||original.resourceId!==input.source.resourceId||original.etag!==input.source.etag)return[]
  const fingerprint=documentFingerprint(input.pages,input.rules)
  if(!fingerprint?.dates.size||!fingerprint.identifiers.size)return[]
  const best=[]
  const candidates=this.db.prepare(`select p.id,p.input from proposals p where p.scope=? and p.result is not null and json_extract(p.input,'$.source.resourceId')<>? and json_extract(p.input,'$.source.sha256')<>? and not exists(select 1 from proposals n where n.scope=p.scope and json_extract(n.input,'$.source.resourceId')=json_extract(p.input,'$.source.resourceId') and (n.updated>p.updated or (n.updated=p.updated and n.id>p.id)))`)
  for(const row of candidates.iterate(this.w.scope(actor),input.source.resourceId,input.source.sha256)){
   let other;try{other=JSON.parse(row.input);safePath(other.source.path);if(other.source.space!==actor.space)continue;const signal=this.signal(row.id,other);if(!signal||![...signal].some(value=>fingerprint.identifiers.has(value)))continue;const result=compareFingerprints(fingerprint,documentFingerprint(other.pages,other.rules));if(!result.candidate||best.length===3&&result.overlap<best[2].score)continue;const present=await this.present(actor,api,row.id,other.source);if(!present)continue;best.push({id:row.id,path:present.path,score:result.overlap});best.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));best.splice(3)}catch{/* Malformed historical input cannot establish a match. */}
  }
  return best.map(({id,path})=>({id,path}))
 }
}
