// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Actor,
  MutationAdapter,
  MutationOwner,
  TransferApproval,
  TransferPlan
} from './contracts.d.mts'
export interface TransferContext {
  actor: Actor
  id: string
  source: TransferApproval['source']
  targetSpace: string
  target: string
  scope: string
  sourceAPI: MutationAdapter
  destination: MutationAdapter
  tags: string[]
  plan: TransferPlan
  guard(): void
  check(
    api: MutationAdapter,
    path: string,
    source: { resourceId: string; sha256: string },
    etag?: string
  ): ReturnType<MutationOwner['check']>
}
