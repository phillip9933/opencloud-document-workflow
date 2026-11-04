// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseSync } from 'node:sqlite'
import type { Configuration } from './configuration.mjs'

export interface Actor {
  server: string
  account: string
  space: string
  mode?: 'demo' | 'live'
}
export interface ProcessingLimits {
  maxMiB: number
  maxPages: number
  maxCharacters: number
  documentsPerCycle: number
  contextTokens: number
}
export interface ConfigurationOwner {
  db: DatabaseSync
  configuration?: Configuration
  scope(actor: Actor): string
  event(actor: Actor, job: string | null, kind: string, detail?: Record<string, unknown>): void
}
export type Logger = (event: string, error?: unknown) => void
