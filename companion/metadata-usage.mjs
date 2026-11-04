// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { metadataUsage } from '../src/domain/metadata-usage.ts'
import { inboxFiles } from './inbox.mjs'
/** @param {import('./workflow.mjs').Workflow} workflow @param {import('./documents.mjs').DocumentLibrary} documents
 * @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api */
export async function definitionUsage(workflow, documents, actor, api) {
  if (!workflow.metadata || !workflow.configuration)
    throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Metadata services are not configured')
  const configured = workflow.db
    .prepare('select value from intake_settings where scope=?')
    .get(workflow.scope(actor))?.value
  const initial = await documents.browse(actor, api),
    entries = initial.files.map((file) => ({
      ...file,
      folder: !!file.folder,
      resourceId: JSON.stringify([initial.space, file.resourceId])
    })),
    pending = initial.files.filter((file) => file.folder).map((file) => file.path),
    seen = new Set()
  while (pending.length) {
    const batch = pending.splice(0, 4).filter((path) => !seen.has(path))
    batch.forEach((path) => seen.add(path))
    const results = await Promise.allSettled(
      batch.map((path) => documents.browse(actor, api, { path }))
    )
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      const value = result.value
      if (value.root !== initial.root || value.space !== initial.space)
        throw new WorkflowError(
          'SOURCE_CHANGED',
          'The filing destination changed. Refresh documents.'
        )
      for (const file of value.files) {
        entries.push({ ...file, resourceId: JSON.stringify([initial.space, file.resourceId]) })
        if (file.folder && !seen.has(file.path)) pending.push(file.path)
      }
    }
  }
  if (configured) {
    const configuration = JSON.parse(String(configured))
    for (const file of await inboxFiles(api, { ...configuration, recursive: true }))
      entries.push({
        ...file,
        folder: !!file.folder,
        size: file.size,
        tags: file.tags ?? [],
        resourceId: JSON.stringify([actor.space, file.resourceId]),
        fields: workflow.metadata.read(actor, file.resourceId).fields
      })
  }
  if (
    configured !==
      workflow.db
        .prepare('select value from intake_settings where scope=?')
        .get(workflow.scope(actor))?.value ||
    initial.root !== workflow.configuration.settings(actor).rules.root ||
    initial.space !== workflow.configuration.destinationSpace(actor)
  )
    throw new WorkflowError('SOURCE_CHANGED', 'The filing destination changed. Refresh documents.')
  return metadataUsage(entries)
}
