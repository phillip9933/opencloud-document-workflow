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

export interface FileEntry {
  path: string
  resourceId: string
  etag: string
  tags: string[]
  folder?: boolean
}
export interface FileReader {
  stat(path: string): Promise<FileEntry | null>
  list(path: string): Promise<FileEntry[]>
}
export interface FilingAdapter {
  stat(path: string): Promise<FileEntry | null>
  mkdir(path: string): Promise<unknown>
  move(source: string, target: string, etag: string): Promise<unknown>
  addTags(resource: string, tags: string[]): Promise<unknown>
}
export interface FilingPlan {
  originalTags: string[]
  expectedTags: string[]
}
export type FilingState =
  'approved' | 'folders_pending' | 'move_intent' | 'move_done' | 'tags_intent' | 'done' | 'conflict'
export interface FilingOutcome {
  state: FilingState
  target: string
  tags?: string[]
  uncertain?: boolean
  verification?: { checkedAt: string; resourceId: string; sha256: string }
}
export type FilingStep = FilingOutcome | { next: FilingState }
export interface FilingContext {
  api: FilingAdapter
  source: import('../src/domain/review.ts').Source
  target: string
  tags: string[]
  state: string
  plan: FilingPlan
  reconcileOnly: boolean
  check(
    api: FilingAdapter,
    path: string,
    source: import('../src/domain/review.ts').Source,
    etag?: string
  ): Promise<FileEntry | null>
  guard(): void
  save(state: FilingState, plan: FilingPlan): void
  event(kind: string, detail?: Record<string, unknown>): void
}

export interface LocationContext {
  scope: string
  space: string
  root: string
}
export interface LocationSnapshot extends LocationContext {
  resources: Map<string, FileEntry & { space: string }>
}
export interface LocationOwner extends ConfigurationOwner {
  configuration: Configuration
  locations?: import('./locations.mjs').FiledLocations
  transfers: { adapter(actor: Actor, api: FileReader, space: string): Promise<FileReader> }
}

export interface DocumentReader extends FileReader {
  space?: string
  get(path: string, etag?: string, limit?: number): Promise<Buffer>
}
export interface DocumentReadOptions {
  actor: Actor
  api: DocumentReader
  path: string
  before: FileEntry
  configuration: { policy: import('../src/domain/review.ts').Policy; ocrLanguages?: string[] }
  limits?: ProcessingLimits
  progress(stage: 'ocr'): void
  onOCR(source: import('../src/domain/review.ts').Source): void
}
