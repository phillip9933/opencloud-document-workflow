import {createHash} from 'node:crypto'
import {mount,flushPromises} from '@vue/test-utils'
import {createRouter,createMemoryHistory} from 'vue-router'
import IntakeStatus from '../../src/components/IntakeStatus.vue'
import FiledDocuments from '../../src/components/FiledDocuments.vue'
import ReviewInbox from '../../src/views/ReviewInbox.vue'
import DocumentDetails from '../../src/views/DocumentDetails.vue'
import Intake from '../../src/components/IngestionHistory.vue'
import {createWorkspace,workspaceKey} from '../../src/state/workspace'
import type {DraftJob} from '../../src/state/workspace'
import {samples} from '../../src/domain/samples'
import {validateBundle} from '../../src/domain/review'
afterEach(()=>vi.unstubAllGlobals())
function fixture(){const bundle=samples()[0]!;bundle.source.sha256=createHash('sha256').update('pdf').digest('hex');const store=createWorkspace();store.connection.value={...bundle.source,mode:'demo',name:'Test'};const job:DraftJob={id:'older-job',source:bundle.source,bundle,state:'needs_review',decision:'done',updated:'2026-10-30T12:00:00.000Z',error:null,approval:{actions:{target:'Filed/checked.pdf',addTags:['Reviewed']},policy:store.policy.value,reviewDigest:'saved'}};return{bundle,store,job}}
async function mounted(component:any,store:ReturnType<typeof createWorkspace>,path='/document-workflow/documents?view=filed'){
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/:rest(.*)',component}]});await router.push(path);await router.isReady()
 const wrapper=mount(component,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store},stubs:{PdfPreview:{props:['data'],template:'<div data-test="pdf">{{ data.size }}</div>'}}}});await flushPromises();return{wrapper,router}
}
it('distinguishes enabled settings from a confirmed healthy background worker',()=>{
 const w=mount(IntakeStatus,{props:{enabled:true,attached:true}});expect(w.text()).toContain('Waiting for the first inbox check');expect(w.text()).not.toContain('Background preparation ready');w.unmount()
 const held=mount(IntakeStatus,{props:{enabled:true,attached:false,health:{state:'waiting_for_session',lastSuccess:1000000,lastAttempt:1100000,reason:'session',message:'Session expired or access revoked',nextScanAt:null}}});expect(held.text()).toContain('Waiting for OpenCloud sign-in');expect(held.text()).toContain('Last check:');held.unmount()
})
it('searches filed records explicitly and keeps the current page when a page request fails',async()=>{
 const {store,job}=fixture();let fail=true
 const request=vi.spyOn(store,'request').mockImplementation(async(op,body:any)=>{if(op==='saved-views')return{views:[]};expect(op).toBe('documents');if(body.cursor&&fail)throw new Error('Temporary connection failure');return{documents:[{id:job.id,path:body.cursor?'Filed/second.pdf':'Filed/first.pdf',sender:'Sender',date:'2026-10-29',fields:{invoice_number:'INV-42'},tags:['Keep'],updated:job.updated}],nextCursor:body.cursor?null:'next-page'}})
 const {wrapper:w}=await mounted(FiledDocuments,store);expect(w.text()).toContain('first.pdf');expect(w.text()).toContain('Sender')
 await w.get('input[type="search"]').setValue('INV-42');expect(request.mock.calls.filter(c=>c[0]==='documents')).toHaveLength(1);await vi.waitFor(()=>expect(request.mock.calls.at(-1)?.[1]).toMatchObject({search:'INV-42'}))
 await w.findAll('button').find(b=>b.attributes('aria-label')==='Next page')!.trigger('click');await flushPromises();expect(w.get('.library-pages span').text()).toBe('1');expect(w.text()).toContain('first.pdf');expect(w.text()).toContain('Temporary connection failure')
 fail=false;await w.findAll('button').find(b=>b.attributes('aria-label')==='Next page')!.trigger('click');await flushPromises();expect(w.get('.library-pages span').text()).toBe('2');expect(w.text()).toContain('second.pdf');expect(request.mock.calls.some(c=>['prepare','approve','apply','metadata-save'].includes(c[0]))).toBe(false);w.unmount()
})
it('opens a filed record older than the recent-job window and rechecks it without an apply request',async()=>{
 const {store,job,bundle}=fixture();vi.spyOn(store,'refresh').mockImplementation(async()=>{store.jobs.value=[];store.reviews.value=[]})
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({job})))
 const request=vi.spyOn(store,'request').mockImplementation(async(op,body:any)=>{if(op==='job'){expect(body.id).toBe(job.id);return{job}}if(op==='document-location')return{path:'Filed/Renamed/current.pdf',space:bundle.source.space,resourceId:bundle.source.resourceId,etag:'current',tags:['Vehicles']};if(op==='preview')return new Blob(['pdf']);if(op==='reconcile')return{state:'done',tags:['Keep','Reviewed'],verification:{checkedAt:'2026-10-30T12:15:00.000Z',resourceId:bundle.source.resourceId,sha256:bundle.source.sha256}};throw new Error('Unexpected operation '+op)})
 const {wrapper:w}=await mounted(ReviewInbox,store,'/document-workflow/review?job=older-job&from=filed');await vi.waitFor(()=>expect(w.find('[data-test="pdf"]').exists()).toBe(true));expect(w.get('h1').text()).toBe('current.pdf');expect(w.get('.target').text()).toBe('Filed/Renamed');expect(w.get('.suggested-filename').text()).toBe('current.pdf');expect(w.text()).toContain('Vehicles');expect(job.approval!.actions.target).toBe('Filed/checked.pdf');expect(w.find('#review-document').exists()).toBe(false)
 await w.findAll('button').find(b=>b.text()==='Verify file')!.trigger('click');await flushPromises();expect(request).toHaveBeenCalledWith('reconcile',{id:job.id});expect(w.text()).toContain('Verified');expect(w.text()).toContain(bundle.source.sha256);expect(request.mock.calls.some(c=>c[0]==='apply')).toBe(false);w.unmount()
})
it('discards a saved-job response after the workspace identity changes',async()=>{
 const {store,job}=fixture();let resolve!:(value:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(done=>{resolve=done})))
 const pending=store.openJob(job.id);store.connection.value={...store.connection.value!,account:'different-user'};resolve(Response.json({job}));await expect(pending).rejects.toThrow('workspace changed');expect(store.jobs.value).toHaveLength(0)
})
it('keeps completed documents out of the inbox without removing saved records',async()=>{
 const {store,job,bundle}=fixture(),other=structuredClone(samples()[1]!);store.intakeConfigured.value=true;store.files.value=[{...bundle.source,folder:false,size:3,tags:[] as string[],intakeState:'processed'},{...other.source,folder:false,size:3,tags:[] as string[],reviewState:'needs_review'}];store.jobs.value=[job];vi.spyOn(store,'refresh').mockResolvedValue();const {default:Inbox}=await import('../../src/views/Inbox.vue');const {wrapper:w}=await mounted(Inbox,store,'/document-workflow/inbox');expect(w.findAll('.document-link')).toHaveLength(1);expect(w.get('.document-link').text()).toContain('water.pdf');expect(store.jobs.value).toHaveLength(1);w.unmount()
})
it('prepares a fresh review from the located canonical resource after a filing conflict',async()=>{
 const {store,job,bundle}=fixture();job.decision='conflict';store.jobs.value=[job];store.reviews.value=[validateBundle(bundle)]
 vi.spyOn(store,'jobFor').mockImplementation(()=>job);vi.spyOn(store,'refresh').mockResolvedValue();const prepare=vi.spyOn(store,'prepareDocument').mockResolvedValue({id:'fresh',bundle})
 const request=vi.spyOn(store,'request').mockImplementation(async op=>op==='document-location'?{path:'Filed/checked.pdf',resourceId:bundle.source.resourceId,etag:'current-etag'}:op==='preview'?new Blob(['pdf']):{files:[]})
 const {wrapper:w}=await mounted(ReviewInbox,store,'/document-workflow/review');await flushPromises();expect(request).toHaveBeenCalledWith('preview',{path:'Filed/checked.pdf'});await w.findAll('button').find(b=>b.text()==='Reprocess')!.trigger('click');await flushPromises();expect(prepare).toHaveBeenCalledWith('Filed/checked.pdf',{newReview:true,retry:true,resourceId:bundle.source.resourceId,etag:'current-etag',cloudConsent:false});expect(request.mock.calls.some(c=>['approve','apply'].includes(c[0]))).toBe(false);w.unmount()
})
it('holds filed-document metadata editing if another resource replaced the recorded path',async()=>{
 const {store,job}=fixture();const request=vi.spyOn(store,'request').mockImplementation(async op=>op==='job'?{job}:{source:{path:'Filed/checked.pdf',resourceId:'replacement'},schema:{fields:[],tags:[]},record:{version:0,fields:{}},suggestions:{fields:{},tags:[]},pending:[]})
 const {wrapper:w}=await mounted(DocumentDetails,store,'/document-workflow/details?path=Filed%2Fchecked.pdf&return=filed&job=older-job');expect(w.text()).toContain('different document');expect(w.find('input').exists()).toBe(false);expect(request.mock.calls.some(c=>c[0]==='metadata-save')).toBe(false);expect(w.get('a[aria-label="Back"]').attributes('href')).toContain('job=older-job');w.unmount()
})
it('reopens a bookmarked filed record after a fresh client connection',async()=>{
 const {store,job}=fixture(),actor=store.connection.value!;store.connection.value=null
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{const operation=url.split('/').pop();return Response.json(operation==='status'?{actor,jobs:[],preferences:null}:operation==='intake'?{configuration:{folder:'Inbox',enabled:false},queue:[],sessionAttached:true}:operation==='job'?{job}:{files:[]})}))
 vi.spyOn(store,'request').mockImplementation(async operation=>{if(operation==='document-location')return{path:'Filed/checked.pdf',space:job.source.space,resourceId:job.source.resourceId,etag:'current'};if(operation==='preview')return new Blob(['pdf']);throw new Error('Unexpected public request')})
 const {wrapper:w}=await mounted(ReviewInbox,store,'/document-workflow/review?job=older-job&from=filed');await vi.waitFor(()=>expect(w.find('[data-test="pdf"]').exists()).toBe(true));expect(w.get('h1').text()).toBe('checked.pdf');expect(store.connection.value?.account).toBe(actor.account);w.unmount()
})
it('opens a completed filing directly from intake history even when it is outside the active review queue',async()=>{
 const {store,job}=fixture();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({job})))
 vi.spyOn(store,'request').mockImplementation(async()=>({configuration:{enabled:false,folder:'Inbox',recursive:true,intervalSeconds:30,settleSeconds:10,cloudConsent:false},sessionAttached:true,queue:[{id:'queue',path:job.source.path,resource:job.source.resourceId,job:job.id,state:'prepared',decision:'done',attempts:1}]}))
 const {wrapper:w,router}=await mounted(Intake,store,'/document-workflow/intake');expect(w.get('table').text()).toContain('Filed');await w.findAll('button').find(b=>b.classes().includes('document-link'))!.trigger('click');await flushPromises();expect(router.currentRoute.value.query.job).toBe(job.id);expect(router.currentRoute.value.path).toBe('/document-workflow/documents');w.unmount()
})

it('offers reprocessing for a filed review and pins its current location without reusing approval',async()=>{
 const{store,job,bundle}=fixture();store.jobs.value=[job];store.reviews.value=[validateBundle(bundle)];vi.spyOn(store,'jobFor').mockReturnValue(job);vi.spyOn(store,'refresh').mockResolvedValue();const prepare=vi.spyOn(store,'prepareDocument').mockResolvedValue({id:'new-review',bundle}),request=vi.spyOn(store,'request').mockImplementation(async op=>op==='document-location'?{path:'Filed/checked.pdf',space:'destination',resourceId:'current-resource',etag:'current-version'}:op==='preview'?new Blob(['pdf']):{files:[]})
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({job})))
 const{wrapper:w}=await mounted(ReviewInbox,store,'/document-workflow/documents?job=older-job');try{await vi.waitFor(()=>expect(w.findAll('button').find(b=>b.text()==='Reprocess')!.attributes('disabled')).toBeUndefined());await w.findAll('button').find(b=>b.text()==='Reprocess')!.trigger('click');await vi.waitFor(()=>expect(prepare).toHaveBeenCalledWith('Filed/checked.pdf',{newReview:true,retry:true,resourceId:'current-resource',etag:'current-version',documentSpace:'destination',cloudConsent:false});expect(request.mock.calls.some(([op])=>['approve','apply','metadata-save','reject'].includes(op))).toBe(false)}finally{w.unmount()}
})

it('reprocesses a PDF opened directly from the library with its current identity and Space',async()=>{
 const{store,bundle}=fixture(),source={...bundle.source,path:'Docs/vehicle.pdf',tags:[] as string[]},data={source,schema:{fields:[],tags:[]} as import('../../src/domain/metadata').MetadataSchema,record:{version:0,fields:{}},suggestions:{fields:{},tags:[] as {value:string;evidence:{page:number;quote:string}[]}[]},pending:[] as {id:string;state:string}[]};const request=vi.spyOn(store,'request').mockImplementation(async op=>op==='metadata'?data:op==='preview'?new Blob(['pdf']):{}),prepare=vi.spyOn(store,'prepareDocument').mockResolvedValue({id:'new-library-review',bundle});const{wrapper:w}=await mounted(DocumentDetails,store,'/document-workflow/details?path=Docs%2Fvehicle.pdf&space=library-space&return=library')
 try{await flushPromises();await w.findAll('button').find(b=>b.text()==='Reprocess')!.trigger('click');await flushPromises();expect(prepare).toHaveBeenCalledWith(source.path,{newReview:true,retry:true,resourceId:source.resourceId,etag:source.etag,documentSpace:'library-space',cloudConsent:false});expect(request.mock.calls.some(([op])=>['approve','apply','metadata-save'].includes(op))).toBe(false)}finally{w.unmount()}
})
