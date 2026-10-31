import {mount,flushPromises} from '@vue/test-utils'
import {createRouter,createMemoryHistory} from 'vue-router'
import WorkspaceShell from '../../src/components/WorkspaceShell.vue'
import Inbox from '../../src/views/Inbox.vue'
import ReviewInbox from '../../src/views/ReviewInbox.vue'
import {workspaceChildren} from '../../src/routes'
import {createWorkspace,workspaceKey} from '../../src/state/workspace'
import {samples} from '../../src/domain/samples'
import {validateBundle} from '../../src/domain/review'
import {defaultAIConfig} from '../../src/domain/ai'
afterEach(()=>vi.unstubAllGlobals())
async function shell(path='/document-workflow/inbox'){
 let preferences:any;const ai=defaultAIConfig();ai.local.model='fixture';for(const task of ['facts','filing','tags'] as const)ai.tasks[task]='local'
 const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{const operation=url.split('/').pop(),body=JSON.parse(options.body);if(operation==='preferences')preferences=body.configuration;calls.push({operation,body});return Response.json(operation==='spaces'?{spaces:[{id:'test',name:'Test'}]}:operation==='status'?{actor:{mode:'demo',name:'Test'},jobs:[],preferences:preferences??{ai,policy:{ocr:'suggest',rename:'suggest',move:'suggest',tags:'suggest',fields:'suggest',aiInput:'suggest',aiOutput:'suggest'}}}:operation==='intake'?{configured:true,configuration:{folder:'Inbox',enabled:false},queue:[]}:operation==='documents'?{documents:[],nextCursor:null}:operation==='saved-views'?{views:[]}:operation==='files'?{files:[]}:{} )}))
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow',component:WorkspaceShell,children:workspaceChildren}]});await router.push(path);await router.isReady();const w=mount({template:'<RouterView />'},{global:{plugins:[router]}});await flushPromises();return{w,router,calls}
}
it('has one inbox destination and keeps ingestion setup in Settings',async()=>{
 const {w,router}=await shell();expect(w.get('.dw-sidebar nav').text()).toBe('Inbox Documents Activity Settings');expect(w.find('.intake-settings').exists()).toBe(false);await router.push('/document-workflow/intake');await flushPromises();expect(router.currentRoute.value.path).toBe('/document-workflow/settings/ingestion');expect(w.get('#intake-folder').element).toHaveProperty('value','Inbox');expect(w.find('table').exists()).toBe(false);w.unmount()
})
it('keeps model choices across navigation without contacting a provider',async()=>{
 const {w,router,calls}=await shell('/document-workflow/settings/ai');await w.get('#ai-provider').setValue('custom');await w.get('#local-model').setValue('chosen-model');await w.get('[aria-label="Model for Extract document facts"]').setValue('task-model');await w.get('form').trigger('submit');await flushPromises();await router.push('/document-workflow/documents');await router.push('/document-workflow/settings/ai');await flushPromises();expect(w.get('#local-model').element).toHaveProperty('value','chosen-model');expect(w.get('[aria-label="Model for Extract document facts"]').element).toHaveProperty('value','task-model');expect(calls.some(c=>['prepare','models','approve','apply'].includes(c.operation))).toBe(false);w.unmount()
})
it('preserves old review bookmarks while opening details within the correct collection',async()=>{
 const {w,router}=await shell('/document-workflow/review?job=older&from=filed');expect(router.currentRoute.value.path).toBe('/document-workflow/documents');expect(router.currentRoute.value.query.job).toBe('older');await router.push('/document-workflow/review?job=waiting');expect(router.currentRoute.value.path).toBe('/document-workflow/inbox');expect(router.currentRoute.value.query.job).toBe('waiting');w.unmount()
})
it('searches arrivals while retaining the saved inbox boundary',async()=>{
 const store=createWorkspace();store.connection.value={mode:'demo',server:'test',space:'test',account:'test',name:'Test'};store.intakeConfigured.value=true;store.files.value=samples().map(b=>({...b.source,folder:false,size:3,tags:[] as string[]}));vi.spyOn(store,'refresh').mockResolvedValue();const request=vi.spyOn(store,'request');const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/inbox',component:Inbox}]});await router.push('/document-workflow/inbox');const w=mount(Inbox,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store}}});await flushPromises();await w.get('input[type="search"]').setValue('electricity');expect(w.findAll('.document-link')).toHaveLength(1);expect(store.folder.value).toBe('Inbox');expect(request).not.toHaveBeenCalled();w.unmount()
})
it('opens preparation for an arrival without a model call during navigation',async()=>{
 const store=createWorkspace();store.connection.value={mode:'demo',server:'test',space:'test',account:'test',name:'Test'};store.intakeConfigured.value=true;store.files.value=[{...samples()[0]!.source,folder:false,size:3,tags:[] as string[]}];vi.spyOn(store,'refresh').mockResolvedValue();const prepare=vi.spyOn(store,'prepareDocument');const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/inbox',component:Inbox},{path:'/document-workflow/details',component:{template:'<p>Details</p>'}}]});await router.push('/document-workflow/inbox');const w=mount(Inbox,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store}}});await flushPromises();await w.get('.document-link').trigger('click');await flushPromises();expect(router.currentRoute.value.query).toEqual({path:'Inbox/electricity.pdf',return:'inbox'});expect(prepare).not.toHaveBeenCalled();w.unmount()
})
it('escapes document markup on review without rendering source text as HTML',async()=>{
 const store=createWorkspace(),bundle=samples()[0]!;bundle.pages[0]+='\n<img src=x onerror=alert(1)>';store.reviews.value=[validateBundle(bundle)];const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/inbox',component:ReviewInbox}]});await router.push('/document-workflow/inbox');const w=mount(ReviewInbox,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store}}});await flushPromises();expect(w.find('img').exists()).toBe(false);expect(w.get('.technical').text()).toContain('<img src=x onerror=alert(1)>');w.unmount()
})
