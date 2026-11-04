// SPDX-License-Identifier: AGPL-3.0-only
import type { LibraryEntry } from './library.ts'
export interface MetadataUsage {
  fields: Record<string, number>
  tags: Record<string, number>
}
export function metadataUsage(entries: LibraryEntry[]): MetadataUsage {
  const fields: Record<string, number> = Object.create(null),
    tags: Record<string, number> = Object.create(null),
    seen = new Set<string>()
  for (const entry of entries) {
    if (entry.folder || seen.has(entry.resourceId)) continue
    seen.add(entry.resourceId)
    for (const tag of new Set(entry.tags)) tags[tag] = (tags[tag] ?? 0) + 1
    for (const [id, value] of Object.entries(entry.fields ?? {}))
      if (typeof value === 'number' || (typeof value === 'string' && value.trim()))
        fields[id] = (fields[id] ?? 0) + 1
  }
  return { fields, tags }
}
