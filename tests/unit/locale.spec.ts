import {provide,ref} from 'vue'
import {mount,flushPromises} from '@vue/test-utils'
import {createRouter,createMemoryHistory} from 'vue-router'
import {createLocale,catalogs,hostLocaleKey,localeKey,uiLanguages} from '../../src/state/locale'
import WorkspaceShell from '../../src/components/WorkspaceShell.vue'
import {workspaceChildren} from '../../src/routes'
import DocumentDetails from '../../src/views/DocumentDetails.vue'
import {createWorkspace,workspaceKey} from '../../src/state/workspace'
import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear()})
it('defaults to supported OpenCloud language, follows its changes, and falls back through system languages',()=>{
 const host=ref('ja-JP');vi.stubGlobal('navigator',{languages:['it-IT','es-ES'],language:'it-IT'});localStorage.clear();const state=createLocale({host:()=>host.value});expect(state.preference.value).toBe('auto');expect(state.locale.value).toBe('ja');host.value='de_DE';expect(state.locale.value).toBe('de');host.value='it-IT';expect(state.locale.value).toBe('es');vi.stubGlobal('navigator',{languages:['ko-KR'],language:'ko-KR'});window.dispatchEvent(new Event('languagechange'));expect(state.locale.value).toBe('en');state.dispose()
})
it('persists only the UI preference, leaves host language alone, and returns to automatic mode',()=>{
 localStorage.clear();const host=ref('ja'),state=createLocale({host:()=>host.value});state.set('fr');expect(host.value).toBe('ja');expect(state.locale.value).toBe('fr');expect(createLocale({host:()=>host.value,listen:false}).locale.value).toBe('fr');state.set('auto');expect(state.locale.value).toBe('ja');state.set('<invalid>');expect(state.preference.value).toBe('auto');expect(localStorage.length).toBe(1);state.dispose()
})
it('follows cross-tab preference changes and tolerates unavailable storage',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')}});const state=createLocale({host:()=> 'en'});expect(state.preference.value).toBe('auto');state.set('de');expect(state.t('Settings')).toBe('Einstellungen');window.dispatchEvent(new StorageEvent('storage',{key:'document-workflow:language',newValue:'ja'}));expect(state.locale.value).toBe('ja');state.dispose()
})
it('has identical, nonempty catalogs and preserves all named placeholders in every language',()=>{
 const keys=Object.keys(catalogs.en).sort();expect(keys.length).toBeGreaterThan(290);for(const {id} of uiLanguages){expect(Object.keys(catalogs[id]).sort()).toEqual(keys);for(const key of keys){expect(catalogs[id][key]?.trim(),`${id}: ${key}`).toBeTruthy();expect(catalogs[id][key]!.match(/\{\w+\}/g)?.sort()??[],`${id}: ${key}`).toEqual(key.match(/\{\w+\}/g)?.sort()??[])}}for(const locale of ['ja','es','fr','de'] as const)expect(catalogs[locale].Settings).not.toBe('Settings')
})
it('covers literal labels in reachable Vue interfaces and keeps unknown document content intact',()=>{
 function walk(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(row=>row.isDirectory()?walk(join(path,row.name)):row.name.endsWith('.vue')&&row.name!=='BatchReview.vue'?[join(path,row.name)]:[])}
 for(const path of walk('src')){const source=readFileSync(path,'utf8');for(const match of source.matchAll(/\bt\('([^'\n]+)'/g))expect(catalogs.en[match[1]!],`${path}: ${match[1]}`).toBeDefined()}
 const state=createLocale({listen:false});state.set('ja');expect(state.t('Invoice number: INV-42')).toBe('Invoice number: INV-42');expect(state.t('Select {name}',{name:'<img>請求書.pdf'})).toBe('<img>請求書.pdfを選択');state.dispose()
})
it('switches all five languages immediately through Settings and restores the host default without document requests',async()=>{
 localStorage.clear();const fetch=vi.fn(async(_url:string)=>Response.json({spaces:[]}));vi.stubGlobal('fetch',fetch);const host=ref('ja-JP'),router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow',component:WorkspaceShell,children:workspaceChildren}]});await router.push('/document-workflow/settings');const w=mount({setup(){provide(hostLocaleKey,()=>host.value)},template:'<RouterView />'},{global:{plugins:[router]}});await flushPromises();expect(w.get('.dw-shell').attributes('lang')).toBe('ja');for(const {id} of uiLanguages){await w.get('#ui-language').setValue(id);expect(w.get('.dw-shell').attributes('lang')).toBe(id);expect(w.get('h1').text()).toBe(catalogs[id].Settings)}await w.get('#ui-language').setValue('auto');expect(w.get('.dw-shell').attributes('lang')).toBe('ja');expect(fetch.mock.calls.map(([url])=>url)).toEqual(['/_workflow/api/spaces']);w.unmount()
})
it('changes language around an unsaved document edit without discarding values or reloading metadata/PDF',async()=>{
 localStorage.clear();const state=createLocale({listen:false}),store=createWorkspace();store.connection.value={mode:'demo',server:'test',account:'person',space:'test',name:'Test'};const request=vi.spyOn(store,'request').mockImplementation(async op=>op==='preview'?new Blob(['pdf']):{source:{path:'Inbox/test.pdf',resourceId:'id',sha256:'a'.repeat(64),etag:'v1',tags:['Keep']},schema:{fields:[{id:'invoice',label:'請求番号',type:'text',aliases:[],choices:[]}],tags:[]},record:{version:1,fields:{invoice:'INV-42'}},suggestions:{fields:{},tags:[]},pending:[]});const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/details',component:DocumentDetails}]});await router.push('/document-workflow/details?path=Inbox/test.pdf');const w=mount(DocumentDetails,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store,[localeKey as symbol]:state},stubs:{PdfPreview:true}}});await flushPromises();await w.get('[aria-label="Edit details"]').trigger('click');await w.get('#field-invoice').setValue('KEEP-DRAFT');const count=request.mock.calls.length;state.set('ja');await flushPromises();expect(w.get('#field-invoice').element).toHaveProperty('value','KEEP-DRAFT');expect(w.text()).toContain('請求番号');expect(w.text()).toContain('キャンセル');expect(request).toHaveBeenCalledTimes(count);expect(request.mock.calls.some(c=>['prepare','approve','apply','metadata-save'].includes(c[0]))).toBe(false);w.unmount();state.dispose()
})
