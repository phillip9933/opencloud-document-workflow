import {createWorkspace,withinInbox} from '../../src/state/workspace'
import {defaultPolicy} from '../../src/domain/review'
import {defaultAIConfig} from '../../src/domain/ai'
import {samples} from '../../src/domain/samples'
afterEach(()=>vi.unstubAllGlobals())
it('starts at the saved inbox and prevents browsing above it or into a similarly named sibling',async()=>{
 const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{const op=url.split('/').pop(),body=JSON.parse(options.body);calls.push({op,body});return Response.json(op==='status'?{actor:{mode:'live',space:'selected-space'},jobs:[],preferences:{policy:defaultPolicy(),ai:defaultAIConfig()}}:op==='intake'?{configuration:{folder:'Inbox/Selected',enabled:false}}:{files:[{path:'Inbox/Selected/a.pdf'},{path:'Inbox/Selected-other/private.pdf'}]})}))
 const store=createWorkspace();await store.connect();expect(store.folder.value).toBe('Inbox/Selected');store.folder.value='';await store.refresh();expect(calls.filter(c=>c.op==='files').map(c=>c.body.path)).toEqual(['Inbox/Selected']);expect(store.files.value.map(f=>f.path)).toEqual(['Inbox/Selected/a.pdf']);expect(withinInbox('Inbox/Selected-other','Inbox/Selected')).toBe(false);expect(withinInbox('Inbox/Selected/Child','Inbox/Selected')).toBe(true)
})
it('selects a waiting document on first connection rather than a completed review',async()=>{
 const bundles=samples().slice(0,2);vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.endsWith('/status')?{actor:{mode:'demo'},jobs:bundles.map((bundle,i)=>({id:String(i),bundle,source:bundle.source,state:'needs_review',decision:i===0?'done':null}))}:{configuration:{folder:'Inbox',enabled:false}})))
 const store=createWorkspace();await store.connect();expect(store.selected.value).toBe(1)
})
it('ignores a late connection response so it cannot replace the latest workspace state',async()=>{
 const statuses:((value:Response)=>void)[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/status')?new Promise<Response>(resolve=>statuses.push(resolve)):Response.json({configuration:{folder:'Inbox',enabled:false},queue:[]})))
 const store=createWorkspace(),older=store.connect(),newer=store.connect();statuses[1]!(Response.json({actor:{mode:'demo',name:'Newest'},jobs:[]}));await newer;statuses[0]!(Response.json({actor:{mode:'demo',name:'Older'},jobs:[]}));await older;expect(store.connection.value?.name).toBe('Newest')
})
it('uses only the configured Space for native folder navigation',async()=>{
 const location=vi.fn((space:string,path:string)=>({path:'/native/'+space+'/'+path})),store=createWorkspace(()=>'',{spaceName:()=> 'Document Workflow Trial',folderLocation:location});store.connection.value={mode:'live',name:'Alex',account:'alex',server:'https://drive.example',space:'chosen-space'};expect(store.spaceName()).toBe('Document Workflow Trial');expect(store.folderLocation('Inbox/Selected')).toEqual({path:'/native/chosen-space/Inbox/Selected'});expect(location).toHaveBeenCalledWith('chosen-space','Inbox/Selected')
})
it('Space switches discard drafts and reject a late old-Space response',async()=>{
 let finish:((value:Response)=>void)|undefined
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  const space=options.headers['X-Workflow-Space']||'old'
  if(url.endsWith('/preview'))return new Promise<Response>(resolve=>{finish=resolve})
  return Response.json(url.endsWith('/spaces')?{spaces:[{id:'old'},{id:'new'}]}:url.endsWith('/status')?{actor:{mode:'demo',server:'https://example.org',account:'person',space},jobs:[]}:url.endsWith('/intake')?{queue:[],configuration:{folder:'Inbox',enabled:false}}:{files:[]})
 }))
 const store=createWorkspace();await store.loadSpaces();await store.connect();store.filingDrafts.value={test:{target:'old/draft.pdf',tags:'Old'}};const pending=store.request('preview').catch(e=>e.message);await store.switchSpace('new');finish!(new Response('old PDF'));expect(await pending).toContain('workspace changed');expect(store.connection.value?.space).toBe('new');expect(store.filingDrafts.value).toEqual({})
})
