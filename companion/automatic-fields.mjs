// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { validateFieldValue } from '../src/domain/metadata.ts'

/** @param {import('../src/domain/metadata.ts').FieldDefinition} field @param {string[]} pages */
function printedLabelPresent(field, pages) {
  return pages.some((page) =>
    page
      .split(/\r?\n/)
      .some((line) =>
        field.aliases.some(
          (alias) =>
            line.trimStart().toLowerCase().startsWith(alias.toLowerCase()) &&
            /^\s*[:：=]/.test(line.trimStart().slice(alias.length))
        )
      )
  )
}
/** Resolve automatic field additions without overwriting saved values or guessing
 * invalid/ambiguous printed values. The caller retains the write/identity guard.
 * @param {import('../src/domain/metadata.ts').MetadataSchema} schema
 * @param {string[]} pages
 * @param {Record<string, string | number>} current
 * @param {ReturnType<import('../src/domain/metadata.ts').suggestMetadata>['fields']} suggestions
 */
export function automaticFields(schema, pages, current, suggestions) {
  for (const field of schema.fields) {
    if (current[field.id] !== undefined) validateFieldValue(field, current[field.id])
    if (
      printedLabelPresent(field, pages) &&
      !suggestions[field.id] &&
      current[field.id] === undefined
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'A field is ambiguous or invalid and needs review: ' + field.label
      )
  }
  const fields = Object.fromEntries(
    Object.entries(current).filter(([id]) => schema.fields.some((field) => field.id === id))
  )
  for (const [id, value] of Object.entries(suggestions))
    if (fields[id] === undefined) fields[id] = value.value
  return fields
}
