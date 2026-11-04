// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../../companion/transactions.mjs'

declare const db: DatabaseSync
const result: number = withTransaction(db, () => 42)
void result
// @ts-expect-error async work must never cross a synchronous journal transaction
withTransaction(db, async () => 42)
// @ts-expect-error a non-async callback returning a Promise is also unsupported
withTransaction(db, () => Promise.resolve(42))

import { Readable } from 'node:stream'
import { remoteResponse } from '../../companion/remote-transport.mjs'
import type { RemoteContext } from '../../companion/remote-transport.mjs'
declare const remote: RemoteContext
void remoteResponse(remote, 'PUT', remote.base, {
  body: Readable.from([Buffer.from('synthetic')]),
  duplex: 'half',
  statuses: [201]
})
// @ts-expect-error accepted HTTP statuses must be numeric
void remoteResponse(remote, 'PUT', remote.base, { statuses: ['201'] })
// @ts-expect-error request bodies cannot be unencoded plain objects
void remoteResponse(remote, 'PUT', remote.base, { body: { secret: 'not serialized' } })

import type { Metadata } from '../../companion/metadata.mjs'
import type { DocumentTrash } from '../../companion/document-trash.mjs'
import type { Actor, MutationAdapter } from '../../companion/contracts.d.mts'
declare const metadata: Metadata, trash: DocumentTrash, actor: Actor, api: MutationAdapter
// @ts-expect-error a metadata write must pin the source hash and ETag
void metadata.save(actor, api, {
  path: 'Inbox/a.pdf',
  resourceId: 'a',
  version: 0,
  fields: {},
  addTags: []
})
void trash.process(
  actor,
  api,
  { id: 'operation', path: 'Inbox/a.pdf', resourceId: 'a', etag: 'v1', sha256: 'hash' },
  // @ts-expect-error Trash verification options cannot be a truthy string
  { verifyOnly: 'yes' }
)

import type { Operations } from '../../companion/operations.mjs'
import type { OperationAdapter } from '../../companion/operation-contracts.d.mts'
declare const operations: Operations, operationAPI: OperationAdapter
operations.start(actor, operationAPI, {
  id: 'fixture',
  kind: 'prepare',
  items: [{ path: 'Inbox/test.pdf', newReview: true }]
})
operations.start(actor, operationAPI, {
  id: 'fixture',
  kind: 'prepare',
  // @ts-expect-error preparation requires a document path
  items: [{ id: 'missing-path' }]
})
// @ts-expect-error filing requires an exact approved digest and policy
operations.start(actor, operationAPI, { id: 'fixture', kind: 'file', items: [{ id: 'job' }] })
// @ts-expect-error preparation switches must be boolean
operations.start(actor, operationAPI, {
  id: 'fixture',
  kind: 'prepare',
  items: [{ path: 'Inbox/test.pdf', newReview: 'yes' }]
})

import type { ProposalJournal } from '../../companion/journal.mjs'
import { generateProposal } from '../../companion/ollama.mjs'
import { generateRouted } from '../../companion/providers.mjs'
import type { DocumentInput } from '../../src/domain/review.ts'
import type { ProposalConfiguration } from '../../companion/proposal-contracts.d.mts'
declare const journal: ProposalJournal, document: DocumentInput, config: ProposalConfiguration
void journal.prepare(document, config, {
  onProgress: (stage) => {
    const expected: 'tagging' = stage
    void expected
  }
})
// @ts-expect-error a planner must return a validated Review, not arbitrary provider JSON
void journal.prepare(document, config, { planner: async () => ({ issuer: 'invented' }) })
// @ts-expect-error retry switches cannot be truthy strings
void journal.prepare(document, config, { retry: 'yes' })
void generateProposal(
  document,
  'local',
  'http://127.0.0.1:11434',
  fetch,
  // @ts-expect-error provider responses are unknown until validated by the callback
  (raw: { issuer: string }) => {
    void raw.issuer
  }
)
// @ts-expect-error routed execution must have an explicit route configuration
void generateRouted(document, config)
void generateProposal(document, 'local', 'http://127.0.0.1:11434', fetch, undefined, {
  // @ts-expect-error context capacities are numeric, not model labels
  contextTokens: 'large'
})

import type { Workflow } from '../../companion/workflow.mjs'
import type { Intake } from '../../companion/intake.mjs'
import type { APIContext, APIRoute } from '../../companion/api-contracts.d.mts'
declare const workflow: Workflow, intake: Intake, routeContext: APIContext, queueRoute: APIRoute
void queueRoute(routeContext)
// @ts-expect-error IDs remain unknown until a request handler validates them
const unsafeID: string = routeContext.body.id
void unsafeID
// @ts-expect-error a selected retry must use item IDs rather than resource objects
intake.manage(actor, 'retry', [{ resourceId: 'not-an-item-id' }])
// @ts-expect-error only supported queue controls may be dispatched
intake.manage(actor, 'delete')
// @ts-expect-error limits cannot be strings
intake.status(actor, { limit: '100' })
// @ts-expect-error source identity pinning requires an ETag string
void workflow.prepare(actor, api, 'Inbox/test.pdf', config, { expectedEtag: 2 })
void workflow.prepare(actor, api, 'Inbox/test.pdf', config, {
  // @ts-expect-error preparation reports only the defined progress stages
  onProgress: (stage: 'finished') => {
    void stage
  }
})
// @ts-expect-error workflow source verification cannot omit the byte hash
void workflow.check(api, 'Inbox/test.pdf', { resourceId: 'fixture' }, 'v1', actor)

import type { Automation } from '../../companion/automation.mjs'
import type { Conversions } from '../../companion/conversions.mjs'
import type { ServiceAdapter, FullAPIContext } from '../../companion/api-contracts.d.mts'
import type { Duplicates } from '../../companion/duplicates.mjs'
declare const automatic: Automation,
  converter: Conversions,
  duplicates: Duplicates,
  serviceAPI: ServiceAdapter,
  requestContext: FullAPIContext
// @ts-expect-error automatic retry must be an explicit boolean
void automatic.run(actor, serviceAPI, 'job', { retry: 'yes' })
// @ts-expect-error conversion must pin a source ETag
void converter.convert(actor, serviceAPI, { path: 'Inbox/photo.jpg', resourceId: 'resource' })
// @ts-expect-error read-only duplicate reconciliation cannot take a string switch
void duplicates.process(actor, serviceAPI, 'queue', { reconcileOnly: 'yes' })
// @ts-expect-error authenticated request body values still require validation
const unvalidatedName: string = requestContext.body.path
void unvalidatedName

import type { BackupManager } from '../../companion/backups.mjs'
import type { AppTokenSessions } from '../../companion/app-tokens.mjs'
import type { SessionSupervisor } from '../../companion/session.mjs'
declare const backups: BackupManager, tokens: AppTokenSessions, sessions: SessionSupervisor
// @ts-expect-error persisted settings require numeric intervals
backups.applySettings({ enabled: true, intervalMinutes: '60', maxMiB: 100, maxSnapshots: 5 })
void sessions.renew({
  // @ts-expect-error persisted refresh tokens must be strings
  value: { version: 1, access_token: 'synthetic', expires_at: null, refresh_token: 42 },
  hash: 'hash',
  legacy: false
})
// @ts-expect-error typed token state cannot use an unvalidated account record
void tokens.connect(actor, { username: 42 })
