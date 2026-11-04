// SPDX-License-Identifier: AGPL-3.0-only
import {
  defaultIntake,
  validateIntake,
  intakeBucket,
  intakeRetryable,
  intakeCancellable
} from './intake-policy.mjs'
export { defaultIntake, validateIntake } from './intake-policy.mjs'
import { withTransaction } from './transactions.mjs'
import { WorkflowError, errorCode } from '../src/domain/errors.ts'
import { responseRecord } from './provider-response.mjs'
import { logEvent } from './logging.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { intakeStatus } from './intake-status.mjs'
import { safePath } from '../src/domain/review.ts'
import { preparationIssue } from './processing-issues.mjs'
/** @typedef {import('./workflow-contracts.d.mts').Actor} Actor */
/** @typedef {import('./contracts.d.mts').MutationAdapter} Adapter */
/** @typedef {import('./workflow-contracts.d.mts').IntakeRecord} IntakeRecord */
/** @typedef {import('./workflow-contracts.d.mts').IntakeQueueRow} QueueRow */
/** @typedef {import('./workflow-contracts.d.mts').IntakeConfiguration} IntakeConfiguration */
/** @typedef {import('./workflow-contracts.d.mts').IntakeSession} Session */
/** @typedef {import('./workflow-contracts.d.mts').ManualCheck} ManualCheck */
/** @param {string|Buffer} b */
const sha = (b) => createHash('sha256').update(b).digest('hex')
export class Intake {
  /** @type {ReturnType<typeof setInterval>|undefined} */
  timer

  /** @param {import('./workflow.mjs').Workflow} workflow @param {import('./workflow-contracts.d.mts').IntakeOptions} options */
  constructor(
    workflow,
    {
      logger = logEvent,
      prepare,
      processPrepared,
      resume,
      now = () => Date.now(),
      schedule = setTimeout,
      cancel = clearTimeout
    } = {}
  ) {
    this.logger = logger
    this.w = workflow
    this.db = workflow.db
    this.prepare = prepare
    this.processPrepared = processPrepared
    this.resume = resume
    this.now = now
    this.schedule = schedule
    this.cancel = cancel
    /** @type {Map<string,ManualCheck>} */
    this.manualChecks = new Map()
    /** @type {Map<string,Session>} */
    this.sessions = new Map()
    /** @type {Map<string,Session>} */
    this.backgroundSessions = new Map()
    this.running = false
    /** @type {string|null} */
    this.activeScope = null
    this.stopped = false
  }
  /** @param {Actor} actor */
  paused(actor) {
    return (
      this.db.prepare('select paused from intake_control where scope=?').get(this.w.scope(actor))
        ?.paused === 1
    )
  }
  /** @param {Actor} actor @returns {IntakeRecord[]} */
  records(actor) {
    return /** @type {IntakeRecord[]} */ (
      this.db
        .prepare(
          `select q.id,q.resource,q.path,q.etag,q.state,q.job,d.state decision,p.state proposalState,a.state automaticState from intake_queue q left join decisions d on d.job=q.job and d.actor=? left join proposals p on p.id=q.job left join automatic_runs a on a.job=q.job and a.scope=q.scope where q.scope=?`
        )
        .all(actor.account, this.w.scope(actor))
    )
  }
  /** @param {Parameters<typeof intakeBucket>[0]} row */
  bucket(row) {
    return intakeBucket(row)
  }
  /** @param {Parameters<typeof intakeRetryable>[0]} row */
  retryable(row) {
    return intakeRetryable(row)
  }
  /** @param {Parameters<typeof intakeCancellable>[0]} row */
  cancellable(row) {
    return intakeCancellable(row)
  }
  /** @param {Actor} actor @param {IntakeRecord[]} records */
  summary(actor, records = this.records(actor)) {
    const counts = {
      total: 0,
      waiting: 0,
      running: 0,
      attention: 0,
      ready: 0,
      completed: 0,
      cancelled: 0,
      duplicates: 0,
      superseded: 0,
      retryable: 0,
      cancellable: 0
    }
    for (const row of records) {
      counts.total++
      counts[this.bucket(row)]++
      if (this.retryable(row)) counts.retryable++
      if (this.cancellable(row)) counts.cancellable++
    }
    return counts
  }
  /** @param {Actor} actor @param {'pause'|'resume'|'retry'|'cancel'} action @param {string[]} [ids] */
  manage(actor, action, ids) {
    if (!['pause', 'resume', 'retry', 'cancel'].includes(action))
      throw new WorkflowError('OPERATION_HELD', 'Unknown processing action')
    if (
      ids !== undefined &&
      (!['retry', 'cancel'].includes(action) ||
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 128))
    )
      throw new WorkflowError('VALIDATION_INVALID', 'Choose processing items')
    const selected = ids === undefined ? null : new Set(ids),
      scope = this.w.scope(actor)
    let affected = 0
    withTransaction(this.db, () => {
      if (action === 'pause' || action === 'resume' || (action === 'cancel' && !selected)) {
        this.db
          .prepare(
            'insert into intake_control values(?,?) on conflict(scope) do update set paused=excluded.paused'
          )
          .run(scope, action === 'resume' ? 0 : 1)
        if (action !== 'resume') this.cancelCheck(scope)
      }
      if (action === 'retry' || action === 'cancel')
        for (const row of this.records(actor)) {
          if (selected && !selected.has(row.id)) continue
          if (action === 'retry' && this.retryable(row)) {
            this.db
              .prepare(
                "update intake_queue set state='queued',attempts=0,next_attempt=0,detail=NULL,issue=NULL where id=? and scope=?"
              )
              .run(row.id, scope)
            affected++
          }
          if (action === 'cancel' && this.cancellable(row)) {
            this.db
              .prepare(
                "update intake_queue set state='cancelled',detail='Processing cancelled; uploaded file kept' where id=? and scope=?"
              )
              .run(row.id, scope)
            if (row.job)
              this.db
                .prepare(
                  "update automatic_runs set state='cancelled',detail='Processing cancelled; inspect any existing filing decision',updated=? where job=? and scope=? and state in ('pending','running','held')"
                )
                .run(new Date().toISOString(), row.job, scope)
            affected++
          }
        }
      this.w.event(actor, null, 'processing_' + action, {
        affected,
        selection: selected ? 'selected' : 'all'
      })
    })
    return { affected, paused: this.paused(actor), summary: this.summary(actor) }
  }
  /** @param {Actor} actor @returns {IntakeConfiguration} */
  configuration(actor) {
    const r = this.db
      .prepare('select value from intake_settings where scope=?')
      .get(this.w.scope(actor))
    return r ? JSON.parse(String(r.value)) : defaultIntake()
  }
  /** @param {Actor} actor @param {unknown} value @param {Adapter} api */
  save(actor, value, api) {
    const checked = validateIntake(value),
      destination = this.w.configuration.settings(actor).rules.root ?? 'Filed',
      sameFolder = this.configuration(actor).folder === checked.folder,
      scope = this.w.scope(actor)
    if (
      this.w.configuration.destinationSpace(actor) === actor.space &&
      (checked.folder === destination || checked.folder.startsWith(destination + '/'))
    )
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Choose an inbox outside the filing destination'
      )
    this.db
      .prepare(
        'insert into intake_settings(scope,value) values(?,?) on conflict(scope) do update set value=excluded.value,last_scan=0'
      )
      .run(scope, JSON.stringify(checked))
    this.db
      .prepare(
        'insert into intake_health(scope) values(?) on conflict(scope) do update set last_attempt=NULL,reason=NULL,message=NULL,last_success=case when ? then last_success else NULL end'
      )
      .run(scope, sameFolder ? 1 : 0)
    if (JSON.stringify(checked) !== this.manualChecks.get(scope)?.configuration)
      this.cancelCheck(scope)
    this.attach(actor, api)
    this.w.event(actor, null, checked.enabled ? 'intake_enabled' : 'intake_paused', {
      folder: checked.folder
    })
    return checked
  }
  /** @param {Actor} actor @param {Adapter} api @param {{background?:boolean}} options */
  attach(actor, api, { background = false } = {}) {
    const scope = this.w.scope(actor)
    if (background) this.backgroundSessions.set(scope, { actor, api })
    const preferred = this.backgroundSessions.get(scope)
    this.sessions.set(scope, preferred ?? { actor, api })
  }
  /** @param {Adapter} api */
  detach(api) {
    for (const [scope, session] of this.backgroundSessions)
      if (session.api === api) this.backgroundSessions.delete(scope)
    for (const [scope, session] of this.sessions)
      if (session.api === api) this.sessions.delete(scope)
  }
  /** @param {Actor} actor @param {import('./workflow-contracts.d.mts').PageOptions & {includeHistory?:boolean}} options @param {import('./workflow-contracts.d.mts').InboxCurrentFile[]|null} currentFiles */
  status(actor, options = {}, currentFiles = null) {
    return intakeStatus(this, actor, options, currentFiles)
  }
  /** @param {string} scope */
  cancelCheck(scope) {
    const check = this.manualChecks.get(scope)
    if (check?.timer !== undefined) this.cancel(check.timer)
    this.manualChecks.delete(scope)
  }
  /** @param {Actor} actor */
  requestCheck(actor) {
    const scope = this.w.scope(actor),
      configuration = this.configuration(actor)
    if (!configuration.enabled)
      throw new WorkflowError(
        'OPERATION_HELD',
        'Enable inbox processing before checking for documents'
      )
    if (this.paused(actor))
      throw new WorkflowError('OPERATION_HELD', 'Resume processing before checking the inbox')
    if (this.stopped || !this.sessions.has(scope))
      throw new WorkflowError('AUTH_REQUIRED', 'Reconnect OpenCloud before checking the inbox')
    if (this.manualChecks.has(scope)) return { state: 'scheduled' }
    /** @type {ManualCheck} */
    const check = {
      state: 'checking',
      configuration: JSON.stringify(configuration),
      cohort: null,
      timer: undefined
    }
    this.manualChecks.set(scope, check)
    this.scheduleCheck(scope, check, 0)
    return { state: 'scheduled' }
  }
  /** @param {string} scope @param {ManualCheck} check @param {number} delay */
  scheduleCheck(scope, check, delay) {
    check.timer = this.schedule(() => {
      check.timer = undefined
      void this.runCheck(scope, check).catch((error) => {
        this.recordFailure(error)
        if (this.manualChecks.get(scope) === check) this.cancelCheck(scope)
      })
    }, delay)
    check.timer?.unref?.()
  }
  /** @param {string} scope @param {ManualCheck} check */
  async runCheck(scope, check) {
    if (this.stopped || this.manualChecks.get(scope) !== check) return
    const session = this.sessions.get(scope)
    if (!session || JSON.stringify(this.configuration(session.actor)) !== check.configuration) {
      this.cancelCheck(scope)
      return
    }
    if (this.running) {
      this.scheduleCheck(scope, check, 250)
      return
    }
    check.state = 'checking'
    const completed = await this.tick({ force: true, scope, queueIds: check.cohort })
    if (this.stopped || this.manualChecks.get(scope) !== check) return
    if (!completed) {
      this.scheduleCheck(scope, check, 250)
      return
    }
    const health = this.db.prepare('select reason from intake_health where scope=?').get(scope)
    if (!check.cohort && !health?.reason) {
      // One explicit check includes a single settling recheck of this exact cohort.
      // Later arrivals and changing uploads wait for the next check in manual mode.
      const config = JSON.parse(check.configuration),
        pending = this.db
          .prepare(
            "select id,first_seen from intake_queue where scope=? and state='settling' and first_seen+?>?"
          )
          .all(scope, config.settleSeconds * 1000, this.now())
      if (pending.length) {
        check.cohort = pending.map((row) => String(row.id))
        check.state = 'settling'
        this.scheduleCheck(
          scope,
          check,
          Math.max(...pending.map((row) => Number(row.first_seen) + config.settleSeconds * 1000)) -
            this.now()
        )
        return
      }
    }
    this.cancelCheck(scope)
  }
  /** @param {Actor} actor @param {string} id */
  retry(actor, id) {
    const row = this.records(actor).find((row) => row.id === id)
    if (!row || !this.retryable(row))
      throw new WorkflowError(
        'OPERATION_HELD',
        'Only failed or cancelled jobs without a filing decision can be retried'
      )
    return this.manage(actor, 'retry', [id])
  }
  /** @param {Actor} actor @param {Adapter} api @param {IntakeConfiguration} config */
  async scan(actor, api, config) {
    const destination = this.w.configuration.settings(actor).rules.root ?? 'Filed',
      paths = [config.folder],
      visited = new Set(),
      scan = randomUUID(),
      scope = this.w.scope(actor)
    if (
      this.w.configuration.destinationSpace(actor) === actor.space &&
      (config.folder === destination || config.folder.startsWith(destination + '/'))
    )
      throw new WorkflowError('OPERATION_HELD', 'The inbox is inside the filing destination')
    while (paths.length) {
      if (this.stopped || this.paused(actor) || !this.configuration(actor).enabled)
        throw new WorkflowError('OPERATION_HELD', 'Ingestion paused')
      const path = paths.pop()
      if (path === undefined) break
      if (visited.has(path)) throw new WorkflowError('OPERATION_HELD', 'Repeated inbox folder')
      visited.add(path)
      const files = await api.list(path)
      for (const f of files) {
        if (this.stopped || this.paused(actor) || !this.configuration(actor).enabled)
          throw new WorkflowError('OPERATION_HELD', 'Ingestion paused')
        safePath(f.path)
        if (!f.path.startsWith(path + '/') || f.path.slice(path.length + 1).includes('/'))
          throw new WorkflowError('OPERATION_HELD', 'Intake listing outside requested folder')
        if (f.folder) {
          if (
            config.recursive &&
            (this.w.configuration.destinationSpace(actor) !== actor.space ||
              (f.path !== destination && !f.path.startsWith(destination + '/')))
          )
            paths.push(f.path)
        } else if (/\.pdf$/i.test(f.path)) {
          if (!f.resourceId || !f.etag)
            throw new WorkflowError('OPERATION_HELD', 'Intake file identity missing')
          const id = sha(JSON.stringify([scope, f.resourceId, f.etag, f.path]))
          this.db
            .prepare(
              "insert into intake_queue(id,scope,resource,path,etag,first_seen,state,last_seen) values(?,?,?,?,?,?,'settling',?) on conflict(id) do update set last_seen=excluded.last_seen,detail=case when state='trashed' then 'Restored from OpenCloud Trash; automatic duplicate handling is paused for this copy.' else detail end,state=case when state='trashed' then 'restored' else state end"
            )
            .run(id, scope, f.resourceId, f.path, f.etag, this.now(), scan)
        }
      }
    }
    return scan
  }

  /** @param {{force?:boolean,scope?:string,queueIds?:string[]|null}} options */
  async tick({ force = false, scope: requestedScope, queueIds = null } = {}) {
    if (this.running || this.stopped) return false
    this.running = true
    let release
    try {
      release = this.w.lock('__intake__')
      for (const [scope, session] of this.sessions) {
        if (requestedScope && scope !== requestedScope) continue
        await this.tickSession(scope, session, { force, queueIds })
      }
      return true
    } catch (e) {
      if (errorCode(e) !== 'WORKFLOW_BUSY') this.recordFailure(e)
      return false
    } finally {
      release?.()
      this.running = false
    }
  }
  /** @param {string} scope @param {Session} session @param {{force:boolean,queueIds:string[]|null}} options */
  async tickSession(scope, session, { force, queueIds }) {
    const { actor, api } = session,
      c = this.configuration(actor)
    if (!c.enabled || this.paused(actor)) return
    const setting = this.db
        .prepare('select last_scan from intake_settings where scope=?')
        .get(scope),
      health = this.db.prepare('select last_attempt from intake_health where scope=?').get(scope)
    if (
      !force &&
      (c.intervalSeconds === 0 ||
        this.manualChecks.has(scope) ||
        this.now() - Number(health?.last_attempt ?? setting?.last_scan ?? 0) <
          c.intervalSeconds * 1000)
    )
      return
    this.activeScope = scope
    this.db
      .prepare(
        'insert into intake_health(scope,last_attempt) values(?,?) on conflict(scope) do update set last_attempt=excluded.last_attempt'
      )
      .run(scope, this.now())
    try {
      const verified = await api.identity()
      if (this.w.scope(verified) !== scope)
        throw Object.assign(new WorkflowError('ACCESS_DENIED', 'Intake identity changed'), {
          status: 403
        })
      this.db.prepare('update intake_settings set last_scan=? where scope=?').run(this.now(), scope)
      const seen = await this.scan(actor, api, c)
      const queue = this.claimableQueue(actor, scope, queueIds)
      await this.drainQueue(actor, scope, c, queue, seen, force)
      const renewed = this.sessions.get(scope)
      if (this.resume && !this.stopped && !this.paused(actor) && renewed)
        await this.resume(actor, renewed.api)
      this.db
        .prepare('update intake_health set last_success=?,reason=NULL,message=NULL where scope=?')
        .run(this.now(), scope)
    } catch (e) {
      if (this.stopped || this.paused(actor) || !this.configuration(actor).enabled) return
      this.logger('intake_scan_failed', e)
      const sessionFailure = responseRecord(e).status === 401 || responseRecord(e).status === 403,
        message = sessionFailure
          ? 'Session expired or access revoked'
          : 'Check source folder access, session and connectivity'
      this.db
        .prepare('update intake_health set reason=?,message=? where scope=?')
        .run(sessionFailure ? 'session' : 'source', message, scope)
      this.w.event(actor, null, 'intake_scan_held', { reason: message })
      // A request may attach a freshly verified adapter while the old scan awaits I/O.
      // Failure of the older credential must never discard that newer session.
      if (sessionFailure && this.sessions.get(scope) === session) this.detach(session.api)
    } finally {
      this.activeScope = null
    }
  }
  /** @param {Actor} actor @param {string} scope @param {IntakeConfiguration} c @param {QueueRow[]} queue @param {string} seen @param {boolean} force */
  async drainQueue(actor, scope, c, queue, seen, force) {
    for (const item of queue) {
      if (
        JSON.stringify(this.configuration(actor)) !== JSON.stringify(c) ||
        !c.enabled ||
        this.paused(actor) ||
        this.stopped ||
        (!force && this.configuration(actor).intervalSeconds === 0)
      )
        break
      // Every attached adapter has passed identity verification. A large batch
      // must pick up renewed credentials between documents, not retain the
      // adapter captured before minutes of local inference.
      const currentSession = this.sessions.get(scope)
      if (!currentSession) break
      if (item.first_seen + c.settleSeconds * 1000 > this.now()) continue
      const visible = item.last_seen === seen
      if (!visible) {
        this.db.prepare("update intake_queue set state='superseded' where id=?").run(item.id)
        continue
      }
      if (
        !this.db
          .prepare(
            "update intake_queue set state='running',stage='reading',issue=NULL,attempts=attempts+1 where id=? and state in ('settling','queued','failed')"
          )
          .run(item.id).changes
      )
        continue
      if ((await this.prepareItem(actor, currentSession, c, item)) === 'busy') break
    }
  }
  /** @param {Actor} actor @param {string} scope @param {string[]|null} queueIds @returns {QueueRow[]} */
  claimableQueue(actor, scope, queueIds) {
    // Interrupted attempts can be retried only under the process ownership lock.
    this.db
      .prepare(
        "update intake_queue set state='queued' where scope=? and state='running' and attempts<3"
      )
      .run(scope)
    this.db
      .prepare(
        "update intake_queue set state='failed',detail='Attempt limit reached' where scope=? and state='running' and attempts>=3"
      )
      .run(scope)
    return /** @type {QueueRow[]} */ (
      this.db
        .prepare(
          "select * from intake_queue where scope=? and state in ('settling','queued','failed') and attempts<3 and next_attempt<=? and (? is null or id in (select value from json_each(?))) order by first_seen limit ?"
        )
        .all(
          scope,
          this.now(),
          queueIds ? JSON.stringify(queueIds) : null,
          queueIds ? JSON.stringify(queueIds) : null,
          this.w.configuration.settings(actor).limits.documentsPerCycle ?? 20
        )
    )
  }
  /** @param {Actor} actor @param {Session} currentSession @param {IntakeConfiguration} c @param {QueueRow} item */
  async prepareItem(actor, currentSession, c, item) {
    const scope = this.w.scope(actor),
      itemAPI = currentSession.api
    try {
      const bytes = await itemAPI.get(
          item.path,
          item.etag,
          (this.w.configuration.settings(actor).limits.maxMiB ?? 100) * 1024 * 1024
        ),
        contentHash = sha(bytes)
      if (
        this.db.prepare('select state from intake_queue where id=?').get(item.id)?.state ===
        'cancelled'
      )
        return
      // The first attempted resource keeps ownership even if inference fails.
      // Later failed duplicate attempts must not reverse the link on a retry.
      const prior = this.db
        .prepare(
          "select id,json_extract(input,'$.source.resourceId') resource from proposals where scope=? and json_extract(input,'$.source.sha256')=? and (result is not null or state in ('failed','running')) order by updated,id limit 1"
        )
        .get(scope, contentHash)
      this.db
        .prepare('insert or ignore into intake_content values(?,?,?,?)')
        .run(scope, contentHash, prior?.resource ?? item.resource, prior?.id ?? null)
      const owner = this.db
        .prepare('select resource,job from intake_content where scope=? and sha=?')
        .get(scope, contentHash)
      if (!owner) throw new WorkflowError('INTERNAL_ERROR', 'Intake content owner is missing')
      if (owner.resource !== item.resource) {
        this.db
          .prepare("update intake_queue set state='duplicate',detail=?,job=? where id=?")
          .run(
            'Identical bytes already have a review attempt; inspect the original resource',
            owner.job,
            item.id
          )
        this.w.event(actor, owner.job === null ? null : String(owner.job), 'duplicate_held', {
          path: item.path,
          resourceId: item.resource
        })
        return
      }
      const done = this.db
        .prepare(
          "select p.id from proposals p join decisions d on d.job=p.id where p.scope=? and d.state='done' and json_extract(p.input,'$.source.resourceId')=? and json_extract(p.input,'$.source.sha256')=? and json_extract(d.record,'$.actions.target')=? limit 1"
        )
        .get(scope, item.resource, contentHash, item.path)
      if (!done && !this.prepare)
        throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Preparation service is unavailable')
      const result =
        done ??
        (await this.prepare?.(actor, itemAPI, item.path, {
          retry: true,
          cloudConsent: c.cloudConsent,
          onProgress: (stage) => {
            if (!['reading', 'ocr', 'analysing', 'tagging'].includes(stage))
              throw new WorkflowError('INTERNAL_ERROR', 'Unknown processing stage')
            this.db
              .prepare("update intake_queue set stage=? where id=? and state='running'")
              .run(stage, item.id)
          }
        }))
      if (!result) throw new WorkflowError('INTERNAL_ERROR', 'Preparation result is missing')
      this.db
        .prepare('update intake_content set job=? where scope=? and sha=? and resource=?')
        .run(result.id, scope, contentHash, item.resource)
      const saved = this.db
        .prepare(
          "update intake_queue set state=case when state='running' then 'prepared' else state end,stage=case when state='running' then 'review' else stage end,job=?,detail=case when state='running' then NULL else detail end where id=? returning state"
        )
        .get(result.id, item.id)
      if (!saved) throw new WorkflowError('INTERNAL_ERROR', 'Intake queue item is missing')
      if (saved.state !== 'prepared') return
      this.w.event(actor, String(result.id), 'intake_prepared', { path: item.path })
      if (this.processPrepared)
        await this.processPrepared(actor, itemAPI, String(result.id), {
          retry: true,
          allowPaused: true
        })
    } catch (error) {
      this.handleItemFailure(error, actor, currentSession, item)
      if (errorCode(error) === 'WORKFLOW_BUSY') return 'busy'
    }
  }
  /** @param {unknown} error @param {Actor} actor @param {Session} currentSession @param {QueueRow} item */
  handleItemFailure(error, actor, currentSession, item) {
    const scope = this.w.scope(actor)
    if (errorCode(error) === 'WORKFLOW_BUSY') {
      // Waiting for an active worker is not a failed document attempt.
      this.db
        .prepare(
          "update intake_queue set state='queued',attempts=attempts-1,next_attempt=?,stage=NULL,issue=NULL,detail=NULL where id=? and state='running'"
        )
        .run(this.now() + 1000, item.id)
      return
    }
    if (responseRecord(error).status === 401 || responseRecord(error).status === 403) {
      this.db
        .prepare(
          "update intake_queue set state='queued',attempts=attempts-1,stage=NULL,issue=NULL where id=? and state='running'"
        )
        .run(item.id)
      if (this.sessions.get(scope) === currentSession) this.detach(currentSession.api)
      throw error
    }
    this.logger('intake_document_held', error)
    const issue = preparationIssue(error)
    this.db
      .prepare(
        "update intake_content set job=(select p.id from proposals p where p.scope=intake_content.scope and json_extract(p.input,'$.source.sha256')=intake_content.sha and json_extract(p.input,'$.source.resourceId')=intake_content.resource order by p.updated desc,p.id desc limit 1) where scope=? and resource=?"
      )
      .run(scope, item.resource)
    const attempts = item.attempts + 1
    if (
      this.db
        .prepare(
          "update intake_queue set state='failed',next_attempt=?,detail=?,issue=? where id=? and state='running'"
        )
        .run(
          this.now() + Math.min(3600, 30 * 2 ** attempts) * 1000,
          issue.message,
          JSON.stringify(issue),
          item.id
        ).changes
    )
      this.w.event(actor, null, 'intake_held', { path: item.path, attempts })
  }
  /** @param {unknown} error */
  recordFailure(error) {
    this.logger('intake_worker_failed', error)
    // If the journal itself is unavailable the structured log remains the fallback.
    try {
      for (const scope of this.sessions.keys())
        this.db
          .prepare(
            "insert into intake_health(scope,last_attempt,reason,message) values(?,?,'worker','Background processing stopped unexpectedly. Check server logs.') on conflict(scope) do update set last_attempt=excluded.last_attempt,reason=excluded.reason,message=excluded.message"
          )
          .run(scope, this.now())
    } catch {
      /* The log above records the failure without exporting private state. */
    }
  }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.recordFailure(error))
    }, 1000)
    this.timer.unref()
  }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    for (const scope of this.manualChecks.keys()) this.cancelCheck(scope)
    while (this.running) await new Promise((r) => setTimeout(r, 20))
  }
}
