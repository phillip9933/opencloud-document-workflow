<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import SpaceSelector from './SpaceSelector.vue'
import IntakeSettings from '../views/Intake.vue'
import FilingSettings from './FilingSettings.vue'
import {useLocale} from '../state/locale'
const {t}=useLocale()
</script>
<template><section class="folder-settings"><section class="panel folder-source"><h2>{{ t('Inbox') }}</h2><p>{{ t('Add new documents here. They wait for review or automatic filing.') }}</p><SpaceSelector label="Inbox Space" /><IntakeSettings /></section><section class="panel folder-destination"><h2>{{ t('Filed documents') }}</h2><p>{{ t('Filed documents move here. Filing patterns organize them into subfolders.') }}</p><FilingSettings /></section></section></template>
<style scoped>
.folder-settings{max-width:900px}.folder-source,.folder-destination{padding:24px;border-radius:9px}.folder-source>h2,.folder-destination>h2{font-size:16px;font-weight:650;color:var(--ink)}.folder-source{margin-bottom:24px}.folder-source>p,.folder-destination>p{font-size:13px;margin:6px 0 0}.folder-source :deep(.space-selector){margin:22px 0 0}.folder-source :deep(.intake-settings){margin-top:20px}.folder-destination :deep(.filing-settings){margin-top:22px;padding:0;border:0;border-radius:0;background:transparent}
@media(max-width:700px){.folder-source,.folder-destination{padding:20px}}
</style>
