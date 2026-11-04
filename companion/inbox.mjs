// SPDX-License-Identifier: AGPL-3.0-only
import { safePath } from '../src/domain/review.ts'
// Lists only the configured inbox. Folder-picker browsing uses the original API.
export async function inboxFiles(api, { folder, recursive }) {
  const pending = [folder],
    seen = new Set(),
    files = []
  safePath(folder)
  while (pending.length) {
    const path = pending.pop()
    if (seen.has(path)) throw new Error('Repeated inbox folder')
    seen.add(path)
    for (const file of await api.list(path)) {
      safePath(file.path)
      if (!file.path.startsWith(path + '/') || file.path.slice(path.length + 1).includes('/'))
        throw new Error('Inbox listing outside requested folder')
      if (file.folder) {
        if (recursive) pending.push(file.path)
      } else files.push(file)
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
// Inbox totals describe files that are still there. Activity retains the full
// queue history, including trashed duplicates and superseded uploads.
export function inboxSummary(files) {
  const summary = {
    total: 0,
    waiting: 0,
    running: 0,
    ready: 0,
    completed: 0,
    attention: 0,
    cancelled: 0,
    duplicates: 0,
    superseded: 0,
    retryable: 0,
    cancellable: 0
  }
  for (const file of files) {
    if (file.folder) continue
    summary.total++
    const state = file.intakeState,
      review = file.reviewState,
      progress = file.progress
    const bucket = ['duplicate', 'restored', 'trashed'].includes(state)
      ? 'duplicates'
      : review === 'done' || review === 'rejected' || state === 'processed'
        ? 'completed'
        : progress?.attention ||
            [
              'approved',
              'folders_pending',
              'move_intent',
              'move_done',
              'tags_intent',
              'copy_intent',
              'transfer_ready',
              'conflict'
            ].includes(review)
          ? 'attention'
          : progress?.cancelled
            ? 'cancelled'
            : state === 'running'
              ? 'running'
              : progress?.step === 5
                ? 'completed'
                : progress?.step === 4
                  ? 'ready'
                  : 'waiting'
    summary[bucket]++
  }
  return summary
}
