// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { handleRequest } from './http-handler.mjs'
import { logEvent } from './logging.mjs'
import { readFile } from 'node:fs/promises'
import { resolve, extname, dirname } from 'node:path'
import { AppTokenSessions } from './app-tokens.mjs'
import { SessionSupervisor } from './session.mjs'
import { BackupManager } from './backups.mjs'
import { createWorkflowAPI } from './draft-api.mjs'
import { listenAddress } from './listen.mjs'
import { healthResponse } from './health.mjs'
const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const port = Number(process.env.WORKFLOW_PORT || 5175)
const origin = process.env.WORKFLOW_APP_ORIGIN || `http://127.0.0.1:${port}`
const mode = process.env.WORKFLOW_MODE || 'demo'
if (!['demo', 'live'].includes(mode)) throw new Error('WORKFLOW_MODE must be demo or live')
const listen = listenAddress(process.env, mode)
const database =
  process.env.WORKFLOW_DB ||
  process.env.WORKFLOW_DRAFT_DB ||
  resolve('companion/state/draft.sqlite3')
let session, backups, appTokens
const api = createWorkflowAPI({
  database,
  mode,
  origin: process.env.WORKFLOW_OPENCLOUD_ORIGIN,
  space: process.env.WORKFLOW_SPACE_ID || undefined,
  ollama: process.env.WORKFLOW_OLLAMA_URL,
  cloud: process.env.WORKFLOW_CLOUD_URL,
  cloudKey: process.env.WORKFLOW_CLOUD_KEY,
  allowOrigin: origin,
  ocrDirectory: process.env.WORKFLOW_OCR_DIRECTORY,
  backgroundSession: (actor) =>
    appTokens?.status(actor) ??
    session?.status(actor) ?? { configured: false, state: 'not_configured' },
  backgroundConnect: (actor, value) => {
    if (!appTokens) throw new Error('Private background token storage is not configured')
    return appTokens.connect(actor, value)
  },
  backgroundDisconnect: (actor) => {
    if (!appTokens) throw new Error('Private background token storage is not configured')
    return appTokens.disconnect(actor)
  },
  backupStatus: () => backups?.status() ?? { configured: false, state: 'not_configured' },
  observeSession: (actor, adapter) => backups?.attach(actor, adapter),
  backupDetails: () => backups?.report() ?? { configured: false, state: 'not_configured' },
  backupConfigure: (value, actor, adapter) => {
    if (!backups) throw new Error('Backup storage is not configured')
    return backups.configureFor(actor, adapter, value)
  }
})
if (process.env.WORKFLOW_BACKUP_DIRECTORY) {
  backups = new BackupManager({
    database,
    directory: process.env.WORKFLOW_BACKUP_DIRECTORY,
    intervalMs: Number(process.env.WORKFLOW_BACKUP_INTERVAL_HOURS || 6) * 3600000,
    maxSnapshots: Number(process.env.WORKFLOW_BACKUP_MAX_SNAPSHOTS || 28),
    maxBytes: Number(process.env.WORKFLOW_BACKUP_MAX_BYTES || 1024 ** 3)
  })
}
await api.start()
const backgroundLifecycle = {
  attach: async (adapter, pin) => {
    const actor = await api.attach(adapter, pin)
    backups?.attach(actor, adapter, { background: true })
    return actor
  },
  detach: (adapter) => {
    backups?.detach(adapter)
    api.detach(adapter)
  }
}
if (mode === 'live' && process.env.WORKFLOW_APP_TOKEN_DIRECTORY) {
  appTokens = new AppTokenSessions({
    directory: process.env.WORKFLOW_APP_TOKEN_DIRECTORY,
    origin: process.env.WORKFLOW_OPENCLOUD_ORIGIN,
    excludedDirectories: [
      resolve('.'),
      dirname(resolve(database)),
      ...(process.env.WORKFLOW_BACKUP_DIRECTORY
        ? [resolve(process.env.WORKFLOW_BACKUP_DIRECTORY)]
        : [])
    ],
    ...backgroundLifecycle
  })
  await appTokens.start(process.env.WORKFLOW_SPACE_ID || undefined)
}
// An existing operator-provisioned grant can renew without an open browser.
// Authorization/consent is external; this server never requests a wider scope.
if (mode === 'live' && process.env.WORKFLOW_SESSION_FILE) {
  session = new SessionSupervisor({
    file: process.env.WORKFLOW_SESSION_FILE,
    origin: process.env.WORKFLOW_OPENCLOUD_ORIGIN,
    space: process.env.WORKFLOW_SPACE_ID,
    account: process.env.WORKFLOW_BACKGROUND_ACCOUNT,
    tokenEndpoint: process.env.WORKFLOW_TOKEN_ENDPOINT,
    clientId: process.env.WORKFLOW_CLIENT_ID,
    excludedDirectories: [resolve('.'), dirname(resolve(database))],
    ...backgroundLifecycle
  })
  await session.start()
}

await backups?.start()
const root = resolve('draft-dist'),
  types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm'
  }
const server = createServer(
  handleRequest(async (req, res) => {
    if (healthResponse(req, res, version)) return
    if (await api.handle(req, res)) return
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url, origin),
      path = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      )
    if (!path.startsWith(root + '/')) throw new Error('Path outside build')
    const data = await readFile(path)
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src blob:; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
    })
    res.end(data)
  })
)
server.listen(port, listen, () => logEvent('server_started'))
for (const name of ['SIGINT', 'SIGTERM'])
  process.on(name, () =>
    server.close(async () => {
      try {
        await appTokens?.stop()
        await session?.stop()
        await backups?.stop()
        await api.stop()
        process.exit(0)
      } catch (error) {
        logEvent('shutdown_failed', error)
        process.exit(1)
      }
    })
  )
