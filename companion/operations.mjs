// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError, errorCode } from '../src/domain/errors.ts'
import { logEvent } from './logging.mjs'
import { withTransaction } from './transactions.mjs'
import { createHash } from 'node:crypto'
/** @typedef {import('./contracts.d.mts').Actor} Actor */
/** @typedef {import('./operation-contracts.d.mts').OperationAdapter} Adapter */
/** @typedef {import('./operation-contracts.d.mts').OperationRecord} Operation */
/** @typedef {import('./operation-contracts.d.mts').OperationItem} Item */
/** @param {unknown} error */
function accessExpired(error) {
  return (
    !!error &&
    typeof error === 'object' &&
    'status' in error &&
    [401, 403].includes(Number(error.status))
  )
}
export class Operations {
  /** @param {import('./operation-contracts.d.mts').OperationOwner} workflow @param {import('./operation-contracts.d.mts').OperationOptions} options */
  constructor(
    workflow,
    { metadata, prepare, convert, session, invalidateSession, logger = logEvent }
  ) {
    this.w = workflow
    this.db = workflow.db
    this.metadata = metadata
    this.prepare = prepare
    this.convert = convert
    this.session = session
    this.invalidateSession = invalidateSession
    this.logger = logger
    /** @type {Map<string, Promise<void>>} */
    this.active = new Map()
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.retries = new Map()
    this.stopped = false
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} space */
  spaceAdapter(actor, api, space) {
    return this.w.transfers.adapter(actor, api, space)
  }
  /** @param {Actor} actor @param {string} id @returns {Operation} */
  status(actor, id) {
    const row = this.db
      .prepare('select id,kind,state,created,updated from bulk_operations where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row)
      throw Object.assign(new WorkflowError('RESOURCE_NOT_FOUND', 'Operation not found'), {
        status: 404
      })
    return {
      id: String(row.id),
      kind: /** @type {Operation['kind']} */ (row.kind),
      state: String(row.state),
      created: String(row.created),
      updated: String(row.updated),
      items: this.db
        .prepare(
          'select position,input,state,result from bulk_items where operation=? order by position'
        )
        .all(id)
        .map((i) => ({
          position: Number(i.position),
          state: String(i.state),
          input: JSON.parse(String(i.input)),
          result: i.result ? JSON.parse(String(i.result)) : null
        }))
    }
  }
  /** @param {Actor} actor */
  list(actor) {
    return this.db
      .prepare(
        'select id,kind,state,created,updated from bulk_operations where scope=? order by created desc'
      )
      .all(this.w.scope(actor))
  }
  /** @param {Actor} actor @param {Adapter} api @param {import('./operation-contracts.d.mts').OperationRequest} request */
  start(actor, api, { id, kind, items }) {
    if (
      typeof id !== 'string' ||
      typeof kind !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      !['prepare', 'file', 'metadata', 'automatic', 'convert'].includes(kind) ||
      !Array.isArray(items) ||
      !items.length ||
      items.length > 10000 ||
      items.some((i) => !i || typeof i !== 'object' || Array.isArray(i))
    )
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Choose between 1 and 10000 documents for this operation'
      )
    const scope = this.w.scope(actor),
      request = createHash('sha256').update(JSON.stringify({ kind, items })).digest('hex'),
      old = this.db.prepare('select scope,request from bulk_operations where id=?').get(id)
    if (old) {
      if (old.scope !== scope || old.request !== request)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Operation ID is already used by a different request'
        )
      return this.status(actor, id)
    }
    const now = new Date().toISOString()
    withTransaction(this.db, () => {
      this.db
        .prepare("insert into bulk_operations values(?,?,?,?,'queued',?,?)")
        .run(id, scope, kind, request, now, now)
      items.forEach((input, index) =>
        this.db
          .prepare("insert into bulk_items values(?,?,?,'queued',NULL)")
          .run(id, index, JSON.stringify(input))
      )
      this.w.event(actor, null, 'bulk_queued', { id, kind, count: items.length })
    })
    this.launch(actor, api, id)
    return this.status(actor, id)
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id */
  launch(actor, api, id) {
    this.status(actor, id)
    if (this.stopped || this.active.has(id)) return
    clearTimeout(this.retries.get(id))
    this.retries.delete(id)
    const task = this.run(actor, api, id)
      .then((waiting) => {
        if (waiting && !this.stopped) {
          const timer = setTimeout(() => {
            this.retries.delete(id)
            this.launch(actor, api, id)
          }, 1000)
          timer.unref()
          this.retries.set(id, timer)
        }
      })
      .finally(() => this.active.delete(id))
    this.active.set(id, task)
    void task.catch(() => {})
  }
  /** @param {Actor} actor @param {import('./operation-contracts.d.mts').CurrentFiles} [currentFiles] */
  processingSummary(actor, currentFiles = null) {
    const totals = { waiting: 0, running: 0, retryable: 0, cancellable: 0 }
    for (const row of this.db
      .prepare(
        "select o.kind,o.state operation,i.state,count(*) n from bulk_operations o join bulk_items i on i.operation=o.id where o.scope=? and o.kind in ('prepare','convert') and (i.state<>'held' or ? is null or exists(select 1 from json_each(?) f where json_extract(f.value,'$.path')=json_extract(i.input,'$.path') and coalesce(json_extract(i.input,'$.documentSpace'),?)=? and (json_extract(i.input,'$.resourceId') is null or json_extract(i.input,'$.resourceId')=json_extract(f.value,'$.resourceId')) and (json_extract(i.input,'$.etag') is null or json_extract(i.input,'$.etag')=json_extract(f.value,'$.etag')))) group by o.kind,o.state,i.state"
      )
      .all(
        this.w.scope(actor),
        currentFiles === null ? null : JSON.stringify(currentFiles),
        JSON.stringify(currentFiles ?? []),
        actor.space,
        actor.space
      )) {
      if (['queued', 'running', 'paused'].includes(String(row.operation))) {
        if (row.state === 'queued') {
          totals.waiting += Number(row.n)
          totals.cancellable += Number(row.n)
        }
        if (row.state === 'running') totals.running += Number(row.n)
      }
      if (
        row.kind === 'prepare' &&
        row.state === 'held' &&
        ['completed', 'held', 'paused'].includes(String(row.operation))
      )
        totals.retryable += Number(row.n)
    }
    return totals
  }
  /** @param {Actor} actor @param {Adapter} api */
  resumeProcessing(actor, api) {
    for (const row of this.db
      .prepare(
        "select id from bulk_operations where scope=? and kind in ('prepare','convert') and state='paused'"
      )
      .all(this.w.scope(actor)))
      if (
        this.db
          .prepare("select 1 from bulk_items where operation=? and state='queued' limit 1")
          .get(row.id)
      )
        this.launch(actor, api, String(row.id))
  }
  /** @param {Actor} actor */
  cancelProcessing(actor) {
    let affected = 0
    for (const row of this.db
      .prepare(
        "select id from bulk_operations where scope=? and kind in ('prepare','convert') and state in ('queued','running','paused')"
      )
      .all(this.w.scope(actor))) {
      affected += Number(
        this.db
          .prepare("update bulk_items set state='cancelled' where operation=? and state='queued'")
          .run(row.id).changes
      )
      if (!this.active.has(String(row.id)))
        this.db
          .prepare("update bulk_operations set state='completed',updated=? where id=?")
          .run(new Date().toISOString(), row.id)
    }
    return affected
  }
  /** @param {Actor} actor @param {Adapter} api @param {import('./operation-contracts.d.mts').CurrentFiles} [currentFiles] */
  retryProcessing(actor, api, currentFiles = null) {
    let affected = 0
    for (const row of this.db
      .prepare(
        "select id from bulk_operations where scope=? and kind='prepare' and state in ('completed','held','paused')"
      )
      .all(this.w.scope(actor))) {
      const count = Number(
        this.db
          .prepare(
            "update bulk_items set state='queued',result=NULL where operation=? and state='held' and (? is null or exists(select 1 from json_each(?) f where json_extract(f.value,'$.path')=json_extract(bulk_items.input,'$.path') and coalesce(json_extract(bulk_items.input,'$.documentSpace'),?)=? and (json_extract(bulk_items.input,'$.resourceId') is null or json_extract(bulk_items.input,'$.resourceId')=json_extract(f.value,'$.resourceId')) and (json_extract(bulk_items.input,'$.etag') is null or json_extract(bulk_items.input,'$.etag')=json_extract(f.value,'$.etag'))))"
          )
          .run(
            row.id,
            currentFiles === null ? null : JSON.stringify(currentFiles),
            JSON.stringify(currentFiles ?? []),
            actor.space,
            actor.space
          ).changes
      )
      affected += count
      if (count) {
        this.db
          .prepare("update bulk_operations set state='paused',updated=? where id=?")
          .run(new Date().toISOString(), row.id)
        if (!this.w.intake.paused(actor)) this.launch(actor, api, String(row.id))
      }
    }
    return affected
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id */
  retryHeld(actor, api, id) {
    const operation = this.status(actor, id)
    if (
      operation.kind !== 'prepare' ||
      !['completed', 'held', 'paused'].includes(operation.state) ||
      this.active.has(id)
    )
      throw new WorkflowError('OPERATION_HELD', 'Only stopped preparation results can be retried')
    const count = Number(
      this.db
        .prepare(
          "update bulk_items set state='queued',result=NULL where operation=? and state='held'"
        )
        .run(id).changes
    )
    if (count) {
      this.db
        .prepare("update bulk_operations set state='paused',updated=? where id=?")
        .run(new Date().toISOString(), id)
      this.w.event(actor, null, 'bulk_retry', { id, count })
      if (!this.w.intake.paused(actor)) this.launch(actor, api, id)
    }
    return { ...this.status(actor, id), retried: count }
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} id */
  async run(actor, api, id) {
    let release,
      waiting = false
    try {
      release = this.w.lock('bulk:' + id)
      const operation = this.status(actor, id)
      this.db
        .prepare("update bulk_operations set state='running',updated=? where id=?")
        .run(new Date().toISOString(), id)
      for (const item of operation.items) {
        if (
          this.stopped ||
          (['prepare', 'convert'].includes(operation.kind) && this.w.intake.paused(actor))
        )
          break
        if (!this.claimItem(id, item)) continue
        const outcome = await this.runQueued(actor, api, operation, item)
        waiting = outcome === 'busy'
        if (outcome !== 'next') break
      }
      const unfinished = this.db
          .prepare(
            "select 1 from bulk_items where operation=? and state in ('queued','running') limit 1"
          )
          .get(id),
        state = unfinished ? 'paused' : 'completed'
      this.db
        .prepare('update bulk_operations set state=?,updated=? where id=?')
        .run(state, new Date().toISOString(), id)
      this.w.event(actor, null, 'bulk_' + state, { id })
    } catch (error) {
      if (errorCode(error) === 'WORKFLOW_BUSY') return false
      this.logger('bulk_failed', error)
      this.db
        .prepare("update bulk_operations set state='held',updated=? where id=?")
        .run(new Date().toISOString(), id)
    } finally {
      release?.()
    }
    return waiting
  }
  /** @param {string} id @param {Item} item */
  claimItem(id, item) {
    const state = this.db
      .prepare('select state from bulk_items where operation=? and position=?')
      .get(id, item.position)?.state
    if (state === 'running')
      this.item(id, item.position, 'held', {
        error: 'An interrupted operation needs inspection; it was not repeated'
      })
    if (state !== 'queued') return false
    this.item(id, item.position, 'running', null)
    return true
  }
  /** @param {Actor} actor @param {Adapter} api @param {Operation} operation @param {Item} item
   * @returns {Promise<'busy'|'session'|'next'>} */
  async runQueued(actor, api, operation, item) {
    const id = operation.id
    try {
      const current = this.session ? this.session(actor) : api
      if (!current) return this.waitForSession(id, item.position)
      api = current
      const verified = await api.identity()
      if (this.w.scope(verified) !== this.w.scope(actor))
        throw new WorkflowError('ACCESS_DENIED', 'Workspace access changed')
      const physical = item.input.documentSpace
        ? await this.spaceAdapter(actor, api, item.input.documentSpace)
        : api
      const result = await this.executeItem(actor, api, physical, operation, item)
      return this.recordResult(id, item.position, operation.kind, result)
    } catch (error) {
      if (errorCode(error) === 'WORKFLOW_BUSY' && operation.kind === 'prepare') {
        this.item(id, item.position, 'queued', null)
        return 'busy'
      }
      if (this.session && accessExpired(error)) {
        this.invalidateSession?.(api)
        return this.waitForSession(id, item.position)
      }
      this.logger('bulk_item_held', error)
      this.holdItem(id, item.position, operation.kind, error)
    }
    return 'next'
  }
  /** @param {string} id @param {number} position @param {Operation['kind']} kind
   * @param {import('./operation-contracts.d.mts').OperationResult | undefined} result
   * @returns {'busy'|'next'} */
  recordResult(id, position, kind, result) {
    if (kind === 'automatic' && ['pending', 'running', 'paused'].includes(result?.state ?? '')) {
      this.item(id, position, 'queued', result ?? null)
      return 'busy'
    }
    const held = result?.uncertain || ['held', 'review'].includes(result?.state ?? '')
    this.item(id, position, held ? 'held' : 'done', result ?? null)
    return 'next'
  }
  /** @param {string} id @param {number} position @returns {'session'} */
  waitForSession(id, position) {
    this.item(id, position, 'queued', { error: 'Sign in again before resuming queued documents' })
    return 'session'
  }
  /** @param {Actor} actor @param {Adapter} api @param {Adapter} physical @param {Operation} operation @param {Item} item */
  async executeItem(actor, api, physical, operation, item) {
    const input = item.input
    switch (operation.kind) {
      case 'prepare':
        return this.prepareItem(actor, physical, operation.id, item)
      case 'convert':
        if (!this.convert)
          throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Conversion service unavailable')
        return this.convert(actor, physical, input)
      case 'metadata':
        if (!this.metadata)
          throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Metadata service unavailable')
        return this.metadata.save(
          actor,
          physical,
          /** @type {import('./contracts.d.mts').MetadataInput} */ (input)
        )
      case 'automatic':
        return this.w.automation.run(actor, api, String(input.id))
      case 'file':
        return this.fileItem(
          actor,
          api,
          /** @type {import('./operation-contracts.d.mts').FileInput} */ (input)
        )
    }
  }
  /** @param {Actor} actor @param {Adapter} api @param {string} operationId @param {Item} item */
  async prepareItem(actor, api, operationId, item) {
    const input = /** @type {import('./operation-contracts.d.mts').PrepareInput} */ (item.input)
    if (input.resourceId || input.etag) {
      const selected = await api.stat(input.path)
      if (
        !selected ||
        selected.folder ||
        (input.resourceId && selected.resourceId !== input.resourceId) ||
        (input.etag && selected.etag !== input.etag)
      )
        throw new WorkflowError(
          'SOURCE_CHANGED',
          'The selected document changed before preparation'
        )
    }
    return this.prepare(actor, api, input.path, {
      retry: input.retry === true,
      cloudConsent: input.cloudConsent === true,
      newReview: input.newReview === true,
      expectedResourceId: input.resourceId,
      expectedEtag: input.etag,
      onProgress: (stage) => this.item(operationId, item.position, 'running', { stage })
    })
  }
  /** @param {Actor} actor @param {Adapter} api @param {import('./operation-contracts.d.mts').FileInput} input */
  async fileItem(actor, api, { id, policy, reviewDigest, manualActions }) {
    const decision = this.w.decision(actor, id)
    if (decision) {
      const approval = JSON.parse(decision.record)
      if (approval.reviewDigest !== reviewDigest || approval.automaticAuthorization)
        throw new WorkflowError('OPERATION_HELD', 'The saved approval needs individual inspection')
    } else await this.w.approve(actor, api, id, policy, reviewDigest, manualActions)
    return this.w.apply(actor, api, id)
  }
  /** @param {string} id @param {number} position @param {string} kind @param {unknown} error */
  holdItem(id, position, kind, error) {
    let stage
    if (kind === 'prepare') {
      try {
        const saved = JSON.parse(
          String(
            this.db
              .prepare('select result from bulk_items where operation=? and position=?')
              .get(id, position)?.result ?? '{}'
          )
        )
        if (['reading', 'ocr', 'analysing', 'tagging'].includes(saved.stage)) stage = saved.stage
      } catch {
        /* Missing stage diagnostics must not prevent recording the held operation. */
      }
    }
    const message = error instanceof Error ? error.message : ''
    this.item(id, position, 'held', {
      ...(stage ? { stage } : {}),
      finishedAt: new Date().toISOString(),
      error:
        message && message.length < 220 && !/[\r\n]/.test(message)
          ? message
          : 'Inspect the document and its Activity before continuing'
    })
  }
  /** @param {string} id @param {number} position @param {string} state @param {import('./operation-contracts.d.mts').OperationResult | null} result */
  item(id, position, state, result) {
    this.db
      .prepare('update bulk_items set state=?,result=? where operation=? and position=?')
      .run(state, result ? JSON.stringify(result) : null, id, position)
  }
  async stop() {
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    await Promise.allSettled([...this.active.values()])
  }
}
