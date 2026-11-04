// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
export class Operations {
  constructor(workflow, { metadata, prepare, convert, session, invalidateSession }) {
    Object.assign(this, {
      w: workflow,
      db: workflow.db,
      metadata,
      prepare,
      convert,
      session,
      invalidateSession
    })
    this.active = new Map()
    this.stopped = false
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS bulk_operations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bulk_items(operation TEXT NOT NULL,position INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(operation,position));CREATE INDEX IF NOT EXISTS bulk_item_source ON bulk_items(json_extract(input,'$.resourceId'),state,operation);`)
  }
  status(actor, id) {
    const row = this.db
      .prepare('select id,kind,state,created,updated from bulk_operations where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!row) throw Object.assign(new Error('Operation not found'), { status: 404 })
    return {
      ...row,
      items: this.db
        .prepare(
          'select position,input,state,result from bulk_items where operation=? order by position'
        )
        .all(id)
        .map((i) => ({
          ...i,
          input: JSON.parse(i.input),
          result: i.result ? JSON.parse(i.result) : null
        }))
    }
  }
  list(actor) {
    return this.db
      .prepare(
        'select id,kind,state,created,updated from bulk_operations where scope=? order by created desc'
      )
      .all(this.w.scope(actor))
  }
  start(actor, api, { id, kind, items }) {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !['prepare', 'file', 'metadata', 'automatic', 'convert'].includes(kind) ||
      !Array.isArray(items) ||
      !items.length ||
      items.length > 10000 ||
      items.some((i) => !i || typeof i !== 'object' || Array.isArray(i))
    )
      throw new Error('Choose between 1 and 10000 documents for this operation')
    const scope = this.w.scope(actor),
      request = createHash('sha256').update(JSON.stringify({ kind, items })).digest('hex'),
      old = this.db.prepare('select scope,request from bulk_operations where id=?').get(id)
    if (old) {
      if (old.scope !== scope || old.request !== request)
        throw new Error('Operation ID is already used by a different request')
      return this.status(actor, id)
    }
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare("insert into bulk_operations values(?,?,?,?,'queued',?,?)")
        .run(id, scope, kind, request, now, now)
      items.forEach((input, index) =>
        this.db
          .prepare("insert into bulk_items values(?,?,?,'queued',NULL)")
          .run(id, index, JSON.stringify(input))
      )
      this.w.event(actor, null, 'bulk_queued', { id, kind, count: items.length })
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.launch(actor, api, id)
    return this.status(actor, id)
  }
  launch(actor, api, id) {
    this.status(actor, id)
    if (this.stopped || this.active.has(id)) return
    const task = this.run(actor, api, id)
    this.active.set(id, task)
    void task.finally(() => this.active.delete(id)).catch(() => {})
  }
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
      if (['queued', 'running', 'paused'].includes(row.operation)) {
        if (row.state === 'queued') {
          totals.waiting += row.n
          totals.cancellable += row.n
        }
        if (row.state === 'running') totals.running += row.n
      }
      if (
        row.kind === 'prepare' &&
        row.state === 'held' &&
        ['completed', 'held', 'paused'].includes(row.operation)
      )
        totals.retryable += row.n
    }
    return totals
  }
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
        this.launch(actor, api, row.id)
  }
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
      if (!this.active.has(row.id))
        this.db
          .prepare("update bulk_operations set state='completed',updated=? where id=?")
          .run(new Date().toISOString(), row.id)
    }
    return affected
  }
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
        if (!this.w.intake?.paused(actor)) this.launch(actor, api, row.id)
      }
    }
    return affected
  }
  retryHeld(actor, api, id) {
    const operation = this.status(actor, id)
    if (
      operation.kind !== 'prepare' ||
      !['completed', 'held', 'paused'].includes(operation.state) ||
      this.active.has(id)
    )
      throw new Error('Only stopped preparation results can be retried')
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
      if (!this.w.intake?.paused(actor)) this.launch(actor, api, id)
    }
    return { ...this.status(actor, id), retried: count }
  }
  async run(actor, api, id) {
    let release
    try {
      release = this.w.lock('bulk:' + id)
      const operation = this.status(actor, id)
      this.db
        .prepare("update bulk_operations set state='running',updated=? where id=?")
        .run(new Date().toISOString(), id)
      for (const item of operation.items) {
        if (
          this.stopped ||
          (['prepare', 'convert'].includes(operation.kind) && this.w.intake?.paused(actor))
        )
          break
        item.state = this.db
          .prepare('select state from bulk_items where operation=? and position=?')
          .get(id, item.position).state
        if (item.state === 'running') {
          this.item(id, item.position, 'held', {
            error: 'An interrupted operation needs inspection; it was not repeated'
          })
          continue
        }
        if (item.state !== 'queued') continue
        this.item(id, item.position, 'running', null)
        try {
          const current = this.session ? this.session(actor) : api
          if (!current) {
            this.item(id, item.position, 'queued', {
              error: 'Sign in again before resuming queued documents'
            })
            break
          }
          api = current
          const verified = await api.identity()
          if (this.w.scope(verified) !== this.w.scope(actor))
            throw new Error('Workspace access changed')
          const physical = item.input.documentSpace
            ? await this.w.transfers.adapter(actor, api, item.input.documentSpace)
            : api
          let result
          if (operation.kind === 'prepare') {
            if (item.input.resourceId || item.input.etag) {
              const selected = await physical.stat(item.input.path)
              if (
                !selected ||
                selected.folder ||
                (item.input.resourceId && selected.resourceId !== item.input.resourceId) ||
                (item.input.etag && selected.etag !== item.input.etag)
              )
                throw new Error('The selected document changed before preparation')
            }
            result = await this.prepare(actor, physical, item.input.path, {
              retry: item.input.retry === true,
              cloudConsent: item.input.cloudConsent === true,
              newReview: item.input.newReview === true,
              expectedResourceId: item.input.resourceId,
              expectedEtag: item.input.etag,
              onProgress: (stage) => this.item(id, item.position, 'running', { stage })
            })
          }
          if (operation.kind === 'convert') result = await this.convert(actor, physical, item.input)
          if (operation.kind === 'metadata')
            result = await this.metadata.save(actor, physical, item.input)
          if (operation.kind === 'automatic')
            result = await this.w.automation.run(actor, api, item.input.id)
          if (operation.kind === 'file') {
            const { id: job, policy, reviewDigest, manualActions } = item.input,
              decision = this.w.decision(actor, job)
            if (decision) {
              const approval = JSON.parse(decision.record)
              if (approval.reviewDigest !== reviewDigest || approval.automaticAuthorization)
                throw new Error('The saved approval needs individual inspection')
            } else await this.w.approve(actor, api, job, policy, reviewDigest, manualActions)
            result = await this.w.apply(actor, api, job)
          }
          this.item(
            id,
            item.position,
            result?.uncertain || ['held', 'review'].includes(result?.state) ? 'held' : 'done',
            result
          )
        } catch (e) {
          if (this.session && [401, 403].includes(e.status)) {
            this.invalidateSession?.(api)
            this.item(id, item.position, 'queued', {
              error: 'Sign in again before resuming queued documents'
            })
            break
          }
          let stage
          if (operation.kind === 'prepare') {
            try {
              const saved = JSON.parse(
                this.db
                  .prepare('select result from bulk_items where operation=? and position=?')
                  .get(id, item.position).result ?? '{}'
              )
              if (['reading', 'ocr', 'analysing', 'tagging'].includes(saved.stage))
                stage = saved.stage
            } catch {
              /* Missing stage diagnostics must not prevent recording the held operation. */
            }
          }
          this.item(id, item.position, 'held', {
            ...(stage ? { stage } : {}),
            finishedAt: new Date().toISOString(),
            error:
              e.message?.length < 220 && !/[\r\n]/.test(e.message)
                ? e.message
                : 'Inspect the document and its Activity before continuing'
          })
        }
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
    } catch {
      this.db
        .prepare("update bulk_operations set state='held',updated=? where id=?")
        .run(new Date().toISOString(), id)
    } finally {
      release?.()
    }
  }
  item(id, position, state, result) {
    this.db
      .prepare('update bulk_items set state=?,result=? where operation=? and position=?')
      .run(state, result ? JSON.stringify(result) : null, id, position)
  }
  async stop() {
    this.stopped = true
    await Promise.allSettled([...this.active.values()])
  }
}
