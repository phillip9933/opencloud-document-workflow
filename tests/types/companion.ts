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
