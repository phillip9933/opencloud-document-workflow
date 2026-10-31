<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,onMounted} from 'vue'
import {useLocale} from '../state/locale'
const {t,formatDate}=useLocale()
import {useRouter} from '../state/navigation'
import {useWorkspace} from '../state/workspace'
const store=useWorkspace(),router=useRouter(),operations=ref<any[]>([]),active=ref<any>(null),error=ref('')
async function load(){try{operations.value=(await store.request('operations')).operations??[]}catch(e){error.value=e instanceof Error?e.message:'Could not load operations'}}
async function open(id:string){try{active.value=await store.request('operation',{id})}catch(e){error.value=e instanceof Error?e.message:'Could not load results'}}
async function inspect(item:any){try{if(item.input.id){await store.openJob(item.input.id);await router.push({path:'/document-workflow/review',query:{job:item.input.id}})}else await router.push({path:'/document-workflow/details',query:{path:item.input.path}})}catch(e){error.value=e instanceof Error?e.message:'Could not open the document'}}
async function resume(){try{await store.request('operation-resume',{id:active.value.id});await open(active.value.id);await load()}catch(e){error.value=e instanceof Error?e.message:'Could not resume queued work'}}
onMounted(():void=>{void load()})
</script>
<template><section class="panel operation-history"><div class="list-heading"><h2>{{ t('Bulk operations') }}</h2><button class="button" @click="load">{{ t('Refresh') }}</button></div><ul><li v-for="operation in operations" :key="operation.id"><button class="button subtle" @click="open(operation.id)">{{ formatDate(operation.created) }} · {{ t(operation.kind) }} · {{ t(operation.state) }}</button></li></ul><p v-if="!operations.length" class="empty-state">{{ t('No bulk operations') }}</p><section v-if="active"><div class="list-heading"><h3>{{ t(active.kind) }} · {{ t(active.state) }}</h3><button class="button" @click="open(active.id)">{{ t('Refresh') }}</button></div><button v-if="active.items.some((i:any)=>i.state==='queued')" class="button" @click="resume">{{ t('Resume queued documents') }}</button><article v-for="item in active.items" :key="item.position"><button class="document-link" @click="inspect(item)">{{ item.input.path?.split('/').pop()||item.input.id.slice(0,12) }}</button><span class="pill">{{ t(item.state) }}</span><p v-if="item.result?.error||item.result?.detail">{{ t(item.result.error||item.result.detail) }}</p><details><summary>{{ t('Recorded result') }}</summary><pre>{{ JSON.stringify(item.result,null,2) }}</pre></details></article></section><p v-if="error" role="alert" class="error">{{ t(error) }}</p></section></template>
<style scoped>summary{cursor:pointer;color:var(--accent-text);padding:8px 0}h3{font-size:14px}article{padding:12px 0;border-top:1px solid var(--line);font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap}ul{padding-left:12px;list-style:none}</style>
