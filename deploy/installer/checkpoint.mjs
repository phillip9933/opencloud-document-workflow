// SPDX-License-Identifier: AGPL-3.0-only
import { stoppedCheckpoint } from '/app/companion/stopped-checkpoint.mjs'
const result = await stoppedCheckpoint('/state/workflow.sqlite3', '/backups/install-checkpoints')
console.log(
  result.state === 'fresh'
    ? 'Fresh installation: no existing journal'
    : 'Private pre-upgrade journal checkpoint verified'
)
