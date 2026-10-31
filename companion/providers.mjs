// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from 'node:crypto'
import {generateProposal,localEndpoint,proposalSchema,proposalRecipe,systemFor,schemaFor,promptContext,boundedJSON} from './ollama.mjs'
import {validateAIConfig} from '../src/domain/ai.ts'
import {validateBundle,validateDocumentInput} from '../src/domain/review.ts'
export function cloudEndpoint(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname.includes('//'))throw new Error('Cloud provider requires an HTTPS API base without credentials');return u.href.replace(/\/$/,'')}
export function executionConfig(preferences,{local,cloud,cloudKey,ocrLanguages=[]}){
 const ai=validateAIConfig(preferences.ai),routes={}
 if(ai.tasks.facts==='off')throw new Error('Enable fact extraction before preparing a filing review')
 for(const task of ['facts','filing','tags']){const provider=ai.tasks[task];if(provider==='off'){routes[task]=null;continue}const selected=ai[provider],endpoint=provider==='local'?localEndpoint(selected.endpoint):cloudEndpoint(selected.endpoint)
  if(provider==='local'&&endpoint!==local)throw new Error('Local provider must match operator configuration')
  if(provider==='cloud'&&(!cloudKey||!cloud||endpoint!==cloudEndpoint(cloud)))throw new Error('Cloud execution is not enabled for this provider by the companion operator')
  routes[task]={provider,endpoint,model:ai.modelOverrides[task]||selected.model}
 }
 return {endpoint:routes.facts.endpoint,model:routes.facts.model,policy:preferences.policy,routes,ocrLanguages,recipe:createHash('sha256').update(proposalRecipe+'task-routes-v1').digest('hex')}
}
export async function generateRouted(input,configuration,{cloudKey,fetcher=fetch,onResponse=()=>{}}={}){
 const checked=validateDocumentInput(input);if(checked.pages.some(p=>!p.trim()))return validateBundle({...checked,proposal:null})
 promptContext(checked,configuration.contextTokens??32768)
 const results=new Map()
 for(const route of Object.values(configuration.routes).filter(Boolean)){
  const key=JSON.stringify(route);if(results.has(key))continue
  let review
  if(route.provider==='local')review=await generateProposal(checked,route.model,route.endpoint,fetcher,raw=>onResponse({route,proposal:raw}),{contextTokens:configuration.contextTokens??32768})
  else{
   if(!cloudKey)throw new Error('Cloud credential unavailable')
   const data=await boundedJSON(await fetcher(`${cloudEndpoint(route.endpoint)}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${cloudKey}`},body:JSON.stringify({model:route.model,store:false,messages:[{role:'system',content:systemFor(checked)},{role:'user',content:JSON.stringify({CURRENT_DOCUMENT:checked.pages.map((text,i)=>({page:i+1,text}))})}],response_format:{type:'json_schema',json_schema:{name:'document_proposal',strict:true,schema:schemaFor(checked)}}})}))
   const choice=data.choices?.[0];if(choice?.finish_reason!=='stop'||choice.message?.refusal||choice.message?.tool_calls||typeof choice.message?.content!=='string')throw new Error('Cloud result is incomplete or refused')
   const proposal=JSON.parse(choice.message.content);onResponse({route,proposal});review=validateBundle({...checked,proposal})
  }
  results.set(key,review.bundle.proposal)
 }
 const get=task=>configuration.routes[task]?results.get(JSON.stringify(configuration.routes[task])):null
 const facts=get('facts'),filing=get('filing'),tags=get('tags')
 return validateBundle({...checked,proposal:{issuer:facts.issuer,date:facts.date,kind:facts.kind,folder:filing?.folder??{value:'Other',evidence:facts.kind.evidence},tags:tags?.tags??[]}})
}
