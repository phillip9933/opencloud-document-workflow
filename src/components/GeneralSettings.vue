<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import {uiLanguages,useLocale} from '../state/locale'
import {useTheme} from '../state/theme'
const locale=useLocale(),theme=useTheme(),{t}=locale
</script>
<template><section class="panel general-settings"><label for="ui-language">{{ t('Language') }}</label><select id="ui-language" :value="locale.preference.value" @change="locale.set(($event.target as HTMLSelectElement).value)"><option value="auto">{{ t('OpenCloud / system') }}</option><option v-for="language in uiLanguages" :key="language.id" :value="language.id">{{ language.label }}</option></select><label for="appearance-mode">{{ t('Appearance') }}</label><select id="appearance-mode" :value="theme.preference.value" @change="theme.set(($event.target as HTMLSelectElement).value)"><option value="system">{{ t('System') }}</option><option value="light">{{ t('Light') }}</option><option value="dark">{{ t('Dark') }}</option></select></section></template>
<style scoped>.general-settings{max-width:640px}.general-settings label{display:block;margin:20px 0 8px}.general-settings label:first-child{margin-top:0}.general-settings select{width:100%;max-width:360px}</style>
