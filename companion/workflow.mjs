// SPDX-License-Identifier: AGPL-3.0-only
import { jobAssociations } from './job-associations.mjs'
import { unboundService } from './services.mjs'
import {
  resourceIdentities,
  hasPendingFiling,
  hasPendingAutomation,
  hasPendingMetadata
} from './pending-operations.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { withTransaction } from './transactions.mjs'
import { applyFiling, readFilingPlan, requireFilingPlan } from './filing.mjs'
import { readDocument } from './preparation.mjs'
import { tagCatalog } from '../src/domain/tag-discovery.ts'
import { createHash, randomUUID } from 'node:crypto'
import { pageOptions, pageCursor } from './pagination.mjs'
import { processingIssue, preparationIssue } from './processing-issues.mjs'
import { preparationReview } from '../src/domain/preparation.ts'
import { validateAIConfig } from '../src/domain/ai.ts'
import {
  safePath,
  validateBundle,
  validatePolicy,
  createApproval,
  reviewDigest,
  approvalMatches
} from '../src/domain/review.ts'
/** @typedef {import('./workflow-contracts.d.mts').Actor} Actor */
/** @typedef {import('./contracts.d.mts').MutationAdapter} Adapter */
/** @typedef {import('./workflow-contracts.d.mts').RecordedApproval} RecordedApproval */
/** @param {Buffer|string} b */
const sha = (b) => createHash('sha256').update(b).digest('hex')
export class Workflow {
  /** @returns {import('./similarity.mjs').SimilarDocuments} */
  get similarities() {
    return unboundService('similarities')
  }

  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['configuration']} */
  get configuration() {
    return unboundService('configuration')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['metadata']} */
  get metadata() {
    return unboundService('metadata')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['documentTrash']} */
  get documentTrash() {
    return unboundService('documentTrash')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['transfers']} */
  get transfers() {
    return unboundService('transfers')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['locations']} */
  get locations() {
    return unboundService('locations')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['automation']} */
  get automation() {
    return unboundService('automation')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['intake']} */
  get intake() {
    return unboundService('intake')
  }
  /** @returns {import('./workflow-contracts.d.mts').WorkflowServices['conversions']} */
  get conversions() {
    return unboundService('conversions')
  }

  /** @param {import('./journal.mjs').ProposalJournal} journal */
  constructor(journal) {
    this.preparationOwners = journal.runtime.preparations
    this.journal = journal
    this.db = journal.db
  }
  requiredTransfers() {
    return this.transfers
  }
  /** @param {Adapter} api @param {string} space */
  spaceAdapter(api, space) {
    if (!api.forSpace)
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Space adapter is unavailable')
    return api.forSpace(space)
  }
  /** @param {Partial<Actor>} source @returns {Actor} */
  sourceActor(source) {
    if (!source.server || !source.account || !source.space)
      throw new WorkflowError('INTERNAL_ERROR', 'Source scope is missing')
    return { server: source.server, account: source.account, space: source.space }
  }
  /** @param {Actor} actor */
  scope(actor) {
    return JSON.stringify([actor.server, actor.account, actor.space])
  }
  /** @param {Actor} actor @param {string|null} job @param {string} kind @param {Record<string,unknown>} detail */
  event(actor, job, kind, detail = {}) {
    this.db
      .prepare('INSERT INTO activity(scope,job,kind,detail,created) VALUES(?,?,?,?,?)')
      .run(this.scope(actor), job, kind, JSON.stringify(detail), new Date().toISOString())
  }
  /** @param {Actor} actor @returns {import('./workflow-contracts.d.mts').Preferences|null} */
  preference(actor) {
    const row = this.db
      .prepare('select configuration from preferences where scope=?')
      .get(this.scope(actor))
    return row ? JSON.parse(String(row.configuration)) : null
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').Preferences} configuration */
  savePreference(actor, configuration) {
    if (!configuration || Object.keys(configuration).sort().join(',') !== 'ai,policy')
      throw new WorkflowError('VALIDATION_INVALID', 'Unexpected preference fields')
    configuration = {
      policy: validatePolicy(configuration.policy),
      ai: validateAIConfig(configuration.ai)
    }
    this.db
      .prepare(
        'insert into preferences values(?,?) on conflict(scope) do update set configuration=excluded.configuration'
      )
      .run(this.scope(actor), JSON.stringify(configuration))
    this.event(actor, null, 'settings_saved')
    return configuration
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').JobOptions} options */
  jobPage(actor, { id = null, activeOnly = false, ...options } = {}) {
    const { limit, after } = pageOptions({ limit: 200, ...options })
    const rows = /** @type {import('./workflow-contracts.d.mts').JobListRow[]} */ (
      this.db
        .prepare(
          `select p.id,p.state,p.attempts,p.result,p.input sourceInput,p.error,p.updated,d.state decision,d.record approval from proposals p left join decisions d on d.job=p.id where p.scope=? and (? is null or p.id=?) and (?=0 or (d.state is null or d.state<>'done') and not exists(select 1 from automatic_runs a where a.job=p.id and a.state='done')) and (? is null or p.updated<? or (p.updated=? and p.id<?)) order by p.updated desc,p.id desc limit ?`
        )
        .all(
          this.scope(actor),
          id,
          id,
          activeOnly ? 1 : 0,
          after?.time ?? null,
          after?.time ?? null,
          after?.time ?? null,
          after?.id ?? null,
          limit + 1
        )
    )
    const page = rows.slice(0, limit).map((j) => ({
      ...j,
      source: /** @type {import('../src/domain/review.ts').Source} */ (
        JSON.parse(j.sourceInput).source
      )
    }))
    const associations = jobAssociations(this.db, this.scope(actor), actor.space, page)
    const jobs = page.map((j) => {
        const source = j.source
        return {
          ...j,
          source,
          sourceInput: undefined,
          conversion: associations.conversions.get(source.resourceId) ?? null,
          approval: /** @type {RecordedApproval|null} */ (
            j.approval ? JSON.parse(j.approval) : null
          ),
          workflowSpace: actor.space,
          automation: associations.automatic.get(j.id) ?? null,
          bundle: /** @type {import('../src/domain/review.ts').Bundle|null} */ (
            j.result ? JSON.parse(j.result) : null
          ),
          result: undefined
        }
      }),
      last = jobs.at(-1)
    return {
      jobs,
      nextCursor: rows.length > limit && last ? pageCursor(last.updated, last.id) : null,
      hasMore: rows.length > limit
    }
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').JobOptions} options */
  jobs(actor, options = {}) {
    return this.jobPage(actor, options).jobs
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').JobOptions} options */
  jobsHaveMore(actor, options = {}) {
    return this.jobPage(actor, options).hasMore
  }
  /** @param {Actor} actor @param {string} id */
  jobView(actor, id) {
    const record = this.job(actor, id),
      job = this.jobs(actor, { id })[0]
    let preparation = null
    if (job.bundle?.manualReview && record.raw) {
      try {
        preparation = preparationReview(JSON.parse(record.input), JSON.parse(record.raw))
      } catch {
        /* A damaged diagnostic must not prevent opening the original review. */
      }
    }
    return {
      ...job,
      preparationReview: preparation,
      processingIssue: processingIssue(this, actor, job.source)
    }
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').PageOptions} options */
  activityPage(actor, options = {}) {
    const { limit, after } = pageOptions(options, 'number'),
      rows = /** @type {import('./workflow-contracts.d.mts').ActivityRow[]} */ (
        this.db
          .prepare(
            'select seq,job,kind,detail,created from activity where scope=? and (? is null or seq<?) order by seq desc limit ?'
          )
          .all(this.scope(actor), after?.time ?? null, after?.time ?? null, limit + 1)
      ),
      events = rows.slice(0, limit).map((e) => ({ ...e, detail: JSON.parse(e.detail) }))
    return {
      events,
      nextCursor:
        rows.length > limit && events.length
          ? pageCursor(events[events.length - 1].seq, 'activity')
          : null
    }
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').PageOptions} options */
  history(actor, options = {}) {
    return this.activityPage(actor, { limit: 200, ...options }).events
  }
  /** @param {Actor} actor @param {string} id */
  job(actor, id) {
    const job = this.journal.get(id)
    if (!job || job.scope !== this.scope(actor))
      throw Object.assign(new WorkflowError('RESOURCE_NOT_FOUND', 'Job not found'), { status: 404 })
    return job
  }
  /** @param {Actor} actor @param {string} id @returns {import('./workflow-contracts.d.mts').DecisionRow|undefined} */
  decision(actor, id) {
    this.job(actor, id)
    return /** @type {import('./workflow-contracts.d.mts').DecisionRow|undefined} */ (
      this.db.prepare('select * from decisions where job=? and actor=?').get(id, actor.account)
    )
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id */
  async location(actor, api, id) {
    const job = this.job(actor, id),
      source = /** @type {import('../src/domain/review.ts').Source} */ (
        JSON.parse(job.input).source
      ),
      decision = this.decision(actor, id)
    const approval = decision?.record && JSON.parse(decision.record),
      target = approval?.actions?.target,
      sourceAPI = source.space === actor.space ? api : this.spaceAdapter(api, source.space),
      targetSpace = approval?.actions?.targetSpace ?? source.space,
      targetAPI = targetSpace === source.space ? sourceAPI : this.spaceAdapter(api, targetSpace)
    const expectedTarget =
      targetSpace === source.space
        ? source.resourceId
        : this.db
            .prepare('select resource from cross_transfers where job=? and scope=?')
            .get(id, this.scope(actor))?.resource
    const found = []
    const mapped =
      /** @type {import('./workflow-contracts.d.mts').FileLocationRow|null|undefined} */ (
        this.db
          .prepare('select * from file_locations where scope=? and resource=? and sha=?')
          .get(
            this.scope(actor),
            this.transfers.canonical(actor, source.resourceId, source.space),
            source.sha256
          )
      )
    const locations = [
      ...(mapped
        ? [
            {
              path: mapped.path,
              api: mapped.space === actor.space ? api : this.spaceAdapter(api, mapped.space),
              space: mapped.space,
              resource: mapped.target_resource
            }
          ]
        : []),
      { path: source.path, api: sourceAPI, space: source.space, resource: source.resourceId },
      ...(target
        ? [{ path: target, api: targetAPI, space: targetSpace, resource: expectedTarget }]
        : [])
    ]
    found.push(...(await this.findRecordedLocations(locations)))
    if (!found.length && decision?.state === 'done') {
      const space = mapped?.space ?? targetSpace,
        resource = mapped?.target_resource ?? expectedTarget
      if (resource) {
        const current = await this.locations.locate(actor, api, String(resource), space)
        if (current) found.push(current)
      }
    }
    if (found.length !== 1)
      throw new WorkflowError(
        'OPERATION_HELD',
        'The original resource could not be located uniquely at its recorded paths. Inspect it in OpenCloud.'
      )
    return {
      path: found[0].path,
      resourceId: found[0].resourceId,
      etag: found[0].etag,
      space: found[0].space,
      tags: found[0].tags
    }
  }
  /** @param {Array<{path:string,api:Adapter,space:string,resource:import('node:sqlite').SQLOutputValue|undefined}>} locations */
  async findRecordedLocations(locations) {
    const found = []
    const seen = new Set()
    for (const item of locations) {
      const key = JSON.stringify([item.space, item.path])
      if (seen.has(key) || !item.resource) continue
      seen.add(key)
      safePath(item.path)
      const current = await item.api.stat(item.path)
      if (current && !current.folder && current.resourceId === item.resource)
        found.push({ ...current, space: item.space })
    }
    return found
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} path @param {import('./proposal-contracts.d.mts').ProposalConfiguration} configuration @param {import('./workflow-contracts.d.mts').PrepareOptions} options */
  async prepare(
    actor,
    api,
    path,
    configuration,
    {
      retry = false,
      newReview = false,
      cloudKey,
      expectedResourceId,
      expectedEtag,
      onProgress = () => {}
    } = {}
  ) {
    const release = this.lock('__prepare__')
    let releaseResource
    /** @type {import('./workflow-contracts.d.mts').PreparationAttempt|undefined} */
    let attempt
    /** @param {import('./workflow-contracts.d.mts').ProcessingStage} stage */
    const progress = (stage) => {
      if (attempt) {
        this.db
          .prepare(
            'update preparation_attempts set stage=?,updated=? where scope=? and space=? and resource=? and owner=?'
          )
          .run(stage, new Date().toISOString(), ...attemptKey(attempt))
      }
      onProgress(stage)
    }
    try {
      safePath(path)
      const before = await api.stat(path)
      if (!before || before.folder)
        throw new WorkflowError('OPERATION_HELD', 'PDF source not found')
      releaseResource = this.lock(
        `resource:${this.scope(actor)}:${this.transfers.canonical(actor, before.resourceId)}`
      )
      this.documentTrash.assertAvailable(actor, before.resourceId)
      if (
        (expectedResourceId !== undefined && expectedResourceId !== before.resourceId) ||
        (expectedEtag !== undefined && expectedEtag !== before.etag)
      )
        throw new WorkflowError(
          'SOURCE_CHANGED',
          'The selected document changed before preparation'
        )
      attempt = this.beginPreparation(actor, api.space ?? actor.space, before)
      progress('reading')
      const { source, input, ocrAttempted } = await this.readPreparedInput(
        actor,
        api,
        path,
        before,
        configuration,
        progress
      )
      if (newReview) {
        this.assertReprocessable(actor, source)
        configuration = { ...configuration, reviewRevision: randomUUID() }
      }
      if (!configuration.rulesOnly) progress('analysing')
      this.event(actor, null, 'preparation_started', { path, resourceId: source.resourceId })
      return await this.generatePrepared(
        actor,
        path,
        input,
        configuration,
        {
          retry,
          cloudKey,
          newReview,
          ocrAttempted,
          onProgress: progress
        },
        attempt
      )
    } catch (error) {
      if (attempt)
        this.db
          .prepare(
            "update preparation_attempts set state='failed',issue=?,updated=? where scope=? and space=? and resource=? and owner=?"
          )
          .run(
            JSON.stringify({ ...preparationIssue(error), retryable: false }),
            new Date().toISOString(),
            ...attemptKey(attempt)
          )
      throw error
    } finally {
      if (attempt) this.preparationOwners.delete(attempt.owner)
      releaseResource?.()
      release()
    }
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} path
   * @param {import('./contracts.d.mts').FileEntry} before
   * @param {import('./proposal-contracts.d.mts').ProposalConfiguration} configuration
   * @param {(stage:import('./workflow-contracts.d.mts').ProcessingStage)=>void} progress */
  async readPreparedInput(actor, api, path, before, configuration, progress) {
    const settings = this.configuration.settings(actor)
    const { source, input, ocrAttempted } = await readDocument({
      actor,
      api,
      path,
      before,
      configuration,
      limits: settings.limits,
      progress,
      onOCR: (source) =>
        this.event(actor, null, 'ocr_extracted', {
          resourceId: source.resourceId,
          languages: configuration.ocrLanguages
        })
    })
    {
      input.rules = settings.rules
      const targetSpace = this.configuration.destinationSpace(actor)
      if (targetSpace !== source.space) input.destinationSpace = targetSpace
    }
    if (configuration.tagDiscovery && configuration.policy.tags !== 'off') {
      progress('tagging')
      // Never propose new names when the authenticated directory could not be read.
      if (!api.listTags)
        throw new WorkflowError(
          'DEPENDENCY_UNAVAILABLE',
          'The tag directory is unavailable for semantic tag review'
        )
      const native = await api.listTags(),
        saved = this.metadata.schema(actor).tags.map((row) => row.tag)
      input.tagDiscovery = {
        mode: configuration.tagDiscovery,
        catalog: tagCatalog([
          ...native,
          ...saved,
          ...settings.rules.tags.map((row) => row.value),
          ...before.tags
        ])
      }
    }
    return { source, input, ocrAttempted }
  }
  /** @param {Actor} actor @param {string} space @param {import('./contracts.d.mts').FileEntry} before */
  beginPreparation(actor, space, before) {
    const lockKey = `resource:${this.scope(actor)}:${this.transfers.canonical(actor, before.resourceId)}`,
      owner = this.db.prepare('select owner from workflow_locks where job=?').get(lockKey)?.owner,
      now = new Date().toISOString()
    if (typeof owner !== 'string')
      throw new WorkflowError('INTERNAL_ERROR', 'Preparation ownership is missing')
    const attempt = { scope: this.scope(actor), space, resource: before.resourceId, owner }
    this.preparationOwners.add(owner)
    this.db
      .prepare(
        'insert into preparation_attempts values(?,?,?,?,?,?,?,?,?,?,?) on conflict(scope,space,resource) do update set etag=excluded.etag,state=excluded.state,stage=excluded.stage,job=NULL,issue=NULL,started=excluded.started,updated=excluded.updated,owner=excluded.owner'
      )
      .run(
        attempt.scope,
        attempt.space,
        attempt.resource,
        before.etag,
        'running',
        'reading',
        null,
        null,
        now,
        now,
        owner
      )
    return attempt
  }
  /** @param {Actor} actor @param {string} path @param {import('../src/domain/review.ts').DocumentInput} input
   * @param {import('./proposal-contracts.d.mts').ProposalConfiguration} configuration
   * @param {import('./workflow-contracts.d.mts').PrepareOptions & {ocrAttempted:boolean}} options
   * @param {import('./workflow-contracts.d.mts').PreparationAttempt} attempt
   */
  async generatePrepared(
    actor,
    path,
    input,
    configuration,
    { retry, cloudKey, newReview, ocrAttempted, onProgress },
    attempt
  ) {
    const source = input.source
    try {
      const result = await this.journal.prepare(input, configuration, {
        retry,
        cloudKey,
        scope: this.scope(actor),
        manualFallback: true,
        ocrAttempted,
        onProgress
      })
      if (result.review.ruleMatch && !result.cached)
        this.event(actor, result.id, 'filing_rule_matched', { category: result.review.ruleMatch })
      this.event(actor, result.id, result.cached ? 'proposal_reopened' : result.review.state, {
        path
      })
      this.db
        .prepare(
          "update preparation_attempts set state='prepared',stage='review',job=?,updated=? where scope=? and space=? and resource=? and owner=?"
        )
        .run(result.id, new Date().toISOString(), ...attemptKey(attempt))
      if (newReview)
        this.db
          .prepare(
            "update intake_queue set job=?,state='prepared',stage='review',detail=NULL,issue=NULL where scope=? and resource=? and etag=? and path=? and state in ('prepared','failed')"
          )
          .run(result.id, this.scope(actor), source.resourceId, source.etag, source.path)
      return { id: result.id, bundle: result.review.bundle, cached: result.cached }
    } catch (e) {
      this.event(actor, null, 'preparation_held', { path })
      throw e
    }
  }
  /** @param {Actor} actor @param {import('../src/domain/review.ts').Source} source */
  assertReprocessable(actor, source) {
    const resource = this.transfers.canonical(actor, source.resourceId, source.space)
    const scope = this.scope(actor),
      resources = resourceIdentities(this.db, scope, source.resourceId, resource)
    if (
      hasPendingFiling(this.db, scope, resources) ||
      hasPendingAutomation(this.db, scope, resources)
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Finish or verify the existing operation before reprocessing this document'
      )
    if (hasPendingMetadata(this.db, scope, this.metadata.key(actor, source.resourceId)))
      throw new WorkflowError(
        'OPERATION_HELD',
        'Verify the pending metadata change before reprocessing this document'
      )
  }
  /** @param {Actor} actor @param {Adapter} api @param {{path:string,resourceId:string,etag:string}} input */
  async prepareOriginal(actor, api, { path, resourceId, etag }) {
    safePath(path)
    if (/\.pdf$/i.test(path) || typeof resourceId !== 'string' || typeof etag !== 'string')
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Choose an original non-PDF file for manual filing'
      )
    const release = this.lock('__prepare__')
    let resourceLock
    try {
      const canonical = this.transfers.canonical(actor, resourceId)
      resourceLock = this.lock(`resource:${this.scope(actor)}:${canonical}`)
      this.documentTrash.assertAvailable(actor, resourceId)
      const scope = this.scope(actor),
        resources = resourceIdentities(this.db, scope, resourceId, canonical)
      if (hasPendingFiling(this.db, scope, resources))
        throw new WorkflowError(
          'OPERATION_HELD',
          'Finish or verify the existing operation before reprocessing this document'
        )
      if (hasPendingMetadata(this.db, scope, canonical))
        throw new WorkflowError(
          'OPERATION_HELD',
          'Verify the pending metadata change before reprocessing this document'
        )
      const file = await this.metadata.inspect(actor, api, path)
      if (file.resourceId !== resourceId || file.etag !== etag)
        throw new WorkflowError(
          'SOURCE_CHANGED',
          'The selected document changed before preparation'
        )
      const source = {
          server: actor.server,
          account: actor.account,
          space: api.space ?? actor.space,
          path,
          resourceId,
          etag,
          sha256: file.sha256
        },
        rules = this.configuration.settings(actor).rules,
        destinationSpace = this.configuration.destinationSpace(actor)
      const input = {
          schemaVersion: 1,
          source,
          pages: [],
          rules,
          ...(destinationSpace !== source.space ? { destinationSpace } : {})
        },
        bundle = validateBundle({
          ...input,
          proposal: null,
          manualReview: { reason: 'original' }
        }).bundle,
        id = sha(Buffer.from(JSON.stringify({ input, revision: randomUUID() })))
      this.db
        .prepare(
          'insert into proposals(id,scope,input,configuration,state,result,updated) values(?,?,?,?,?,?,?)'
        )
        .run(
          id,
          this.scope(actor),
          JSON.stringify(input),
          '{}',
          'needs_details',
          JSON.stringify(bundle),
          new Date().toISOString()
        )
      this.event(actor, id, 'manual_filing_prepared', { path, resourceId })
      return { id, bundle, cached: false }
    } finally {
      resourceLock?.()
      release()
    }
  }
  /** @param {Pick<import('./contracts.d.mts').DocumentReader,'stat'|'get'>} api @param {string} path @param {Pick<import('../src/domain/review.ts').Source,'resourceId'|'sha256'> & Partial<Actor>} source @param {string} [etag] @param {Actor} [limitActor] */
  async check(api, path, source, etag, limitActor) {
    const current = await api.stat(path)
    if (
      !current ||
      current.folder ||
      current.resourceId !== source.resourceId ||
      (etag && current.etag !== etag)
    )
      return null
    const bytes = await api.get(
      path,
      current.etag,
      (this.configuration.settings(limitActor ?? this.sourceActor(source)).limits.maxMiB ?? 100) *
        1024 *
        1024
    )
    if (sha(bytes) !== source.sha256) return null
    const after = await api.stat(path)
    if (after?.etag !== current.etag || after?.resourceId !== source.resourceId) return null
    return current
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id @param {import('../src/domain/review.ts').Policy} policy @param {string} digest @param {import('../src/domain/review.ts').ManualActions} [manualActions] @param {{automaticAuthorization?:import('./workflow-contracts.d.mts').AutomaticAuthorization}} options */
  async approve(actor, api, id, policy, digest, manualActions, options = {}) {
    /** @type {(api:Pick<import('./contracts.d.mts').DocumentReader,'stat'|'get'>,path:string,source:import('../src/domain/review.ts').Source,etag?:string)=>ReturnType<Workflow['check']>} */
    const check = (api, path, source, etag) => this.check(api, path, source, etag, actor)
    const job = this.job(actor, id)
    if (!job.result) throw new WorkflowError('OPERATION_HELD', 'A validated proposal is required')
    const old = this.decision(actor, id)
    if (old && old.state !== 'rejected')
      throw new WorkflowError(
        'OPERATION_HELD',
        'Decision already recorded; inspect its current status'
      )
    const review = validateBundle(JSON.parse(job.result))
    if (review.state === 'needs_details' && options.automaticAuthorization)
      throw new WorkflowError('OPERATION_HELD', 'Manual filing details require human review')
    if (api.space && api.space !== review.bundle.source.space)
      api = await this.requiredTransfers().adapter(actor, api, review.bundle.source.space)
    if (digest !== (await reviewDigest(review, policy, manualActions)))
      throw new WorkflowError('SOURCE_CHANGED', 'Review changed; reload and review again')
    if (
      !(await check(
        api,
        review.bundle.source.path,
        review.bundle.source,
        review.bundle.source.etag
      ))
    )
      throw new WorkflowError('SOURCE_CHANGED', 'Source changed; prepare and review a new proposal')
    this.documentTrash.assertAvailable(actor, review.bundle.source.resourceId)
    /** @type {RecordedApproval} */
    const record = await createApproval(review, policy, manualActions)
    if (record.actions.targetSpace)
      await this.requiredTransfers().adapter(actor, api, record.actions.targetSpace)
    if (options.automaticAuthorization) {
      delete record.reviewedAt
      record.automaticAuthorization = options.automaticAuthorization
      record.authorizedAt = options.automaticAuthorization.authorizedAt
    }
    this.documentTrash.assertAvailable(actor, review.bundle.source.resourceId)
    const saved = this.db
      .prepare(
        "insert into decisions(job,actor,record,state,updated) values(?,?,?,'approved',?) on conflict(job) do update set record=excluded.record,state='approved',plan=NULL,updated=excluded.updated WHERE decisions.state='rejected'"
      )
      .run(id, actor.account, JSON.stringify(record), new Date().toISOString())
    if (!saved.changes)
      throw new WorkflowError(
        'OPERATION_HELD',
        'Another decision was recorded; reload before continuing'
      )
    this.event(
      actor,
      id,
      options.automaticAuthorization ? 'automatically_authorized' : 'approved',
      { target: record.actions.target, tags: record.actions.addTags }
    )
    return { state: 'approved' }
  }
  /** @param {Actor} actor @param {string} id */
  reject(actor, id) {
    const job = this.job(actor, id)
    if (this.decision(actor, id))
      throw new WorkflowError('OPERATION_HELD', 'A decision is already recorded')
    this.db
      .prepare("insert into decisions(job,actor,record,state,updated) values(?,?,?,'rejected',?)")
      .run(id, actor.account, '{}', new Date().toISOString())
    this.event(actor, job.id, 'rejected')
    return { state: 'rejected' }
  }
  /** @param {string} id */
  lock(id) {
    const owner = randomUUID(),
      owners = this.journal.runtime.locks
    withTransaction(this.db, () => {
      const previous = this.db.prepare('select owner from workflow_locks where job=?').get(id)
      if (previous && typeof previous.owner === 'string' && owners.has(previous.owner))
        throw new WorkflowError('WORKFLOW_BUSY', 'Operation already running')
      // The runtime guard excludes another process; only abandoned rows reach here.
      this.db.prepare('delete from workflow_locks where job=?').run(id)
      this.db
        .prepare("insert into workflow_locks(job,owner,pid,host) values(?,?,0,'')")
        .run(id, owner)
    })
    owners.add(owner)
    return () => {
      this.db.prepare('delete from workflow_locks where job=? and owner=?').run(id, owner)
      owners.delete(owner)
    }
  }
  /** @param {Actor} actor @param {string} id @param {string} state @param {Partial<import('./contracts.d.mts').TransferPlan>} plan */
  set(actor, id, state, plan) {
    this.db
      .prepare('update decisions set state=?,plan=?,updated=? where job=? and actor=?')
      .run(state, JSON.stringify(plan), new Date().toISOString(), id, actor.account)
    this.event(actor, id, state)
    if (state === 'done' && plan) {
      const decision = this.decision(actor, id)
      if (!decision) throw new WorkflowError('OPERATION_HELD', 'Filing decision is missing')
      /** @type {RecordedApproval} */
      const approval = JSON.parse(decision.record)
      if (!approval.actions.targetSpace) {
        const canonical = this.transfers.canonical(
          actor,
          approval.source.resourceId,
          approval.source.space
        )
        if (canonical !== approval.source.resourceId)
          this.db
            .prepare('update file_locations set path=?,job=? where scope=? and resource=?')
            .run(approval.actions.target, id, this.scope(actor), canonical)
      }
    }
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id @param {{reconcileOnly?:boolean}} options */
  async apply(actor, api, id, { reconcileOnly = false } = {}) {
    this.job(actor, id)
    /** @type {(api:Pick<import('./contracts.d.mts').DocumentReader,'stat'|'get'>,path:string,source:import('../src/domain/review.ts').Source,etag?:string)=>ReturnType<Workflow['check']>} */
    const check = (api, path, source, etag) => this.check(api, path, source, etag, actor)
    const release = this.lock(id)
    let releaseResource
    try {
      const decision = this.decision(actor, id)
      if (!decision || decision.state === 'rejected')
        throw new WorkflowError('OPERATION_HELD', 'Human approval is required')
      /** @type {RecordedApproval} */
      const approval = JSON.parse(decision.record),
        source = approval.source,
        target = approval.actions.target,
        tags = approval.actions.addTags
      releaseResource = this.lock(
        `resource:${this.scope(actor)}:${this.transfers.canonical(actor, source.resourceId, source.space)}`
      )
      this.documentTrash.assertAvailable(actor, source.resourceId)
      if (api.space && source.space !== api.space)
        api = await this.requiredTransfers().adapter(actor, api, source.space)
      const result = this.job(actor, id).result
      if (!result) throw new WorkflowError('OPERATION_HELD', 'A validated proposal is required')
      const review = validateBundle(JSON.parse(result))
      if (!(await approvalMatches(approval, review.bundle, approval.policy)))
        throw new WorkflowError('SOURCE_CHANGED', 'Approval no longer matches the proposal')
      const guard = () => {
        if (approval.automaticAuthorization) {
          this.automation.guard(actor, id, approval.automaticAuthorization)
        }
      }
      const state = decision.state
      let plan = readFilingPlan(decision.plan ? JSON.parse(decision.plan) : {})
      if (
        !reconcileOnly &&
        state !== 'done' &&
        this.db
          .prepare(
            "select id from metadata_changes where scope=? and resource=? and state='intent' limit 1"
          )
          .get(this.scope(actor), this.transfers.canonical(actor, source.resourceId, source.space))
      )
        throw new WorkflowError(
          'OPERATION_HELD',
          'A metadata save needs verification. Open custom fields and recheck it before filing.'
        )
      const conflict = () => {
        this.set(actor, id, 'conflict', plan)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Remote state conflicts with the approved operation; no further writes made'
        )
      }
      if (state === 'conflict')
        throw new WorkflowError('OPERATION_HELD', 'Conflict requires a new reviewed proposal')
      if (state === 'done') return await this.verifyFiled(actor, api, id, source, decision, plan)

      if (approval.actions.targetSpace) {
        if (!plan.originalTags) {
          const current = await check(api, source.path, source, source.etag)
          if (!current) return conflict()
          plan = {
            originalTags: current.tags,
            expectedTags: [...new Set([...current.tags, ...tags])].sort()
          }
        }
        return await this.requiredTransfers().apply(
          actor,
          api,
          id,
          {
            ...approval,
            actions: { ...approval.actions, targetSpace: approval.actions.targetSpace }
          },
          requireFilingPlan(plan),
          { reconcileOnly, guard }
        )
      }
      return await applyFiling({
        api,
        source,
        target,
        tags,
        state,
        plan,
        reconcileOnly,
        check,
        guard,
        save: (next, nextPlan) => this.set(actor, id, next, nextPlan),
        event: (kind, detail) => this.event(actor, id, kind, detail)
      })
    } finally {
      releaseResource?.()
      release()
    }
  }
  /** Verify an already-filed item without rewriting its original approval.
   * Called under apply's job and resource locks.
   * @param {Actor} actor @param {Adapter} api @param {string} id
   * @param {import('../src/domain/review.ts').Source} source
   * @param {import('./workflow-contracts.d.mts').DecisionRow} decision
   * @param {Partial<import('./contracts.d.mts').FilingPlan>} plan
   */
  async verifyFiled(actor, api, id, source, decision, plan) {
    const current = await this.location(actor, api, id),
      physical =
        current.space === api.space
          ? api
          : await this.requiredTransfers().adapter(actor, api, current.space)
    const final = await this.check(
      physical,
      current.path,
      {
        ...source,
        resourceId: current.resourceId
      },
      undefined,
      actor
    )
    const latestMetadata = this.db
      .prepare(
        "select tags from metadata_changes where scope=? and resource=? and sha=? and state='done' and created>=? order by base desc,created desc,id desc limit 1"
      )
      .get(
        this.scope(actor),
        this.transfers.canonical(actor, source.resourceId, source.space),
        source.sha256,
        decision.updated
      )
    /** @type {string[]} */
    const expectedTags = latestMetadata
      ? JSON.parse(String(latestMetadata.tags))
      : requireFilingPlan(plan).expectedTags
    if (!final || !expectedTags.every((tag) => final.tags.includes(tag)))
      throw new WorkflowError(
        'SOURCE_CHANGED',
        'The filed document changed. Review its current contents and tags; the original filing record is retained.'
      )
    return {
      state: 'done',
      target: current.path,
      tags: final.tags,
      verification: {
        checkedAt: new Date().toISOString(),
        resourceId: final.resourceId,
        sha256: source.sha256
      }
    }
  }
}

/** @param {import('./workflow-contracts.d.mts').PreparationAttempt} attempt */
function attemptKey({ scope, space, resource, owner }) {
  return [scope, space, resource, owner]
}
