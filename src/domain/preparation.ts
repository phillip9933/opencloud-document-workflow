// SPDX-License-Identifier: AGPL-3.0-only
import {inspectProposal,type DocumentInput,type ProposalInspection} from './review.ts'
export type PreparationReview=ProposalInspection
export function preparationReview(input:DocumentInput,raw:unknown):PreparationReview {
 const saved=raw&&typeof raw==='object'&&!Array.isArray(raw)&&'proposal' in raw?(raw as {proposal:unknown}).proposal:raw
 return inspectProposal(input,saved)
}
