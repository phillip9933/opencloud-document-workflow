// SPDX-License-Identifier: AGPL-3.0-only
import { withTransaction } from './transactions.mjs'
import { existingTagName, tagNameKey } from '../src/domain/tag-names.ts'
import { createHash, randomUUID } from 'node:crypto'
import {
  validateMetadataSchema,
  defaultMetadataSchema,
  validateValues,
  suggestMetadata
} from '../src/domain/metadata.ts'
const hash = (b) => createHash('sha256').update(b).digest('hex')
export class Metadata {
  constructor(workflow) {
    workflow.metadata = this
    this.w = workflow
    this.db = workflow.db
  }
  schema(actor) {
    const r = this.db
      .prepare('select value from metadata_schema where scope=?')
      .get(this.w.scope(actor))
    return r ? JSON.parse(r.value) : defaultMetadataSchema()
  }
  saveSchema(actor, value) {
    const schema = validateMetadataSchema(value)
    this.db
      .prepare(
        'insert into metadata_schema values(?,?) on conflict(scope) do update set value=excluded.value'
      )
      .run(this.w.scope(actor), JSON.stringify(schema))
    this.w.event(actor, null, 'metadata_schema_saved')
    return schema
  }
  async saveConnectedSchema(actor, api, value) {
    const checked = validateMetadataSchema(value)
    if (checked.tags.length) {
      const names = await api.listTags()
      checked.tags = checked.tags.map((rule) => ({
        ...rule,
        tag: existingTagName(rule.tag, names)
      }))
    }
    if (new Set(checked.tags.map((rule) => tagNameKey(rule.tag))).size !== checked.tags.length)
      throw new Error('Tag rules must be unique, ignoring capitalization')
    return this.saveSchema(actor, checked)
  }
  key(actor, resource) {
    return this.w.transfers?.canonical(actor, resource) ?? resource
  }
  read(actor, resource) {
    resource = this.key(actor, resource)
    const r = this.db
      .prepare('select * from metadata where scope=? and resource=?')
      .get(this.w.scope(actor), resource)
    return r
      ? { version: r.version, fields: JSON.parse(r.fields), updated: r.updated }
      : { version: 0, fields: {} }
  }
  async inspect(actor, api, path) {
    const f = await api.stat(path)
    if (!f || f.folder) throw new Error('Document not found')
    const bytes = await api.get(
      path,
      f.etag,
      (this.w.configuration?.settings(actor).limits.maxMiB ?? 100) * 1024 * 1024
    )
    const after = await api.stat(path)
    if (after?.etag !== f.etag || after?.resourceId !== f.resourceId)
      throw new Error('Document changed')
    return { ...f, ...(api.space ? { space: api.space } : {}), sha256: hash(bytes) }
  }
  async get(actor, api, path) {
    const source = await this.inspect(actor, api, path)
    const job = this.db
      .prepare(
        "select input from proposals where scope=? and json_extract(input,'$.source.resourceId')=? and json_extract(input,'$.source.sha256')=? order by updated desc limit 1"
      )
      .get(this.w.scope(actor), this.key(actor, source.resourceId), source.sha256)
    const pending = this.db
      .prepare(
        "select id,state from metadata_changes where scope=? and resource=? and state='intent' order by created desc"
      )
      .all(this.w.scope(actor), this.key(actor, source.resourceId))
    return {
      source,
      trash: this.w.documentTrash?.pending(actor, source.resourceId) ?? null,
      schema: this.schema(actor),
      record: this.read(actor, source.resourceId),
      suggestions: this.suggestions(actor, job ? JSON.parse(job.input).pages : []),
      pending
    }
  }
  suggestions(actor, pages) {
    const value = suggestMetadata(this.schema(actor), pages),
      policy = this.w.preference(actor)?.policy
    if (policy?.fields === 'off') value.fields = {}
    if (policy?.tags === 'off') value.tags = []
    return value
  }
  async save(actor, api, { path, resourceId, etag, sha256, version, fields, addTags }) {
    const release = this.w.lock(`resource:${this.w.scope(actor)}:${this.key(actor, resourceId)}`)
    try {
      this.w.documentTrash?.assertAvailable(actor, resourceId)
      const current = await this.inspect(actor, api, path)
      if (current.resourceId !== resourceId || current.etag !== etag || current.sha256 !== sha256)
        throw new Error('Document changed; reload metadata')
      const record = this.read(actor, resourceId)
      if (record.version !== version) throw new Error('Metadata changed; reload before saving')
      if (
        this.db
          .prepare(
            "select id from metadata_changes where scope=? and resource=? and state='intent'"
          )
          .get(this.w.scope(actor), this.key(actor, resourceId))
      )
        throw new Error('Recheck the pending tag operation first')
      const schema = this.schema(actor),
        values = { ...record.fields }
      for (const f of schema.fields) delete values[f.id]
      Object.assign(values, validateValues(schema, fields))
      if (
        !Array.isArray(addTags) ||
        addTags.length > 50 ||
        addTags.some(
          (t) =>
            typeof t !== 'string' ||
            !t.trim() ||
            t.length > 80 ||
            t !== t.normalize('NFC') ||
            /[\x00-\x1f\x7f]/.test(t)
        )
      )
        throw new Error('Invalid tags')
      if (addTags.length) {
        const names = await api.listTags()
        addTags = [...new Set(addTags.map((tag) => existingTagName(tag, names)))]
      }
      const id = randomUUID(),
        expected = [...new Set([...current.tags, ...addTags])].sort()
      this.db
        .prepare('insert into metadata_changes values(?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          this.w.scope(actor),
          this.key(actor, resourceId),
          path,
          sha256,
          etag,
          version,
          JSON.stringify(values),
          JSON.stringify(expected),
          'intent',
          new Date().toISOString()
        )
      this.w.event(actor, null, 'metadata_intent', { id, resourceId, addTags })
      if (addTags.some((t) => !current.tags.includes(t))) await api.addTags(resourceId, addTags)
      return await this.reconcile(actor, api, id)
    } finally {
      release()
    }
  }
  async removeTag(actor, api, { path, resourceId, etag, sha256, version, tag }) {
    const release = this.w.lock(`resource:${this.w.scope(actor)}:${this.key(actor, resourceId)}`)
    try {
      this.w.documentTrash?.assertAvailable(actor, resourceId)
      const current = await this.inspect(actor, api, path),
        record = this.read(actor, resourceId)
      if (current.resourceId !== resourceId || current.etag !== etag || current.sha256 !== sha256)
        throw new Error('Document changed; reload metadata')
      if (record.version !== version) throw new Error('Metadata changed; reload before saving')
      if (typeof tag !== 'string' || !current.tags.includes(tag))
        throw new Error('Choose a tag currently applied to this document')
      if (
        this.db
          .prepare(
            "select id from metadata_changes where scope=? and resource=? and state='intent'"
          )
          .get(this.w.scope(actor), this.key(actor, resourceId))
      )
        throw new Error('Recheck the pending tag operation first')
      const id = randomUUID(),
        expected = current.tags.filter((value) => value !== tag)
      withTransaction(this.db, () => {
        this.db
          .prepare('insert into metadata_changes values(?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            this.w.scope(actor),
            this.key(actor, resourceId),
            path,
            sha256,
            etag,
            version,
            JSON.stringify(record.fields),
            JSON.stringify(expected),
            'intent',
            new Date().toISOString()
          )
        this.db.prepare('insert into metadata_tag_removals values(?,?)').run(id, tag)
        this.w.event(actor, null, 'metadata_tag_removal_intent', { id, resourceId, tag })
      })
      // One resource-scoped unassignment; never delete the tag definition or retry
      // an uncertain DELETE. Subsequent verification is entirely read-only.
      try {
        await api.removeTags(resourceId, [tag])
      } catch (error) {
        const checked = await this.reconcile(actor, api, id)
        if (checked.state === 'done') return checked
        if ([400, 401, 403, 404, 409, 422].includes(error.status)) {
          this.db
            .prepare("update metadata_changes set state='refused' where id=? and state='intent'")
            .run(id)
          this.w.event(actor, null, 'metadata_tag_removal_refused', { id, resourceId })
          throw error
        }
        throw error
      }
      return await this.reconcile(actor, api, id)
    } finally {
      release()
    }
  }
  async reconcile(actor, api, id) {
    const change = this.db
      .prepare('select * from metadata_changes where id=? and scope=?')
      .get(id, this.w.scope(actor))
    if (!change) throw new Error('Metadata operation not found')
    if (change.state !== 'intent')
      return { state: change.state, record: this.read(actor, change.resource) }
    const current = await this.inspect(actor, api, change.path)
    if (this.key(actor, current.resourceId) !== change.resource || current.sha256 !== change.sha)
      throw new Error('Document changed; metadata operation held')
    const removal = this.db
      .prepare('select tag from metadata_tag_removals where change_id=?')
      .get(id)
    if (
      (removal && current.tags.includes(removal.tag)) ||
      !JSON.parse(change.tags).every((t) => current.tags.includes(t))
    )
      return { state: 'intent', uncertain: true }
    withTransaction(this.db, () => {
      const latest = this.db.prepare('select state from metadata_changes where id=?').get(id)
      if (latest.state === 'done') return
      if (this.read(actor, change.resource).version !== change.base)
        throw new Error('Metadata version conflict')
      this.db
        .prepare(
          'insert into metadata values(?,?,?,?,?) on conflict(scope,resource) do update set version=excluded.version,fields=excluded.fields,updated=excluded.updated'
        )
        .run(
          change.scope,
          change.resource,
          change.base + 1,
          change.fields,
          new Date().toISOString()
        )
      this.db
        .prepare("update metadata_changes set state='done' where id=? and state='intent'")
        .run(id)
      this.w.event(actor, null, 'metadata_saved', {
        id,
        resourceId: change.resource,
        version: change.base + 1
      })
    })
    return { state: 'done', record: this.read(actor, change.resource), source: current }
  }
}
