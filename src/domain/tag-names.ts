// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from './errors.ts'
export const tagNameKey = (value: string) => value.normalize('NFC').trim().toLowerCase()
export function existingTagName(value: string, catalog: string[]): string {
  const name = value.normalize('NFC').trim()
  if (catalog.includes(name)) return name
  const matches = [...new Set(catalog.filter((tag) => tagNameKey(tag) === tagNameKey(name)))]
  if (matches.length > 1)
    throw new WorkflowError(
      'VALIDATION_INVALID',
      'Several existing tags differ only by capitalization. Choose the exact tag.'
    )
  return matches[0] ?? name
}
