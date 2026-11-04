// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Actor,
  ConfigurationOwner,
  FileEntry,
  MetadataInput,
  MutationAdapter,
  Logger
} from './contracts.d.mts'
import type { Policy, ManualActions } from '../src/domain/review.ts'

export type OperationKind = 'prepare' | 'convert' | 'metadata' | 'automatic' | 'file'
export interface PrepareInput {
  path: string
  resourceId?: string
  etag?: string
  documentSpace?: string
  retry?: boolean
  cloudConsent?: boolean
  newReview?: boolean
}
export interface FileInput {
  id: string
  policy: Policy
  reviewDigest: string
  manualActions?: ManualActions
}
export type OperationRequest = { id: string } & (
  | { kind: 'prepare'; items: PrepareInput[] }
  | { kind: 'convert'; items: Record<string, unknown>[] }
  | { kind: 'metadata'; items: MetadataInput[] }
  | { kind: 'automatic'; items: { id: string }[] }
  | { kind: 'file'; items: FileInput[] }
)
export interface OperationResult {
  state?: string
  uncertain?: boolean
  id?: string
  detail?: string | null
  error?: string
  stage?: string
  startedAt?: string
  finishedAt?: string
}
export interface OperationItem {
  position: number
  input: Record<string, unknown> & Partial<PrepareInput & MetadataInput & FileInput>
  state: string
  result: OperationResult | null
}
export interface OperationRecord {
  id: string
  kind: OperationKind
  state: string
  created: string
  updated: string
  items: OperationItem[]
}
export interface OperationAdapter extends MutationAdapter {
  identity(): Promise<Actor>
}
export interface OperationOwner extends ConfigurationOwner {
  lock(id: string): () => void
  intake: { paused(actor: Actor): boolean }
  transfers: {
    adapter(actor: Actor, api: OperationAdapter, space: string): Promise<OperationAdapter>
  }
  automation: { run(actor: Actor, api: OperationAdapter, id: string): Promise<OperationResult> }
  decision(actor: Actor, id: string): { record: string } | undefined
  approve(
    actor: Actor,
    api: OperationAdapter,
    id: string,
    policy: Policy,
    digest: string,
    manual?: ManualActions
  ): Promise<unknown>
  apply(actor: Actor, api: OperationAdapter, id: string): Promise<OperationResult>
}
export interface OperationOptions {
  prepare(
    actor: Actor,
    api: OperationAdapter,
    path: string,
    options: {
      retry: boolean
      cloudConsent: boolean
      newReview: boolean
      expectedResourceId?: string
      expectedEtag?: string
      onProgress(stage: string): void
    }
  ): Promise<OperationResult>
  metadata?: {
    save(actor: Actor, api: OperationAdapter, input: MetadataInput): Promise<OperationResult>
  }
  convert?: (
    actor: Actor,
    api: OperationAdapter,
    input: Record<string, unknown>
  ) => Promise<OperationResult>
  session?: (actor: Actor) => OperationAdapter | undefined
  invalidateSession?: (api: OperationAdapter) => void
  logger?: Logger
}
export type CurrentFiles = Pick<FileEntry, 'path' | 'resourceId' | 'etag'>[] | null
