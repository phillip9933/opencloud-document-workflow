// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor, Logger } from './contracts.d.mts'
import type { ServiceAdapter } from './api-contracts.d.mts'
export interface SessionHooks {
  attach(api: ServiceAdapter, pin: { account: string }): Promise<Actor>
  detach(api: ServiceAdapter): void | Promise<void>
}
export interface AppTokenRecord {
  version: 1
  server: string
  account: string
  username: string
  appToken: string
}
export interface AppTokenEntry {
  value: AppTokenRecord
  space: string
  api: ServiceAdapter | null
  health: { state: string; lastSuccess: number | null; reason?: string }
  nextAttempt: number
}
export interface AppTokenOptions extends SessionHooks {
  directory?: string
  origin: string
  excludedDirectories?: string[]
  now?: () => number
  logger?: Logger
  adapterFactory?: (options: {
    origin: string
    space: string
    username: string
    appToken: string
  }) => ServiceAdapter
}
export interface SessionValue {
  version: number
  access_token: string
  expires_at: number | null
  refresh_token?: string
  client_secret?: string
}
export interface SessionRecord {
  value: SessionValue
  hash: string
  legacy: boolean
}
export interface SessionOptions extends SessionHooks {
  file: string
  origin: string
  space: string
  account?: string
  tokenEndpoint?: string
  clientId?: string
  excludedDirectory?: string
  excludedDirectories?: string[]
  fetcher?: typeof fetch
  adapterFactory?: (options: { origin: string; space: string; token: string }) => ServiceAdapter
  now?: () => number
  intervalMs?: number
  logger?: Logger
}
export interface BackupDestination {
  server: string
  account: string
  space: string
  folder: string
}
export interface BackupSettings {
  enabled: boolean
  intervalMinutes: number
  maxSnapshots: number
  maxMiB: number
  destination?: BackupDestination
}
export interface BackupManifest {
  version: number
  created: string
  database: string
  sha256: string
  bytes: number
  schemaHash: string
  counts: Record<string, number>
  node: string
}
export interface BackupResult extends BackupManifest {
  directory?: string
  storage?: string
  path?: string
}
export interface BackupIntent {
  state: string
  stage: string
  manifest: BackupManifest
  destination: BackupDestination
  name: string
  databaseIntent: boolean
  manifestIntent: boolean
}
export interface BackupAdapter extends ServiceAdapter {
  put(
    path: string,
    bytes: Buffer,
    options?: { contentType: string }
  ): Promise<{ resourceId: string }>
  putFile?(path: string, file: string, options: { contentType: string }): Promise<unknown>
  digest?(path: string, etag: string, limit: number): Promise<{ bytes: number; sha256: string }>
  forSpace(space: string): BackupAdapter
}
export interface BackupOptions {
  database: string
  directory: string
  intervalMs?: number
  maxSnapshots?: number
  maxBytes?: number
  now?: () => number
  copy?: typeof import('node:sqlite').backup
  logger?: Logger
}

export interface BackupUploadItem {
  suffix: string
  file?: string
  bytes?: Buffer
  size: number
  sha: string
  type: string
  key: 'databaseIntent' | 'manifestIntent'
}
