<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {computed} from 'vue'
import {useRoute} from '../state/navigation'
import {useLocale} from '../state/locale'
import FiledDocuments from '../components/FiledDocuments.vue'
import ReviewInbox from './ReviewInbox.vue'
const route=useRoute(),{t}=useLocale(),requestedJob=computed(()=>typeof route.value.query.job==='string')
</script>
<template><ReviewInbox v-if="requestedJob" collection="documents" /><main v-else class="screen documents-screen"><header class="screen-heading"><h1>{{ t('Documents') }}</h1></header><FiledDocuments /></main></template>
