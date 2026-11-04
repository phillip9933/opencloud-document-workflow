// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, realpathSync } from 'node:fs'

// One process may own a journal. SQLite releases this separate transaction even
// after SIGKILL; PID reuse and container hostnames cannot impersonate its owner.
// Keep the sidecar beside the journal on the same private local volume. Never
// unlink it while a companion is running. It contains no document/credential data.
const runtimes = new Map()

export function acquireRuntime(database) {
  const key = realpathSync(database)
  let runtime = runtimes.get(key)
  if (!runtime) {
    const guard = new DatabaseSync(`${key}.runtime.sqlite3`)
    try {
      chmodSync(`${key}.runtime.sqlite3`, 0o600)
      guard.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
    } catch (cause) {
      guard.close()
      throw Object.assign(new Error('Another companion process owns this journal', { cause }), { code: 'RUNTIME_BUSY' })
    }
    runtime = { guard, references: 0, locks: new Set(), proposals: new Set(), preparations: new Set() }
    runtimes.set(key, runtime)
  }
  runtime.references++
  let released = false
  return { runtime, release() {
    if (released) return
    released = true
    if (--runtime.references === 0) {
      try { runtime.guard.close() } finally { runtimes.delete(key) }
    }
  } }
}
