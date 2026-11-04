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
