// SPDX-License-Identifier: AGPL-3.0-only
import type { SQLOutputValue } from 'node:sqlite'
import type { AutomaticAuthorization } from './workflow-contracts.d.mts'
import type { Automation } from './automation.mjs'
import type { MutationAdapter } from './contracts.d.mts'
export interface AutomaticRun extends Record<string, SQLOutputValue | undefined> {
  job: string
  state: string
  detail: string | null
  authorization: string
  created: string
  updated: string
}
export interface Authorization extends AutomaticAuthorization {
  configuration: ReturnType<Automation['snapshot']>
}
export interface ConversionAdapter extends MutationAdapter {
  replacePDF(path: string, bytes: Buffer, etag: string): Promise<unknown>
}
export interface ConversionRecord {
  id: string
  path: string
  target: string
  original: string
  resourceId: string
  etag: string
  sha256: string
  pdfSha256: string
  tags: string[]
  phase: string
  state: string
  pdfResourceId?: string
  layoutVersion?: number
}
export interface ReformatRecord {
  id: string
  conversionId: string
  path: string
  backup: string
  pdfResourceId: string
  etag: string
  tags: string[]
  layoutVersion?: number
  oldSha256: string
  newSha256: string
  state: string
  backupResourceId?: string
}
export interface DuplicateIntent {
  queue_id: string
  scope: string
  source: string
  keeper: string
  sha: string
  baseline: string
  state: string
  created: string
  ack: number
  trash_id: string | null
}
