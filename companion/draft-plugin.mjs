// SPDX-License-Identifier: AGPL-3.0-only
import { localPort, runtimeMode } from './development-server.mjs'
import { resolve } from 'node:path'
import { createWorkflowAPI } from './draft-api.mjs'
/** @returns {import('vite').Plugin} */
export function draftPlugin() {
  return {
    name: 'workflow-draft',
    configureServer(server) {
      const api = createWorkflowAPI({
        database:
          process.env.WORKFLOW_DB ||
          process.env.WORKFLOW_DRAFT_DB ||
          resolve('companion/state/draft.sqlite3'),
        mode: runtimeMode(process.env.WORKFLOW_MODE),
        origin: process.env.WORKFLOW_OPENCLOUD_ORIGIN,
        space: process.env.WORKFLOW_SPACE_ID,
        ollama: process.env.WORKFLOW_OLLAMA_URL,
        cloud: process.env.WORKFLOW_CLOUD_URL,
        cloudKey: process.env.WORKFLOW_CLOUD_KEY,
        allowOrigin: () => `http://127.0.0.1:${localPort(server)}`
      })
      void api.start()
      server.httpServer?.once('close', () => void api.stop())
      server.middlewares.use(async (req, res, next) => {
        if (!(await api.handle(req, res))) next()
      })
    }
  }
}
