// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import { open, lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'

/** @param {string} backupReason */
export const backupFailure = (backupReason) =>
  Object.assign(new WorkflowError('OPERATION_HELD', backupReason), { backupReason })
/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

// Separate from the journal so a backup can read it online. SQLite releases the
// transaction after SIGKILL, including PID reuse and container recreation. Never
// unlink this sidecar. All backup cleanup/publication runs under this lock.
/** @param {string} directory */
export async function lockBackupStorage(directory) {
  const path = join(directory, '.backup-runtime.sqlite3')
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.mode & 0o077) throw backupFailure('private_file_required')
  } finally {
    await file.close()
  }
  const guard = new DatabaseSync(path)
  try {
    guard.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  } catch (error) {
    guard.close()
    if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 5)
      throw backupFailure('backup_busy')
    throw error
  }
  return () => guard.close()
}

const stageName = /^\.pending-snapshot-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
/** @param {string} directory @returns {Promise<string | null>} */
async function pendingStage(directory) {
  const path = join(directory, 'backup-upload.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 32768)
      throw backupFailure('backup_upload_held')
    const intent = JSON.parse(await readFile(path, 'utf8'))
    if (
      !['pending', 'done'].includes(intent?.state) ||
      typeof intent.stage !== 'string' ||
      dirname(intent.stage) !== directory ||
      !stageName.test(basename(intent.stage))
    )
      throw backupFailure('backup_upload_held')
    return intent.state === 'pending' ? intent.stage : null
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    // Corrupt intents may still own a snapshot: fail closed, don't guess.
    throw backupFailure('backup_upload_held')
  }
}
/** Remove only generated, unreferenced stages while holding the storage lock.
 * @param {string} directory
 */
export async function cleanBackupStages(directory) {
  const retained = await pendingStage(directory)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!stageName.test(entry.name)) continue
    const path = join(directory, entry.name)
    if (path === retained) continue
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw backupFailure('unexpected_backup_entry')
    await rm(path, { recursive: true })
  }
}
