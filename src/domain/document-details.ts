// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataSchema } from './metadata'
import type { ProcessingIssueInfo } from './processing'
export type Suggestion = { value: string | number; evidence: { page: number; quote: string }[] }
export interface DocumentDetail {
  filedJob?: string | null
  trash?: { id: string } | null
  conversion?: {
    conversionId: string
    archivePath: string
    originalResourceId: string
    originalSha256: string
    space: string
  } | null
  processingIssue?: ProcessingIssueInfo | null
  source: {
    space?: string
    path: string
    resourceId: string
    etag: string
    sha256: string
    tags: string[]
  }
  schema: MetadataSchema
  record: { version: number; fields: Record<string, string | number> }
  suggestions: { fields: Record<string, Suggestion>; tags: Suggestion[] }
  pending: { id: string; state: string }[]
}

export interface MetadataMutationResult {
  state: string
  uncertain?: boolean
  source?: DocumentDetail['source']
  record?: DocumentDetail['record']
}
