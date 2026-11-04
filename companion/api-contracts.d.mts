// SPDX-License-Identifier: AGPL-3.0-only
import type { ServerResponse } from 'node:http'
import type { Actor, MutationAdapter } from './contracts.d.mts'
import type { InboxCurrentFile } from './workflow-contracts.d.mts'
export interface APIContext {
  actor: Actor
  api: MutationAdapter
  body: Record<string, unknown>
  res: ServerResponse
}
export type APIRoute = (context: APIContext) => Promise<boolean>
export type QueueAction = 'pause' | 'resume' | 'retry' | 'cancel'
export interface QueueRouteServices {
  workflow: import('./workflow.mjs').Workflow
  intake: import('./intake.mjs').Intake
  operations: import('./operations.mjs').Operations
  duplicates: {
    record(actor: Actor, id: string): unknown
    action(actor: Actor): string
    save(actor: Actor, action: 'keep' | 'trash', folder: string): unknown
  }
  configurationStore: import('./configuration.mjs').Configuration
  readCurrentInbox(actor: Actor, api: MutationAdapter): Promise<InboxCurrentFile[]>
  backgroundSession(actor: Actor): unknown
  languages(actor: Actor): string[]
  local: string | null
  cloudBase: string | null
  cloudKey?: string
  send(response: ServerResponse, status: number, body: unknown): void
}

export interface ServiceAdapter extends MutationAdapter {
  forSpace(space: string): ServiceAdapter
  accountIdentity?(): Promise<Actor>
  spaces(): Promise<Array<{ id: string; name: string; type: string }>>
  isAdministrator?(): Promise<boolean>
  replacePDF(path: string, bytes: Buffer, etag: string): Promise<unknown>
  addScannedFixture?(): { path: string; resourceId: string }
}
export interface FullAPIContext extends APIContext {
  api: ServiceAdapter
  documentAPI: MutationAdapter
  operation: string
}
export type FullAPIRoute = (context: FullAPIContext) => Promise<boolean>
export interface APIOptions {
  database: string
  logger?: import('./contracts.d.mts').Logger
  mode?: 'demo' | 'live'
  origin?: string
  space?: string
  ollama?: string
  cloud?: string
  cloudKey?: string
  allowOrigin: string | (() => string)
  backgroundConnect?: (
    actor: Actor,
    input: { username: string; appToken: string }
  ) => Promise<unknown>
  backgroundDisconnect?: (actor: Actor) => Promise<unknown>
  backgroundSession?: (actor: Actor) => Record<string, unknown>
  backupStatus?: () => Record<string, unknown>
  backupDetails?: (
    actor: Actor,
    api: ServiceAdapter
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  backupConfigure?: (
    settings: unknown,
    actor: Actor,
    api: ServiceAdapter
  ) => Promise<Record<string, unknown>>
  observeSession?: (actor: Actor, api: ServiceAdapter) => void
  ocrDirectory?: string
  ocrPackOptions?: import('./ocr-packs.mjs').PackOptions
  adapterFactory?: (options: { origin: string; space: string; token: string }) => ServiceAdapter
}
export interface RouteServices {
  workflow: import('./workflow.mjs').Workflow
  metadata: import('./metadata.mjs').Metadata
  documents: import('./documents.mjs').DocumentLibrary
  journal: import('./journal.mjs').ProposalJournal
  intake: import('./intake.mjs').Intake
  automation: import('./automation.mjs').Automation
  conversions: import('./conversions.mjs').Conversions
  operations: import('./operations.mjs').Operations
  duplicates: import('./duplicates.mjs').Duplicates
  transfers: import('./transfers.mjs').Transfers
  similarities: import('./similarity.mjs').SimilarDocuments
  documentTrash: import('./document-trash.mjs').DocumentTrash
  configurationStore: import('./configuration.mjs').Configuration
  packs: import('./ocr-packs.mjs').OCRPacks
  demo: import('./demo.mjs').DemoAdapter | null
  local: string | null
  cloudBase: string | null
  cloudKey?: string
  send: QueueRouteServices['send']
  languages: QueueRouteServices['languages']
  describeFilesForActor(
    actor: Actor,
    listing: import('./contracts.d.mts').FileEntry[]
  ): InboxCurrentFile[]
  prepare(
    actor: Actor,
    api: MutationAdapter,
    path: string,
    options?: import('./workflow-contracts.d.mts').PrepareOptions & { cloudConsent?: boolean }
  ): ReturnType<import('./workflow.mjs').Workflow['prepare']>
  backgroundConnect: APIOptions['backgroundConnect']
  backgroundDisconnect: APIOptions['backgroundDisconnect']
  backgroundSession: NonNullable<APIOptions['backgroundSession']>
  backupDetails: NonNullable<APIOptions['backupDetails']>
  backupStatus: NonNullable<APIOptions['backupStatus']>
  backupConfigure: APIOptions['backupConfigure']
}
