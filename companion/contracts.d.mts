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

export interface SimilarityReader extends DocumentReader {
  forSpace(space: string): SimilarityReader
}
export interface SimilarityOwner extends ConfigurationOwner {
  similarities?: import('./similarity.mjs').SimilarDocuments
  job(actor: Actor, id: string): { input: string }
  location(
    actor: Actor,
    api: SimilarityReader,
    id: string
  ): Promise<{ space: string; path: string; etag: string; resourceId: string }>
}

export interface MetadataAdapter extends DocumentReader {
  listTags(): Promise<string[]>
  addTags(resource: string, tags: string[]): Promise<unknown>
  removeTags(resource: string, tags: string[]): Promise<unknown>
}
export interface MetadataOwner extends ConfigurationOwner {
  metadata?: import('./metadata.mjs').Metadata
  transfers?: { canonical(actor: Actor, resource: string, space?: string): string }
  documentTrash?: {
    pending(actor: Actor, resource: string): { id: string } | null
    assertAvailable(actor: Actor, resource: string): void
  }
  preference(actor: Actor): { policy: import('../src/domain/review.ts').Policy } | null
  lock(key: string): () => void
}
export interface MetadataInput {
  path: string
  resourceId: string
  etag: string
  sha256: string
  version: number
}
export interface MetadataRecord {
  version: number
  fields: Record<string, string | number>
  updated?: string
}
export interface MetadataChange {
  id: string
  scope: string
  resource: string
  path: string
  sha: string
  etag: string
  base: number
  fields: string
  tags: string
  state: string
  created: string
}

export interface TrashEntry {
  id: string
  path: string
  resourceId?: string
  size: number
  folder: boolean
}
export interface MutationAdapter extends MetadataAdapter, FilingAdapter {
  space: string
  identity(): Promise<Actor>
  forSpace?(space: string): MutationAdapter
  put(path: string, bytes: Buffer): Promise<{ resourceId: string }>
  listTrash(): Promise<TrashEntry[]>
  trash(path: string, etag: string): Promise<unknown>
}
export interface TransferPlan extends FilingPlan {
  targetResource?: string
}
export interface TransferApproval {
  source: import('../src/domain/review.ts').Source
  actions: { targetSpace: string; target: string; addTags: string[] }
}
export interface MutationOwner extends ConfigurationOwner {
  configuration: Configuration
  transfers: import('./transfers.mjs').Transfers
  documentTrash?: import('./document-trash.mjs').DocumentTrash
  metadata?: import('./metadata.mjs').Metadata
  automation?: object
  conversions?: object
  intake?: { configuration(actor: Actor): { folder: string } }
  lock(key: string): () => void
  job(actor: Actor, id: string): { id: string }
  decision(actor: Actor, id: string): { state: string } | null
  location(actor: Actor, api: MutationAdapter, id: string): Promise<FileEntry & { space: string }>
  check(
    api: MutationAdapter,
    path: string,
    source: { resourceId: string; sha256: string },
    etag?: string,
    actor?: Actor
  ): Promise<(FileEntry & { size: number }) | null>
  set(actor: Actor, id: string, state: string, plan: TransferPlan): void
}
export interface TransferRow {
  job: string
  scope: string
  source: string
  target_space: string
  target_path: string
  state: string
  resource: string | null
  baseline: string
  trash_ack: number
}
export interface TrashRow {
  id: string
  scope: string
  resource: string
  source: string
  sha: string
  baseline: string
  state: string
  created: string
  ack: number
  trash_id: string | null
}
export interface TrashInput {
  id: string
  path: string
  resourceId: string
  etag: string
  sha256: string
  documentSpace?: string
  job?: string
}
