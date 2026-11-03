// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from 'node:crypto'
import {mount,flushPromises} from '@vue/test-utils'
import {createRouter,createMemoryHistory} from 'vue-router'
import DocumentDetails from '../../src/views/DocumentDetails.vue'
import {createWorkspace,workspaceKey} from '../../src/state/workspace'
it('replaces the visible PDF after recreation while retaining a preview when the bytes stay unchanged',async()=>{
 const store=createWorkspace();store.connection.value={mode:'demo',server:'test',account:'test',space:'test',name:'test'};let recreated=false
 const body=()=>recreated?'new readable spreadsheet PDF':'old PDF',metadata=()=>({conversion:{conversionId:'converted',archivePath:'Archive/test.xlsx'},source:{path:'Inbox/test.xlsx.pdf',resourceId:'same-file',etag:recreated?'v2':'v1',sha256:createHash('sha256').update(body()).digest('hex'),tags:[] as string[]},schema:{fields:[] as never[],tags:[] as string[]},record:{version:0,fields:{}},suggestions:{fields:{},tags:[] as string[]},pending:[] as never[]})
 const request=vi.spyOn(store,'request').mockImplementation(async operation=>{if(operation==='metadata')return metadata();if(operation==='preview')return new Blob([body()]);if(operation==='conversion-reformat'){recreated=true;return{state:'done',path:'Inbox/test.xlsx.pdf'}}throw Error(operation)})
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/document-workflow/details',component:DocumentDetails}]});await router.push('/document-workflow/details?path=Inbox/test.xlsx.pdf');await router.isReady()
 const view=mount(DocumentDetails,{global:{plugins:[router],provide:{[workspaceKey as symbol]:store},stubs:{PdfPreview:{props:['data'],template:'<div data-test="pdf">{{ data.size }}</div>'}}}})
 try{await flushPromises();await vi.waitFor(()=>expect(view.get('[data-test="pdf"]').text()).toBe(String('old PDF'.length)));await view.findAll('button').find(button=>button.text()==='Recreate PDF')!.trigger('click');await flushPromises();await vi.waitFor(()=>expect(view.get('[data-test="pdf"]').text()).toBe(String('new readable spreadsheet PDF'.length)));expect(request.mock.calls.filter(call=>call[0]==='preview')).toHaveLength(2);await view.findAll('button').find(button=>button.text()==='Recreate PDF')!.trigger('click');await flushPromises();expect(request.mock.calls.filter(call=>call[0]==='preview')).toHaveLength(2)}finally{view.unmount()}
})
