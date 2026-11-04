// SPDX-License-Identifier: AGPL-3.0-only
import { logEvent } from './logging.mjs'
import { errorCode, WorkflowError } from '../src/domain/errors.ts'
import { createHash } from 'node:crypto'
import { validateBundle, validatePolicy, actions, reviewDigest } from '../src/domain/review.ts'
import { automaticFields } from './automatic-fields.mjs'
import { suggestMetadata } from '../src/domain/metadata.ts'
/** @param {unknown} value */
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class Automation {
  /** @param {import('./workflow.mjs').Workflow} workflow @param {import('./metadata.mjs').Metadata} metadata @param {import('./intake.mjs').Intake} intake @param {{logger?:import('./contracts.d.mts').Logger}} options */
  constructor(workflow, metadata, intake, { logger = logEvent } = {}) {
    this.w = workflow
    this.db = workflow.db
    this.metadata = metadata
    this.intake = intake
    this.logger = logger
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  settings(actor) {
    const preferences = this.w.preference(actor),
      inbox = this.intake.configuration(actor)
    return {
      preferences,
      inbox,
      schema: this.metadata.schema(actor),
      processing: this.w.configuration
        ? {
            ...this.w.configuration.settings(actor),
            ...(this.w.configuration.destinationSpace(actor) !== actor.space
              ? { destinationSpace: this.w.configuration.destinationSpace(actor) }
              : {})
          }
        : null,
      ocr:
        this.db.prepare('select languages from ocr_settings where scope=?').get(this.w.scope(actor))
          ?.languages ?? '[]'
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  snapshot(actor) {
    const value = this.settings(actor)
    return { ...value, hash: digest(value) }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('../src/domain/review.ts').Source} source */
  eligibility(actor, source) {
    const { preferences, inbox } = this.settings(actor)
    if (!preferences || !inbox.enabled) return 'Background ingestion is paused'
    const policy = validatePolicy(preferences.policy)
    if (policy.aiInput !== 'automatic' || policy.aiOutput !== 'automatic')
      return 'AI processing is set to review'
    if ([policy.rename, policy.move, policy.tags].includes('suggest'))
      return 'Filing has stages set to Suggest'
    if (policy.ocr === 'suggest') return 'OCR is set to Suggest'
    if ((policy.fields ?? 'suggest') === 'suggest') return 'Fields are set to Suggest'
    if (
      !source.path.startsWith(inbox.folder + '/') ||
      (!inbox.recursive && source.path.slice(inbox.folder.length + 1).includes('/'))
    )
      return 'The document is outside the saved inbox'
    return null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @param {import('./workflow-contracts.d.mts').AutomaticAuthorization} record */
  guard(actor, id, record) {
    const saved = /** @type {import('./orchestration-contracts.d.mts').AutomaticRun|undefined} */ (
      this.db
        .prepare('select * from automatic_runs where job=? and scope=?')
        .get(id, this.w.scope(actor))
    )
    if (
      !saved ||
      !['pending', 'running'].includes(saved.state) ||
      saved.authorization !== JSON.stringify(record) ||
      this.snapshot(actor).hash !== record.hash ||
      !this.intake.configuration(actor).enabled
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Automatic processing settings changed or were paused; inspect this operation before continuing'
      )
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @param {string} state @param {string|null} detail */
  update(actor, id, state, detail = null) {
    const changed = this.db
      .prepare(
        "update automatic_runs set state=?,detail=?,updated=? where job=? and scope=? and (state<>'cancelled' or ?='done')"
      )
      .run(state, detail, new Date().toISOString(), id, this.w.scope(actor), state)
    if (changed.changes)
      this.w.event(actor, id, 'automatic_' + state, detail ? { reason: detail } : {})
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api */
  async resume(actor, api) {
    for (const row of this.db
      .prepare(
        "select job from automatic_runs where scope=? and state in ('pending','running') order by created"
      )
      .all(this.w.scope(actor))) {
      if (this.intake.paused(actor)) break
      await this.run(actor, api, String(row.job))
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {{retry?:boolean,allowPaused?:boolean}} options */
  async run(actor, api, id, options = {}) {
    this.w.job(actor, id)
    let release
    try {
      release = this.w.lock('automatic:' + id)
    } catch (e) {
      if (errorCode(e) === 'WORKFLOW_BUSY') return { state: 'running' }
      throw e
    }
    try {
      return await this.execute(actor, api, id, options)
    } finally {
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {{retry?:boolean,allowPaused?:boolean}} options */
  async execute(actor, api, id, { retry = false, allowPaused = false } = {}) {
    const job = this.w.job(actor, id),
      source = JSON.parse(job.input).source
    let prior = /** @type {import('./orchestration-contracts.d.mts').AutomaticRun|undefined} */ (
      this.db
        .prepare('select * from automatic_runs where job=? and scope=?')
        .get(id, this.w.scope(actor))
    )
    if (this.intake.paused(actor) && !allowPaused) return { state: 'paused' }
    if (retry && prior && ['review', 'held', 'cancelled'].includes(prior.state))
      prior = this.reauthorize(actor, id, prior)
    if (prior && ['done', 'review', 'held', 'cancelled'].includes(prior.state))
      return { state: prior.state, detail: prior.detail }
    const issue = this.eligibility(actor, source)
    if (issue) {
      if (prior) this.update(actor, id, 'held', issue)
      return { state: 'review', detail: issue }
    }
    return this.executeReview(actor, api, id, job, source, prior)
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id
   * @param {ReturnType<import('./workflow.mjs').Workflow['job']>} job
   * @param {import('../src/domain/review.ts').Source} source
   * @param {import('./orchestration-contracts.d.mts').AutomaticRun|undefined} prior */
  async executeReview(actor, api, id, job, source, prior) {
    const queue = this.db
      .prepare("select id from intake_queue where scope=? and job=? and state='prepared'")
      .get(this.w.scope(actor), id)
    if (!queue)
      throw new WorkflowError(
        'OPERATION_HELD',
        'Automatic processing requires a prepared arrival from the saved inbox'
      )
    const review = job.result ? validateBundle(JSON.parse(job.result)) : null
    if (!review?.proposal)
      return { state: 'review', detail: 'The document needs text extraction or valid evidence' }
    const issueAfterReview = await this.reviewIssue(actor, api, id, review)
    if (issueAfterReview) {
      if (prior) this.update(actor, id, 'held', issueAfterReview)
      return { state: 'review', detail: issueAfterReview }
    }
    const authorization = this.authorize(actor, id, !!prior)
    try {
      return await this.executeAuthorized(actor, api, id, source, review, authorization)
    } catch (e) {
      return this.recordFailure(actor, id, e)
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @param {unknown} e */
  recordFailure(actor, id, e) {
    if (this.statusFor(actor, id)?.state === 'cancelled') return { state: 'cancelled' }
    if (errorCode(e) === 'WORKFLOW_BUSY') {
      this.update(actor, id, 'pending')
      return { state: 'pending' }
    }
    this.logger('automation_held', e)
    this.update(
      actor,
      id,
      'held',
      e instanceof Error && e.message.length < 200
        ? e.message
        : 'Automatic processing needs attention'
    )
    return {
      state: 'held',
      detail: e instanceof Error ? e.message : 'Automatic processing needs attention'
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {ReturnType<typeof validateBundle>} review */
  async reviewIssue(actor, api, id, review) {
    if (
      review.bundle.tagDiscovery &&
      review.bundle.tagDiscovery.mode !== this.w.preference(actor)?.ai.tagDiscovery
    )
      return 'AI tag review settings changed; prepare new suggestions'
    if ((await this.w.similarities.forJob(actor, api, id)).length)
      return 'Potential duplicate needs review'
    return null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {import('../src/domain/review.ts').Source} source @param {ReturnType<typeof validateBundle>} review @param {import('./orchestration-contracts.d.mts').Authorization} authorization */
  async executeAuthorized(actor, api, id, source, review, authorization) {
    this.guard(actor, id, authorization)
    const identity = await api.identity()
    if (this.w.scope(identity) !== this.w.scope(actor))
      throw new WorkflowError('OPERATION_HELD', 'The authenticated workspace changed')
    if (!authorization.configuration.preferences)
      throw new WorkflowError('OPERATION_HELD', 'Automatic preferences are missing')
    const policy = authorization.configuration.preferences.policy,
      decision = this.w.decision(actor, id)
    if (decision && !JSON.parse(decision.record).automaticAuthorization) {
      this.update(actor, id, 'review', 'A separate document decision already exists')
      return { state: 'review', detail: 'A separate document decision already exists' }
    }
    if (review.ruleAmbiguous)
      throw new WorkflowError(
        'OPERATION_HELD',
        'More than one explicit filing category matches; inspect the rules and destination'
      )
    if (review.excluded.length)
      throw new WorkflowError(
        'OPERATION_HELD',
        'Some proposed tags lack supporting evidence and need review'
      )
    this.update(actor, id, 'running')
    // Existing field values are preserved; only grounded, unambiguous missing values are filled.
    if (!decision) {
      const result = await this.approveAutomatic(
        actor,
        api,
        id,
        source,
        review,
        policy,
        authorization
      )
      if (result) return result
    }
    this.guard(actor, id, authorization)
    const result = await this.w.apply(actor, api, id)
    if ('uncertain' in result && result.uncertain) {
      this.update(actor, id, 'held', 'The last file or tag outcome needs read-only verification')
      return result
    }
    this.update(actor, id, 'done')
    return result
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {import('../src/domain/review.ts').Source} source @param {ReturnType<typeof validateBundle>} review @param {import('./orchestration-contracts.d.mts').Authorization} authorization @param {import('../src/domain/review.ts').Policy} policy */
  async approveAutomatic(actor, api, id, source, review, policy, authorization) {
    if (!(await this.w.check(api, source.path, source, source.etag)))
      throw new WorkflowError('SOURCE_CHANGED', 'The source changed before automatic processing')
    const suggestions = await this.fillFields(actor, api, id, source, review, policy, authorization)
    const planned = actions(review, policy)
    if (!planned)
      throw new WorkflowError('OPERATION_HELD', 'The document needs valid filing evidence')
    const manual = {
      target: planned.target,
      addTags:
        policy.tags === 'automatic'
          ? [...new Set([...planned.addTags, ...suggestions.tags.map((t) => t.value)])]
          : []
    }
    this.guard(actor, id, authorization)
    if (!planned.targetSpace && manual.target === source.path && !manual.addTags.length) {
      this.update(actor, id, 'done')
      return { state: 'done', metadataOnly: true }
    }
    await this.w.approve(
      actor,
      api,
      id,
      policy,
      await reviewDigest(review, policy, manual),
      manual,
      { automaticAuthorization: authorization }
    )
    return null
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @param {boolean} prior */
  authorize(actor, id, prior) {
    if (!prior) {
      const snap = this.snapshot(actor),
        authorization = {
          kind: 'automatic',
          hash: snap.hash,
          configuration: snap,
          account: actor.account,
          space: actor.space,
          authorizedAt: new Date().toISOString()
        }
      this.db
        .prepare("insert or ignore into automatic_runs values(?,?,?,'pending',NULL,?,?)")
        .run(
          id,
          this.w.scope(actor),
          JSON.stringify(authorization),
          authorization.authorizedAt,
          authorization.authorizedAt
        )
    }
    const saved = this.db.prepare('select authorization from automatic_runs where job=?').get(id)
    if (!saved) throw new WorkflowError('OPERATION_HELD', 'Automatic authorization is missing')
    const authorization = /** @type {import('./orchestration-contracts.d.mts').Authorization} */ (
      JSON.parse(String(saved.authorization))
    )

    return authorization
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @param {import('./orchestration-contracts.d.mts').AutomaticRun} prior */
  reauthorize(actor, id, prior) {
    if (this.w.decision(actor, id))
      throw new WorkflowError(
        'OPERATION_HELD',
        'Inspect or take over the existing filing decision first'
      )
    this.w.event(actor, id, 'automatic_reauthorized', {
      previousAuthorization: JSON.parse(prior.authorization)
    })
    const snap = this.snapshot(actor),
      authorization = {
        kind: 'automatic',
        hash: snap.hash,
        configuration: snap,
        account: actor.account,
        space: actor.space,
        authorizedAt: new Date().toISOString()
      }
    this.db
      .prepare(
        "update automatic_runs set state='pending',authorization=?,detail=NULL,updated=? where job=? and scope=?"
      )
      .run(JSON.stringify(authorization), authorization.authorizedAt, id, this.w.scope(actor))
    const updated =
      /** @type {import('./orchestration-contracts.d.mts').AutomaticRun|undefined} */ (
        this.db.prepare('select * from automatic_runs where job=?').get(id)
      )
    if (!updated) throw new WorkflowError('OPERATION_HELD', 'Automatic authorization is missing')
    prior = updated
    return prior
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id
   * @param {import('../src/domain/review.ts').Source} source @param {ReturnType<typeof validateBundle>} review
   * @param {import('../src/domain/review.ts').Policy} policy @param {import('./orchestration-contracts.d.mts').Authorization} authorization */
  async fillFields(actor, api, id, source, review, policy, authorization) {
    const schema = this.metadata.schema(actor),
      suggestions = suggestMetadata(schema, review.bundle.pages),
      current = this.metadata.read(actor, source.resourceId)
    if (policy.fields === 'automatic') {
      const fields = automaticFields(
        schema,
        review.bundle.pages,
        current.fields,
        suggestions.fields
      )
      if (Object.entries(fields).some(([id, value]) => current.fields[id] !== value)) {
        this.guard(actor, id, authorization)
        await this.metadata.save(actor, api, {
          path: source.path,
          resourceId: source.resourceId,
          etag: source.etag,
          sha256: source.sha256,
          version: current.version,
          fields,
          addTags: []
        })
      }
    }
    return suggestions
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} id @param {string} shownDigest */
  async takeOver(actor, api, id, shownDigest) {
    const release = this.w.lock('automatic:' + id)
    try {
      const decision = this.w.decision(actor, id),
        run = this.statusFor(actor, id)
      if (!run)
        throw new WorkflowError('OPERATION_HELD', 'No automatic operation exists for this document')
      if (!decision) {
        this.update(actor, id, 'review', 'Taken over for manual review')
        return { state: 'review' }
      }
      const record = JSON.parse(decision.record)
      if (!record.automaticAuthorization || shownDigest !== record.reviewDigest)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Reload and inspect the saved filing plan before taking over'
        )
      if (['done', 'conflict', 'rejected'].includes(decision.state))
        throw new WorkflowError(
          'OPERATION_HELD',
          'This decision cannot be taken over; inspect its current status'
        )
      const checked = await this.w.apply(actor, api, id, { reconcileOnly: true })
      if ('uncertain' in checked && checked.uncertain)
        throw new WorkflowError(
          'OPERATION_HELD',
          'The last request outcome is uncertain; verify it before taking over'
        )
      if (checked.state === 'done') {
        this.update(actor, id, 'done', 'Outcome confirmed by read-only verification')
        return checked
      }
      const releaseDecision = this.w.lock(id)
      try {
        const current = this.w.decision(actor, id)
        if (!current || current.record !== decision.record)
          throw new WorkflowError('OPERATION_HELD', 'The filing plan changed; reload it')
        this.w.event(actor, id, 'automatic_taken_over', {
          previousAuthorization: record.automaticAuthorization,
          state: current.state
        })
        record.manualTakeover = {
          previousAuthorization: record.automaticAuthorization,
          reviewedAt: new Date().toISOString()
        }
        delete record.automaticAuthorization
        record.reviewedAt = record.manualTakeover.reviewedAt
        this.db
          .prepare('update decisions set record=?,updated=? where job=? and actor=?')
          .run(JSON.stringify(record), record.reviewedAt, id, actor.account)
        this.update(actor, id, 'review', 'Taken over for manual filing')
        return { state: current.state }
      } finally {
        releaseDecision()
      }
    } finally {
      release()
    }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {string} id @returns {import('./orchestration-contracts.d.mts').AutomaticRun|null} */
  statusFor(actor, id) {
    return /** @type {import('./orchestration-contracts.d.mts').AutomaticRun|null} */ (
      this.db
        .prepare(
          'select job,state,detail,created,updated from automatic_runs where job=? and scope=?'
        )
        .get(id, this.w.scope(actor)) ?? null
    )
  }
  /** @param {import('./contracts.d.mts').Actor} actor @returns {import('./orchestration-contracts.d.mts').AutomaticRun[]} */
  status(actor) {
    return /** @type {import('./orchestration-contracts.d.mts').AutomaticRun[]} */ (
      this.db
        .prepare(
          'select job,state,detail,created,updated from automatic_runs where scope=? order by created desc'
        )
        .all(this.w.scope(actor))
    )
  }
}
