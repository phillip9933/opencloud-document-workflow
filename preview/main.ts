// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import WorkspaceShell from '../src/components/WorkspaceShell.vue'
import { workspaceChildren } from '../src/routes'
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/document-workflow/inbox' },
    { path: '/document-workflow', component: WorkspaceShell, children: workspaceChildren }
  ]
})
createApp(RouterView).use(router).mount('#app')
