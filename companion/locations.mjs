// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { safePath } from '../src/domain/review.ts'

// A read-only, complete metadata snapshot of the configured filing tree. Paths
// are observations, never approval authority; copies cannot inherit identity.
export class FiledLocations {
  /** @param {import('./contracts.d.mts').LocationOwner} workflow */
  constructor(workflow) {
    this.w = workflow
    /** @type {Map<string,Promise<import('./contracts.d.mts').LocationSnapshot>>} */
    this.pending = new Map()
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  context(actor) {
    return {
      scope: this.w.scope(actor),
      space: this.w.configuration.destinationSpace(actor),
      root: safePath(this.w.configuration.settings(actor).rules.root)
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileReader} api */
  async refresh(actor, api) {
    const context = this.context(actor),
      key = JSON.stringify(context)
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.scan(actor, api, context)
    this.pending.set(key, task)
    try {
      return await task
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key)
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileReader} api @param {import('./contracts.d.mts').LocationContext} context */
  async scan(actor, api, context) {
    const { scope, space, root } = context,
      physical = await this.w.transfers.adapter(actor, api, space),
      pending = [root],
      folders = new Set()
    /** @type {Map<string,import('./contracts.d.mts').FileEntry & {space:string}>} */
    const resources = new Map()
    while (pending.length) {
      const batch = pending.splice(0, 4)
      for (const path of batch) {
        if (folders.has(path))
          throw new WorkflowError('OPERATION_HELD', 'Repeated folder in document listing')
        folders.add(path)
      }
      if (folders.size > 10000)
        throw new WorkflowError('VALIDATION_INVALID', 'Document folder listing exceeds limit')
      const results = await Promise.all(batch.map((path) => physical.list(path)))
      for (let i = 0; i < batch.length; i++)
        for (const file of results[i]) {
          const path = safePath(file.path),
            parent = batch[i]
          if (!path.startsWith(parent + '/') || path.slice(parent.length + 1).includes('/'))
            throw new WorkflowError('OPERATION_HELD', 'Document listing outside requested folder')
          if (file.folder) {
            pending.push(path)
            continue
          }
          if (
            typeof file.resourceId !== 'string' ||
            !file.resourceId ||
            typeof file.etag !== 'string' ||
            !file.etag ||
            resources.has(file.resourceId)
          )
            throw new WorkflowError('OPERATION_HELD', 'Document identity is incomplete or repeated')
          if (!Array.isArray(file.tags) || file.tags.some((tag) => typeof tag !== 'string'))
            throw new WorkflowError('OPERATION_HELD', 'Document tags are incomplete')
          resources.set(file.resourceId, { ...file, path, space })
          if (resources.size > 100000)
            throw new WorkflowError('VALIDATION_INVALID', 'Document listing exceeds limit')
        }
    }
    // Do not publish partial results or results from a changed configuration.
    if (JSON.stringify(this.context(actor)) !== JSON.stringify(context))
      throw new WorkflowError(
        'SOURCE_CHANGED',
        'The filing destination changed. Refresh documents.'
      )
    const db = this.w.db
    db.exec('SAVEPOINT filed_location_snapshot')
    try {
      db.prepare('delete from filed_locations where scope=?').run(scope)
      const insert = db.prepare('insert into filed_locations values(?,?,?,?,?,?,?)')
      for (const file of resources.values())
        insert.run(
          scope,
          space,
          root,
          file.resourceId,
          file.path,
          JSON.stringify(file.tags),
          file.etag
        )
      db.exec('RELEASE filed_location_snapshot')
    } catch (error) {
      db.exec('ROLLBACK TO filed_location_snapshot; RELEASE filed_location_snapshot')
      throw error
    }
    return { ...context, resources }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileReader} api @param {string} resource @param {string} space */
  async locate(actor, api, resource, space) {
    if (space !== this.context(actor).space) return null
    const snapshot = await this.refresh(actor, api),
      file = snapshot.resources.get(resource)
    if (!file) return null
    // Recheck the exact identity after traversal; concurrent external moves must
    // hold rather than send edits to an occupied old path.
    const physical = await this.w.transfers.adapter(actor, api, space),
      current = await physical.stat(file.path)
    return current && !current.folder && current.resourceId === resource
      ? { ...current, space }
      : null
  }
}
