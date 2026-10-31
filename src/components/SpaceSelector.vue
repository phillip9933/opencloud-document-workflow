<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {onMounted} from 'vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
import {useRouter,useRoute} from '../state/navigation'
const props=defineProps<{label?:string}>()
const store=useWorkspace(),router=useRouter(),route=useRoute(),{t}=useLocale()
onMounted(async()=>{try{await store.loadSpaces();if(store.spaces.value.length&&!store.connection.value)await store.connect()}catch{/* The workspace shows its connection or directory error. */}})
async function select(event:Event){try{await store.switchSpace((event.target as HTMLSelectElement).value);await router.push(route.value.path.includes('/settings')?route.value.path:route.value.path.includes('/inbox')||route.value.path.includes('/review')?'/document-workflow/inbox':'/document-workflow/documents')}catch{/* Show the scoped access error. */}}
</script>
<template><section class="space-selector" :aria-label="t('Space')"><label for="workspace-space">{{ t(props.label||'Space') }}</label><select id="workspace-space" :value="store.activeSpace.value||store.connection.value?.space||''" :disabled="store.switchingSpace.value" @change="select"><option value="" disabled>{{ t('Choose a Space') }}</option><option v-for="space in store.spaces.value" :key="space.id" :value="space.id">{{ space.name }}{{space.type==='personal'?' · '+t('Personal'):''}}</option></select><p v-if="store.spaceError.value" role="alert">{{ t(store.spaceError.value) }} <button type="button" @click="store.loadSpaces().catch(()=>{})">{{ t('Retry') }}</button></p></section></template>
<style scoped>.space-selector{margin:0 10px 18px}.space-selector label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}.space-selector select{width:100%;min-width:0;background:var(--surface);border:1px solid var(--input-border);color:var(--ink);padding:8px;border-radius:6px;font:inherit;font-size:12px}.space-selector p{font-size:11px;color:var(--danger-ink)}@media(max-width:700px){.space-selector{margin:0 0 12px}.space-selector select{max-width:100%;font-size:12px}}</style>
