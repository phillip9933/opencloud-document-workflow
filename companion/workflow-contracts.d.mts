// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor, FileEntry, MutationAdapter } from './contracts.d.mts'
import type { Policy, Bundle, createApproval } from '../src/domain/review.ts'
import type { AIConfig } from '../src/domain/ai.ts'
import type { SQLOutputValue } from 'node:sqlite'
export type { Actor, FileEntry, MutationAdapter } from './contracts.d.mts'
export interface Preferences {
  policy: Policy
  ai: AIConfig
}
export interface PageOptions {
  limit?: number
  cursor?: unknown
}
export interface JobOptions extends PageOptions {
  id?: string | null
  activeOnly?: boolean
}
export type ProcessingStage = 'reading' | 'ocr' | 'analysing' | 'tagging'
export interface PrepareOptions {
  retry?: boolean
  newReview?: boolean
  cloudKey?: string
  expectedResourceId?: string
  expectedEtag?: string
  onProgress?: (stage: ProcessingStage) => void
}
export interface AutomaticAuthorization {
  kind: 'automatic'
  hash: string
  configuration: unknown
  account: string
  space: string
  authorizedAt: string
}
export type HumanApproval = Awaited<ReturnType<typeof createApproval>>
export type RecordedApproval = Omit<HumanApproval, 'reviewedAt'> & {
  reviewedAt?: string
  automaticAuthorization?: AutomaticAuthorization
  authorizedAt?: string
}
export interface DecisionRow {
  job: string
  actor: string
  record: string
  state: string
  plan: string | null
  updated: string
}
export interface JobListRow extends Record<string, SQLOutputValue | undefined> {
  id: string
  state: string
  attempts: number
  result: string | null
  sourceInput: string
  error: string | null
  updated: string
  decision: string | null
  approval: string | null
}
export interface ActivityRow extends Record<string, SQLOutputValue | undefined> {
  seq: number
  job: string | null
  kind: string
  detail: string
  created: string
}
export interface FileLocationRow {
  path: string
  space: string
  target_resource: string
}
export interface AutomationStatus {
  state: string
  detail?: string | null
}
export interface WorkflowServices {
  similarities: import('./similarity.mjs').SimilarDocuments
  configuration: import('./configuration.mjs').Configuration
  metadata: import('./metadata.mjs').Metadata
  documentTrash: import('./document-trash.mjs').DocumentTrash
  transfers: import('./transfers.mjs').Transfers
  locations: import('./locations.mjs').FiledLocations
  automation: Pick<import('./automation.mjs').Automation, 'statusFor' | 'run' | 'guard'>
  intake: { paused(actor: Actor): boolean; configuration(actor: Actor): IntakeConfiguration }
  conversions: { association(actor: Actor, resource: string): unknown }
}
export interface PreparationResult {
  id: string
  bundle: Bundle
  cached: boolean
}
export interface IntakeSession {
  actor: Actor
  api: MutationAdapter
}
export type IntakeConfiguration = ReturnType<typeof import('./intake-policy.mjs').defaultIntake>
export interface IntakeOptions {
  logger?: import('./contracts.d.mts').Logger
  prepare?(
    actor: Actor,
    api: MutationAdapter,
    path: string,
    options: { retry: boolean; cloudConsent: boolean; onProgress(stage: ProcessingStage): void }
  ): Promise<{ id: string }>
  processPrepared?: (
    actor: Actor,
    api: MutationAdapter,
    id: string,
    options: { retry: boolean; allowPaused: boolean }
  ) => Promise<unknown>
  resume?: (actor: Actor, api: MutationAdapter) => Promise<unknown>
  now?: () => number
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}
export interface ManualCheck {
  state: string
  configuration: string
  cohort: string[] | null
  timer?: ReturnType<typeof setTimeout>
}
export interface IntakeRecord extends Record<string, SQLOutputValue | undefined> {
  id: string
  resource: string
  path: string
  etag: string
  state: string
  job: string | null
  decision?: string | null
  proposalState?: string | null
  automaticState?: string | null
}
export interface IntakeQueueRow extends IntakeRecord {
  attempts: number
  first_seen: number
  next_attempt: number
  last_seen: string
  stage: string | null
  detail: string | null
  issue: string | null
}
export interface IntakeStatusRow extends IntakeRecord {
  attempts: number
  firstSeen: number
  stage: string | null
  detail: string | null
}
export interface IntakeHealth extends Record<string, SQLOutputValue> {
  lastAttempt: number | null
  lastSuccess: number | null
  reason: string | null
  message: string | null
}
export type InboxCurrentFile = FileEntry &
  Parameters<typeof import('./inbox.mjs').inboxSummary>[0][number]

export interface PreparationAttempt {
  scope: string
  space: string
  resource: string
  owner: string
}
