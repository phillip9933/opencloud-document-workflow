// SPDX-License-Identifier: AGPL-3.0-only
import type { AITask } from '../src/domain/ai.ts'
import type { DocumentInput, Policy, Review } from '../src/domain/review.ts'

export interface ModelRoute {
  provider: 'local' | 'cloud'
  endpoint: string
  model: string
}
export interface ProposalConfiguration {
  policy: Policy
  rulesOnly?: boolean
  tagDiscovery?: 'existing' | 'create'
  endpoint?: string
  model?: string
  routes?: Partial<Record<AITask, ModelRoute | null>>
  contextTokens?: number
  recipe?: string
  ocrLanguages?: string[]
  reviewRevision?: string
}
export type RoutedConfiguration = ProposalConfiguration & {
  routes: NonNullable<ProposalConfiguration['routes']>
}
export type ProposalPlanner = (
  input: DocumentInput,
  model: string,
  endpoint: string,
  fetcher?: typeof fetch,
  onResponse?: (raw: unknown) => void
) => Promise<Review>
export interface PreparationOptions {
  retry?: boolean
  planner?: ProposalPlanner | null
  cloudKey?: string
  scope?: string
  manualFallback?: boolean
  ocrAttempted?: boolean
  onProgress?: (stage: 'tagging') => void
}
export interface ProposalRow {
  id: string
  scope: string
  input: string
  configuration: string
  state: 'pending' | 'running' | 'failed' | Review['state']
  result: string | null
  raw: string | null
  error: string | null
  owner: string | null
  attempts: number
  updated: string
  pid: number | null
  host: string | null
}
