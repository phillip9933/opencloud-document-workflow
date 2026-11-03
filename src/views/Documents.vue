<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed,watch} from 'vue'
import {useRoute,useRouter} from '../state/navigation'
import {useLocale} from '../state/locale'
import LibraryFiles from '../components/LibraryFiles.vue'
import ReviewInbox from './ReviewInbox.vue'
const route=useRoute(),router=useRouter(),{t}=useLocale(),requestedJob=computed(()=>typeof route.value.query.job==='string')
watch(()=>[route.value.query.view,requestedJob.value],([value,job])=>{if(value==='filed'&&!job)void router.replace({path:'/document-workflow/activity',query:{view:'filing'}})},{immediate:true})
</script>
<template><ReviewInbox v-if="requestedJob" collection="documents" /><main v-else class="screen documents-screen"><header class="screen-heading"><h1>{{ t('Documents') }}</h1></header><LibraryFiles /></main></template>
