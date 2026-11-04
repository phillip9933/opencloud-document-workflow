// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { createHash } from 'node:crypto'
/** @param {Buffer} b */
const sha = (b) => createHash('sha256').update(b).digest('hex')
/** @param {string} path @param {string} root */
const within = (path, root) => path.startsWith(root + '/')
// Only whole-file SHA-256 equality is eligible. OCR, visual similarity and AI
// confidence are deliberately absent: recurring bills are separate documents.
export class Duplicates {
  /** @param {import('./workflow.mjs').Workflow} workflow @param {import('./intake.mjs').Intake} intake */
  constructor(workflow, intake) {
    this.w = workflow
    this.db = workflow.db
    this.intake = intake
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id */
  intent(actor, id) {
    const row = /** @type {import('./orchestration-contracts.d.mts').DuplicateIntent|undefined} */ (
      this.db
        .prepare('select * from duplicate_trash where queue_id=? and scope=?')
        .get(id, this.w.scope(actor))
    )
    if (!row) throw new WorkflowError('OPERATION_HELD', 'Duplicate Trash intent is missing')
    return row
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  action(actor) {
    const saved = this.db
      .prepare('select folder,action from duplicate_settings where scope=?')
      .get(this.w.scope(actor))
    return saved?.folder === this.intake.configuration(actor).folder ? String(saved.action) : 'keep'
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {unknown} action @param {string} folder */
  save(actor, action, folder) {
    if (action !== 'keep' && action !== 'trash')
      throw new WorkflowError('OPERATION_HELD', 'Choose a duplicate action')
    this.db
      .prepare(
        'insert into duplicate_settings values(?,?,?) on conflict(scope) do update set folder=excluded.folder,action=excluded.action'
      )
      .run(this.w.scope(actor), folder, action)
    this.w.event(actor, null, 'duplicate_settings_saved', { folder, action })
    return action
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id */
  record(actor, id) {
    const row = this.db
      .prepare('select * from duplicate_trash where queue_id=? and scope=?')
      .get(id, this.w.scope(actor))
    return row ? { state: row.state, trashId: row.trash_id } : null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./workflow-contracts.d.mts').IntakeQueueRow} item @param {string} message */
  hold(actor, item, message) {
    this.db
      .prepare('update intake_queue set detail=? where id=? and scope=?')
      .run(message, item.id, this.w.scope(actor))
    return { state: 'duplicate', detail: message }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {{reconcileOnly?:boolean,automatic?:boolean}} options */
  async process(actor, api, id, { reconcileOnly = false, automatic = false } = {}) {
    const scope = this.w.scope(actor),
      item = /** @type {import('./workflow-contracts.d.mts').IntakeQueueRow|undefined} */ (
        this.db.prepare('select * from intake_queue where id=? and scope=?').get(id, scope)
      )
    if (!item || !['duplicate', 'trashed'].includes(item.state))
      throw new WorkflowError('OPERATION_HELD', 'Duplicate not found')
    const releases = []
    try {
      releases.push(this.w.lock('duplicate:' + scope + ':' + id))
      const prior =
        /** @type {import('./orchestration-contracts.d.mts').DuplicateIntent|undefined} */ (
          this.db
            .prepare('select * from duplicate_trash where queue_id=? and scope=?')
            .get(id, scope)
        )
      // An intent is a one-shot operation. Recovery is read-only, even after a
      // restart, timeout, restored file, changed policy or repeated button click.
      if (prior) return await this.verify(actor, api, item, prior)
      if (reconcileOnly)
        return this.hold(
          actor,
          item,
          'No Trash request was recorded. The extra copy is still held.'
        )
      const config = this.intake.configuration(actor)
      if (!within(item.path, config.folder))
        throw new WorkflowError('OPERATION_HELD', 'Duplicate is outside the selected inbox')
      if (automatic && !this.automaticEnabled(actor, config)) return { state: 'duplicate' }
      return await this.processNew(actor, api, item, config, automatic, releases)
    } catch (e) {
      return this.recordFailure(actor, item, e)
    } finally {
      for (const release of releases.reverse()) release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api
   * @param {import('./workflow-contracts.d.mts').IntakeQueueRow} item
   * @param {import('./workflow-contracts.d.mts').IntakeConfiguration} config
   * @param {boolean} automatic @param {Array<()=>void>} releases */
  async processNew(actor, api, item, config, automatic, releases) {
    const scope = this.w.scope(actor)
    const identity = await api.identity()
    if (this.w.scope(identity) !== scope)
      throw new WorkflowError('OPERATION_HELD', 'Duplicate workspace changed')
    if (!item.job)
      throw new WorkflowError(
        'OPERATION_HELD',
        'The kept original has no saved review. Both copies are held.'
      )
    const original = this.lockPair(actor, { ...item, job: item.job }, releases)
    const { source, kept, baseline } = await this.verifyPair(
      actor,
      api,
      { ...item, job: item.job },
      original
    )
    const latest = this.intake.configuration(actor)
    if (latest.folder !== config.folder || (automatic && !this.automaticEnabled(actor, latest)))
      return this.hold(actor, item, 'Duplicate handling was paused. The extra copy is still held.')
    return await this.trashVerified(actor, api, item, source, kept, baseline, original.sha256)
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./workflow-contracts.d.mts').IntakeQueueRow & {job:string}} item @param {Array<()=>void>} releases */
  lockPair(actor, item, releases) {
    const scope = this.w.scope(actor)
    const job = this.w.job(actor, item.job),
      original = JSON.parse(job.input).source
    if (!original?.sha256 || original.resourceId === item.resource)
      throw new WorkflowError('OPERATION_HELD', 'The kept original could not be verified')
    for (const resource of [item.resource, original.resourceId].sort())
      releases.push(this.w.lock(`resource:${scope}:${resource}`))
    if (
      this.db
        .prepare(
          "select 1 from metadata_changes where scope=? and resource in (?,?) and state='intent'"
        )
        .get(scope, item.resource, original.resourceId)
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'A metadata save needs verification before handling duplicates'
      )
    return original
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./workflow-contracts.d.mts').IntakeQueueRow} item @param {unknown} e */
  recordFailure(actor, item, e) {
    return {
      ...this.hold(
        actor,
        item,
        e instanceof Error &&
          e.message.length < 180 &&
          !/[\r\n]/.test(e.message) &&
          !e.message.startsWith('OpenCloud HTTP')
          ? e.message
          : 'Could not verify OpenCloud Trash. The extra copy is held for inspection.'
      ),
      uncertain: !!this.record(actor, item.id)
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./workflow-contracts.d.mts').IntakeConfiguration} config */
  automaticEnabled(actor, config) {
    return config.enabled && !this.intake.paused(actor) && this.action(actor) === 'trash'
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./workflow-contracts.d.mts').IntakeQueueRow & {job:string}} item @param {import('../src/domain/review.ts').Source} original */
  async verifyPair(actor, api, item, original) {
    const max = (this.w.configuration.settings(actor).limits.maxMiB ?? 100) * 1024 * 1024
    const kept = await this.w.location(actor, api, item.job),
      source = await api.stat(item.path),
      keptAPI =
        kept.space && kept.space !== actor.space
          ? await this.w.requiredTransfers().adapter(actor, api, kept.space)
          : api
    if (
      !source ||
      source.folder ||
      source.resourceId !== item.resource ||
      source.etag !== item.etag ||
      source.resourceId === kept.resourceId
    )
      throw new WorkflowError('OPERATION_HELD', 'The duplicate changed. Refresh the inbox.')
    if (
      sha(await api.get(source.path, source.etag, max)) !== original.sha256 ||
      sha(await keptAPI.get(kept.path, kept.etag, max)) !== original.sha256
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'The files are no longer byte-identical. Both copies are held.'
      )
    const baseline = await api.listTrash()
    const current = await api.stat(source.path),
      originalNow = await keptAPI.stat(kept.path)
    this.assertStablePair(source, kept, current, originalNow)
    return { source, kept, baseline }
  }
  /** @param {import('./contracts.d.mts').FileEntry} source @param {import('./contracts.d.mts').FileEntry} kept
   * @param {import('./contracts.d.mts').FileEntry|null} current @param {import('./contracts.d.mts').FileEntry|null} originalNow */
  assertStablePair(source, kept, current, originalNow) {
    if (
      !current ||
      current.resourceId !== source.resourceId ||
      current.etag !== source.etag ||
      !originalNow ||
      originalNow.resourceId !== kept.resourceId ||
      originalNow.etag !== kept.etag
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'A file changed during duplicate verification. Both copies are held.'
      )
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./workflow-contracts.d.mts').IntakeQueueRow} item @param {import('./contracts.d.mts').FileEntry} source @param {import('./contracts.d.mts').FileEntry} kept @param {import('./contracts.d.mts').TrashEntry[]} baseline @param {string} hash */
  async trashVerified(actor, api, item, source, kept, baseline, hash) {
    this.db
      .prepare(
        "insert into duplicate_trash(queue_id,scope,source,keeper,sha,baseline,state,created) values(?,?,?,?,?,?,'intent',?)"
      )
      .run(
        item.id,
        this.w.scope(actor),
        JSON.stringify(source),
        JSON.stringify(kept),
        hash,
        JSON.stringify(baseline.map((row) => row.id)),
        new Date().toISOString()
      )
    this.w.event(actor, item.job, 'duplicate_trash_intent', {
      id: item.id,
      path: source.path,
      resourceId: source.resourceId,
      keptPath: kept.path,
      keptResourceId: kept.resourceId,
      sha256: hash
    })
    try {
      await api.trash(source.path, source.etag)
      this.db.prepare('update duplicate_trash set ack=1 where queue_id=?').run(item.id)
    } catch {
      /* Outcome may be unknown. Never issue DELETE again. */
    }
    return await this.verify(actor, api, item, this.intent(actor, item.id))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {import('./workflow-contracts.d.mts').IntakeQueueRow} item @param {import('./orchestration-contracts.d.mts').DuplicateIntent} intent */
  async verify(actor, api, item, intent) {
    if (intent.state === 'trashed') return { state: 'trashed', trashId: intent.trash_id }
    const source = JSON.parse(intent.source),
      baseline = new Set(JSON.parse(intent.baseline)),
      current = await api.stat(source.path),
      rows = await api.listTrash(),
      node = source.resourceId.split('!').at(-1)
    const found = rows.filter(
      (row) =>
        !baseline.has(row.id) &&
        !row.folder &&
        row.path === source.path &&
        row.size === source.size &&
        (intent.ack || row.resourceId === source.resourceId || row.id === node)
    )
    if (!current && found.length === 1) {
      this.db
        .prepare("update duplicate_trash set state='trashed',trash_id=? where queue_id=?")
        .run(found[0].id, item.id)
      this.db
        .prepare("update intake_queue set state='trashed',detail=? where id=?")
        .run('Moved to OpenCloud Trash. Recovery follows OpenCloud retention settings.', item.id)
      this.w.event(actor, item.job, 'duplicate_trashed', {
        id: item.id,
        path: source.path,
        resourceId: source.resourceId,
        trashId: found[0].id,
        keptPath: JSON.parse(intent.keeper).path
      })
      return { state: 'trashed', trashId: found[0].id }
    }
    return {
      ...this.hold(
        actor,
        item,
        'Trash outcome needs verification. Inspect OpenCloud Trash; this request will not be repeated.'
      ),
      uncertain: true
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api */
  async resume(actor, api) {
    if (
      this.action(actor) !== 'trash' ||
      !this.intake.configuration(actor).enabled ||
      this.intake.paused(actor)
    )
      return
    const rows = this.db
      .prepare(
        "select id from intake_queue where scope=? and state='duplicate' order by first_seen limit ?"
      )
      .all(this.w.scope(actor), this.w.configuration.settings(actor).limits.documentsPerCycle ?? 20)
    for (const row of rows) {
      if (
        this.action(actor) !== 'trash' ||
        !this.intake.configuration(actor).enabled ||
        this.intake.paused(actor) ||
        this.intake.stopped
      )
        break
      await this.process(actor, api, String(row.id), { automatic: true })
    }
  }
}
