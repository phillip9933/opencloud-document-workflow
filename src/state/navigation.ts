// SPDX-License-Identifier: AGPL-3.0-only
import { getCurrentInstance } from 'vue'
import type { Router } from 'vue-router'
// Match the host SDK's $router/currentRoute bridge. Router injection symbols
// belong to the host; bundling another vue-router creates incompatible symbols.
export function useRouter(): Router {
  const router = getCurrentInstance()?.proxy?.$router
  if (!router) throw new Error('Document Workflow requires its host router')
  return router
}
export function useRoute() {
  return useRouter().currentRoute
}
