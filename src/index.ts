// Adapted from OpenCloud web-app-skeleton; see THIRD_PARTY_NOTICES.md
import {
  defineWebApplication,
  ApplicationSetupOptions,
  Extension,
  AppMenuItemExtension
} from '@opencloud-eu/web-pkg'
import { urlJoin } from '@opencloud-eu/web-client'
import '@opencloud-eu/extension-sdk/tailwind.css'
import type { RouteRecordRaw } from 'vue-router'
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import { workspaceChildren } from './routes'

export default defineWebApplication({
  setup(args) {
    const { $gettext } = useGettext()

    const appInfo = {
      id: 'document-workflow',
      name: $gettext('Document Workflow'),
      icon: 'file-text',
      color: '#21665b'
    }

    const routes: RouteRecordRaw[] = [{
      path: '/',
      component: () => import('./components/NativeWorkspace.vue'),
      meta: { authContext: 'user' },
      children: workspaceChildren
    }]

    const extensions = ({ applicationConfig }: ApplicationSetupOptions) => {
      return computed<Extension[]>(() => {
        const menuItems: AppMenuItemExtension[] = [
          {
            // registers a menu item for the app switcher
            id: `app.${appInfo.id}.menuItem`,
            type: 'appMenuItem',
            label: () => appInfo.name,
            color: appInfo.color,
            icon: appInfo.icon,
            path: urlJoin(appInfo.id)
          }
        ]
        return [...menuItems]
      })
    }

    return {
      appInfo,
      routes,
      extensions: extensions(args)
    }
  }
})
