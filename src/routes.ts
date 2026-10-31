// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRecordRaw } from 'vue-router'
export const workspaceChildren: RouteRecordRaw[] = [
  { path: '', redirect: '/document-workflow/inbox' },
  {path:'inbox',name:'inbox',component:()=>import('./views/Inbox.vue'),meta:{authContext:'user',title:'Inbox'}},
  { path: 'documents', name: 'documents', component: () => import('./views/Documents.vue'), meta: { authContext: 'user', title: 'Documents' } },
  {path:'details',name:'details',component:()=>import('./views/DocumentDetails.vue'),meta:{authContext:'user',title:'Document details'}},
  {path:'intake',name:'intake',redirect:'/document-workflow/settings/ingestion'},
  {path:'review',name:'review',redirect:to=>({path:to.query.from==='filed'?'/document-workflow/documents':'/document-workflow/inbox',query:to.query})},
  {path:'activity',name:'activity',component:()=>import('./views/Activity.vue'),meta:{authContext:'user',title:'Activity'}},
  { path: 'settings/:section(ai|automation|processing|folders|filing|ingestion|reliability|system|metadata|appearance)?', name: 'settings', component: () => import('./views/Settings.vue'), meta: { authContext: 'user', title: 'Settings' } }
]
