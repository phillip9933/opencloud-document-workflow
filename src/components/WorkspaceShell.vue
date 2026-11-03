<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { provide, inject, onMounted, ref, watch, nextTick }  from 'vue'
import { createWorkspace, workspaceKey, sessionTokenKey, workspaceHostKey } from '../state/workspace'
import '../styles.css'
import '../theme.css'
import {useRoute} from '../state/navigation'
import {provideLocale} from '../state/locale'
import {provideTheme} from '../state/theme'
import {version as appVersion,releaseChannel} from '../../package.json'
const theme=provideTheme(),locale=provideLocale(),{t}=locale
const page=ref<HTMLElement|null>(null),route=useRoute()
watch(()=>route.value.fullPath,async()=>{await nextTick();page.value?.scrollTo?.({top:0})})
const token=inject(sessionTokenKey,()=>''),store=createWorkspace(token,inject(workspaceHostKey,undefined))
onMounted(async()=>{try{await store.loadSpaces()}catch{};if(token()||store.spaces.value.length)try{await store.connect();await store.refresh()}catch{/* Connection errors are shown in the workspace. */}})
provide(workspaceKey, store)
</script>
<template>
  <div class="dw-shell" :lang="locale.locale.value" :data-theme="theme.effective.value" :data-appearance="theme.preference.value">
    <aside class="dw-sidebar">
      <div class="brand"><strong>Document Workflow</strong></div>
      <nav :aria-label="t('Navigation')">
        <RouterLink :class="{'router-link-active':route.path.endsWith('/details')&&route.query.return!=='filed'}" to="/document-workflow/inbox">{{ t('Inbox') }}</RouterLink>
        <RouterLink :class="{'router-link-active':route.path.endsWith('/details')&&route.query.return==='filed'}" to="/document-workflow/documents">{{ t('Documents') }}</RouterLink>
        <RouterLink to="/document-workflow/activity">{{ t('Activity') }}</RouterLink>
        <RouterLink to="/document-workflow/settings">{{ t('Settings') }}</RouterLink>
      </nav>
      <footer class="sidebar-footer"><span v-if="store.connection.value?.mode === 'demo'">{{ t('Demo') }}</span><span class="app-version">v{{ appVersion }}<template v-if="releaseChannel==='beta'"> · {{ t('Beta') }}</template></span></footer>
    </aside>
    <div ref="page" class="dw-content" tabindex="0" :aria-label="t('Document workspace')"><RouterView :key="store.connection.value ? JSON.stringify([store.connection.value.server,store.connection.value.account,store.connection.value.space]) : 'connecting'" /></div>
  </div>
</template>
<style scoped>
.dw-sidebar>.sidebar-footer{display:flex;flex-direction:column;gap:4px;flex:none}.app-version{font-variant-numeric:tabular-nums;line-height:1.4}
@media(max-width:700px){.dw-shell>.dw-sidebar{max-height:none}.dw-sidebar>.sidebar-footer{flex-direction:row;margin-top:0;padding:10px 0 0;gap:12px}}
</style>
