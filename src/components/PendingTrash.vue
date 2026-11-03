<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {ref,onMounted} from 'vue'
import DocumentTrashButton from './DocumentTrashButton.vue'
import {useWorkspace} from '../state/workspace'
import {useLocale} from '../state/locale'
const store=useWorkspace(),{t}=useLocale(),rows=ref<{id:string;path:string}[]>([]),error=ref('')
async function load(){try{rows.value=(await store.request('document-trash-pending')).operations??[];error.value=''}catch{error.value='Could not load pending Trash operations'}}
onMounted(load)
</script>
<template><section v-if="rows.length||error" class="panel pending-trash"><h2>{{ t('Pending Trash moves') }}</h2><p v-if="error" class="error">{{ t(error) }}</p><article v-for="row in rows" :key="row.id"><span>{{ row.path }}</span><DocumentTrashButton :path="row.path" :pending-id="row.id" @trashed="load" /></article></section></template>
<style scoped>.pending-trash{padding:20px;margin-bottom:20px}.pending-trash h2{font-size:15px}.pending-trash article{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 0}.pending-trash article>span{overflow-wrap:anywhere;font-size:13px;min-width:0}</style>
