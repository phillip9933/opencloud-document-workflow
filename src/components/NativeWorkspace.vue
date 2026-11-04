<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { useGettext } from 'vue3-gettext'
import { hostLocaleKey } from '../state/locale'
import { provide } from 'vue'
import {
  useAuthStore,
  useSpacesStore,
  createLocationSpaces,
  createFileRouteOptions
} from '@opencloud-eu/web-pkg'
import { sessionTokenKey, workspaceHostKey } from '../state/workspace'
import WorkspaceShell from './WorkspaceShell.vue'
const auth = useAuthStore(),
  spaces = useSpacesStore(),
  language = useGettext()
provide(hostLocaleKey, () => language.current)
provide(workspaceHostKey, {
  spaceName: (id) => spaces.getSpace(id)?.name || '',
  folderLocation: (id, path) => {
    const space = spaces.getSpace(id)
    return space
      ? createLocationSpaces(
          'files-spaces-generic',
          createFileRouteOptions(space, { path: '/' + path })
        )
      : undefined
  }
})
provide(sessionTokenKey, () => auth.accessToken)
</script>
<template><WorkspaceShell :key="auth.sessionId || 'signed-in-session'" /></template>
