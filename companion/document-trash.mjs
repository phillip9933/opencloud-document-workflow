// SPDX-License-Identifier: AGPL-3.0-only
import {
  resourceIdentities,
  hasPendingFiling,
  hasPendingAutomation,
  hasPendingMetadata
} from './pending-operations.mjs'
import { errorCode } from '../src/domain/errors.ts'
import { safePath } from '../src/domain/review.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export class DocumentTrash {
  /** @param {import('./contracts.d.mts').MutationOwner} workflow */
  constructor(workflow) {
    this.w = workflow
    this.db = workflow.db
    workflow.documentTrash = this
  }
  /** Read a row already created under the operation lock.
   * @param {string} id
   */
  record(id) {
    const row = /** @type {import('./contracts.d.mts').TrashRow | undefined} */ (
      this.db.prepare('select * from document_trash where id=?').get(id)
    )
    if (!row) throw new Error('Recorded operation is missing')
    return row
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resource */
  key(actor, resource) {
    return this.w.transfers?.canonical(actor, resource) ?? resource
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resource */
  pending(actor, resource) {
    const row = this.db
      .prepare(
        "select id from document_trash where scope=? and resource=? and state='intent' order by created desc limit 1"
      )
      .get(this.w.scope(actor), this.key(actor, resource))
    return row ? { id: String(row.id) } : null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resource */
  assertAvailable(actor, resource) {
    if (this.pending(actor, resource))
      throw new Error('Verify the pending Trash operation before changing this document')
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  list(actor) {
    return this.db
      .prepare(
        "select id,source from document_trash where scope=? and state='intent' order by created"
      )
      .all(this.w.scope(actor))
      .map((row) => ({
        id: row.id,
        ...(({ path, resourceId, space, job }) => ({ path, resourceId, space, job }))(
          JSON.parse(String(row.source))
        )
      }))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} resource */
  held(actor, resource) {
    const scope = this.w.scope(actor),
      canonical = this.key(actor, resource),
      ids = resourceIdentities(this.db, scope, resource, canonical, !!this.w.transfers)
    if (
      hasPendingFiling(this.db, scope, ids) ||
      (this.w.automation && hasPendingAutomation(this.db, scope, ids))
    )
      throw new Error(
        'Finish or verify the existing operation before moving this document to Trash'
      )
    if (
      this.w.intake &&
      this.db
        .prepare(
          "select 1 from intake_queue where scope=? and resource in (select value from json_each(?)) and state in ('settling','queued','running') limit 1"
        )
        .get(scope, ids)
    )
      throw new Error('Pause or cancel pending processing before moving this document to Trash')
    if (
      this.db
        .prepare("select 1 from sqlite_master where type='table' and name='bulk_items'")
        .get() &&
      this.db
        .prepare(
          "select 1 from bulk_items i join bulk_operations o on o.id=i.operation where o.scope=? and json_extract(i.input,'$.resourceId') in (select value from json_each(?)) and i.state in ('queued','running') and o.state in ('queued','running','paused') limit 1"
        )
        .get(scope, ids)
    )
      throw new Error(
        'Finish or cancel the pending bulk operation before moving this document to Trash'
      )
    if (
      this.w.conversions &&
      this.db
        .prepare(
          "select 1 from conversions where scope=? and (json_extract(record,'$.resourceId') in (select value from json_each(?)) or json_extract(record,'$.pdfResourceId') in (select value from json_each(?))) and json_extract(record,'$.state')<>'done' limit 1"
        )
        .get(scope, ids, ids)
    )
      throw new Error('Finish or verify the conversion before moving this document to Trash')
    if (this.w.metadata && hasPendingMetadata(this.db, scope, canonical))
      throw new Error('Verify the pending metadata change before moving this document to Trash')
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} space */
  async physical(actor, api, space) {
    const physical =
        space === actor.space ? api : await this.w.transfers.adapter(actor, api, space),
      identity = await physical.identity()
    if (
      identity.server !== actor.server ||
      identity.account !== actor.account ||
      identity.space !== space
    )
      throw new Error('Document workspace changed')
    return physical
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./contracts.d.mts').TrashInput} input @param {{verifyOnly?:boolean}} [options] */
  async process(actor, api, input, { verifyOnly = false } = {}) {
    const scope = this.w.scope(actor),
      id = input.id
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid Trash operation')
    const release = this.w.lock('document-trash:' + scope + ':' + id),
      locks = []
    try {
      const prior = /** @type {import('./contracts.d.mts').TrashRow|undefined} */ (
        this.db.prepare('select * from document_trash where id=? and scope=?').get(id, scope)
      )
      if (prior) return await this.verify(actor, api, prior)
      if (this.db.prepare('select 1 from document_trash where id=?').get(id))
        throw new Error('Trash operation not found')
      if (verifyOnly) return { id, state: 'not_recorded', uncertain: false }
      const path = safePath(input.path),
        space = input.documentSpace ?? actor.space
      if (
        typeof input.resourceId !== 'string' ||
        !input.resourceId ||
        typeof input.etag !== 'string' ||
        !input.etag ||
        typeof input.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.sha256)
      )
        throw new Error('A verified document identity is required for Trash')
      if (input.job) {
        const job = this.w.job(actor, input.job),
          decision = this.w.decision(actor, input.job)
        if (decision && !['done', 'rejected', 'conflict'].includes(decision.state))
          throw new Error(
            'Finish or verify the existing operation before moving this document to Trash'
          )
        const location = await this.w.location(actor, api, job.id)
        if (
          location.path !== path ||
          location.space !== space ||
          location.resourceId !== input.resourceId
        )
          throw new Error('The document location changed. Reopen it before continuing')
      } else {
        const root = safePath(this.w.configuration.settings(actor).rules.root)
        const inbox = this.w.intake?.configuration(actor).folder,
          inDestination =
            space === this.w.configuration.destinationSpace(actor) && path.startsWith(root + '/'),
          inInbox = space === actor.space && inbox && path.startsWith(inbox + '/')
        if (!inDestination && !inInbox)
          throw new Error('Choose a file inside the document destination')
      }
      try {
        locks.push(this.w.lock(`resource:${scope}:${this.key(actor, input.resourceId)}`))
      } catch (error) {
        if (errorCode(error) === 'WORKFLOW_BUSY')
          throw new Error('This document is busy. Wait for its current operation to finish.', {
            cause: error
          })
        throw error
      }
      this.assertAvailable(actor, input.resourceId)
      this.held(actor, input.resourceId)
      const physical = await this.physical(actor, api, space),
        source = await this.w.check(
          physical,
          path,
          { resourceId: input.resourceId, sha256: input.sha256 },
          input.etag,
          actor
        )
      if (!source) throw new Error('The document changed. Reopen it before moving it to Trash')
      const baseline = await physical.listTrash(),
        after = await physical.stat(path)
      if (!after || after.resourceId !== source.resourceId || after.etag !== source.etag)
        throw new Error('The document changed. Reopen it before moving it to Trash')
      this.held(actor, input.resourceId)
      this.db
        .prepare(
          "insert into document_trash(id,scope,resource,source,sha,baseline,state,created) values(?,?,?,?,?,?,'intent',?)"
        )
        .run(
          id,
          scope,
          this.key(actor, input.resourceId),
          JSON.stringify({ ...source, space, job: input.job ?? null }),
          input.sha256,
          JSON.stringify(baseline.map((row) => row.id)),
          new Date().toISOString()
        )
      this.w.event(actor, input.job ?? null, 'document_trash_intent', {
        id,
        path,
        resourceId: source.resourceId,
        space
      })
      try {
        await physical.trash(path, source.etag)
        this.db.prepare('update document_trash set ack=1 where id=?').run(id)
      } catch {
        /* Record once; subsequent requests only inspect the outcome. */
      }
      return await this.verify(actor, api, this.record(id))
    } catch (error) {
      if (this.db.prepare('select 1 from document_trash where id=? and scope=?').get(id, scope))
        return {
          id,
          state: 'intent',
          uncertain: true,
          detail:
            'Trash outcome needs verification. Inspect OpenCloud Trash; this request will not be repeated.'
        }
      throw Object.assign(error instanceof Error ? error : new Error('Trash operation failed'), {
        trashRecorded: false
      })
    } finally {
      for (const unlock of locks.reverse()) unlock()
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./contracts.d.mts').TrashRow} row */
  async verify(actor, api, row) {
    if (row.state === 'trashed') return { id: row.id, state: 'trashed', trashId: row.trash_id }
    const source = JSON.parse(String(row.source)),
      physical = await this.physical(actor, api, source.space),
      baseline = new Set(JSON.parse(row.baseline)),
      current = await physical.stat(source.path),
      entries = await physical.listTrash(),
      node = source.resourceId.split('!').at(-1)
    const found = entries.filter(
      (entry) =>
        !baseline.has(entry.id) &&
        !entry.folder &&
        entry.path === source.path &&
        entry.size === source.size &&
        (row.ack || entry.resourceId === source.resourceId || entry.id === node)
    )
    if (!current && found.length === 1) {
      this.db
        .prepare("update document_trash set state='trashed',trash_id=? where id=?")
        .run(found[0].id, row.id)
      if (this.w.intake)
        this.db
          .prepare(
            "update intake_queue set state='removed',detail='Moved to OpenCloud Trash. Recovery follows OpenCloud retention settings.' where scope=? and resource=? and etag=?"
          )
          .run(this.w.scope(actor), source.resourceId, source.etag)
      this.w.event(actor, null, 'document_trashed', {
        id: row.id,
        path: source.path,
        resourceId: source.resourceId,
        space: source.space,
        trashId: found[0].id
      })
      return { id: row.id, state: 'trashed', trashId: found[0].id }
    }
    return {
      id: row.id,
      state: 'intent',
      uncertain: true,
      detail:
        'Trash outcome needs verification. Inspect OpenCloud Trash; this request will not be repeated.'
    }
  }
}
