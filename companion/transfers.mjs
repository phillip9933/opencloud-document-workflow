// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
const sha = (b) => createHash('sha256').update(b).digest('hex')
// Cross-Space storage cannot MOVE atomically. Persist each one-shot mutation,
// bind the destination identity to its successful PUT receipt, and retain the
// source until the complete destination and recoverable Trash are verified.
export class Transfers {
  constructor(workflow) {
    this.w = workflow
    this.db = workflow.db
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cross_transfers(job TEXT PRIMARY KEY,scope TEXT NOT NULL,source TEXT NOT NULL,target_space TEXT NOT NULL,target_path TEXT NOT NULL,resource TEXT,state TEXT NOT NULL,baseline TEXT,trash_ack INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS resource_aliases(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(scope,resource));
 CREATE TABLE IF NOT EXISTS file_locations(scope TEXT NOT NULL,resource TEXT NOT NULL,space TEXT NOT NULL,target_resource TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,job TEXT NOT NULL,PRIMARY KEY(scope,resource));`)
    workflow.transfers = this
    for (const row of this.db
      .prepare("select * from cross_transfers where state='done' order by rowid")
      .all()) {
      const source = JSON.parse(row.source),
        actor = { server: source.server, account: source.account, space: JSON.parse(row.scope)[2] },
        canonical = this.canonical(actor, source.resourceId, source.space)
      for (const item of [
        { resource: source.resourceId, space: source.space },
        { resource: row.resource, space: row.target_space }
      ])
        this.db
          .prepare('insert or ignore into resource_aliases values(?,?,?,?)')
          .run(row.scope, item.resource, item.space, canonical)
    }
  }
  canonical(actor, resource, space = actor.space) {
    return (
      this.db
        .prepare('select canonical from resource_aliases where scope=? and resource=?')
        .get(this.w.scope(actor), resource)?.canonical ??
      this.db
        .prepare(
          'select resource from file_locations where scope=? and space=? and target_resource=?'
        )
        .get(this.w.scope(actor), space, resource)?.resource ??
      resource
    )
  }
  async adapter(actor, api, space) {
    const scoped = space === api.space || !space || !api.forSpace ? api : api.forSpace(space),
      identity = await scoped.identity()
    if (
      identity.server !== actor.server ||
      identity.account !== actor.account ||
      identity.space !== space
    )
      throw new Error('The selected Space could not be verified')
    return scoped
  }
  async apply(actor, api, id, approval, plan, { reconcileOnly = false, guard = () => {} } = {}) {
    const check = (api, path, source, etag) => this.w.check(api, path, source, etag, actor)
    let releaseDestination
    try {
      const source = approval.source,
        targetSpace = approval.actions.targetSpace,
        target = approval.actions.target,
        scope = this.w.scope(actor),
        sourceAPI = await this.adapter(actor, api, source.space),
        destination = await this.adapter(actor, api, targetSpace),
        tags = [...new Set([...plan.originalTags, ...approval.actions.addTags])].sort()
      let row = this.db
        .prepare('select * from cross_transfers where job=? and scope=?')
        .get(id, scope)
      if (!row) {
        if (reconcileOnly) return { state: 'approved', target }
        if (
          !(await check(sourceAPI, source.path, source, source.etag)) ||
          (await destination.stat(target))
        )
          throw new Error('The source or destination changed before transfer')
        const folders = target.split('/').slice(0, -1)
        for (let n = 1; n <= folders.length; n++) {
          guard()
          await destination.mkdir(folders.slice(0, n).join('/'))
        }
        if (await destination.stat(target)) throw new Error('Destination already exists')
        const bytes = await sourceAPI.get(
          source.path,
          source.etag,
          (this.w.configuration?.settings(actor).limits.maxMiB ?? 100) * 1024 * 1024
        )
        if (
          sha(bytes) !== source.sha256 ||
          !(await check(sourceAPI, source.path, source, source.etag))
        )
          throw new Error('Source changed before transfer')
        guard()
        this.db
          .prepare(
            "insert into cross_transfers(job,scope,source,target_space,target_path,state) values(?,?,?,?,?,'copy_intent')"
          )
          .run(id, scope, JSON.stringify(source), targetSpace, target)
        this.w.set(actor, id, 'copy_intent', plan)
        try {
          const receipt = await destination.put(target, bytes)
          if (!receipt?.resourceId) throw new Error('Missing transfer receipt')
          this.db
            .prepare("update cross_transfers set state='copied',resource=? where job=?")
            .run(receipt.resourceId, id)
        } catch {
          this.w.event(actor, id, 'copy_response_uncertain')
          return { state: 'copy_intent', uncertain: true, target }
        }
        row = this.db.prepare('select * from cross_transfers where job=?').get(id)
      }
      // A lost successful PUT response has no trustworthy new resource identity.
      // Matching bytes alone cannot adopt another writer's file or clear a source.
      if (!row.resource) return { state: 'copy_intent', uncertain: true, target }
      releaseDestination = this.w.lock(`resource:${scope}:${row.resource}`)
      const expected = { ...source, space: targetSpace, resourceId: row.resource },
        current = await check(destination, target, expected)
      if (!current) throw new Error('The transferred destination needs inspection')
      if (row.state === 'done' && this.w.decision(actor, id).state === 'done')
        return {
          state: 'done',
          target,
          space: targetSpace,
          tags: current.tags,
          verification: {
            checkedAt: new Date().toISOString(),
            resourceId: row.resource,
            originalResourceId: source.resourceId,
            sha256: source.sha256
          }
        }
      if (row.state === 'copied') {
        if (!tags.every((tag) => current.tags.includes(tag))) {
          if (reconcileOnly) {
            this.w.set(actor, id, 'transfer_ready', plan)
            return { state: 'transfer_ready', target }
          }
          guard()
          this.db.prepare("update cross_transfers set state='tags_intent' where job=?").run(id)
          try {
            await destination.addTags(row.resource, tags)
          } catch {
            return { state: 'tags_intent', uncertain: true, target }
          }
        }
        row = this.db.prepare('select * from cross_transfers where job=?').get(id)
      }
      if (row.state === 'tags_intent' || row.state === 'copied') {
        const verified = await check(destination, target, expected)
        if (!verified || !tags.every((tag) => verified.tags.includes(tag)))
          return { state: 'tags_intent', uncertain: true, target }
        this.db.prepare("update cross_transfers set state='verified' where job=?").run(id)
        this.w.set(actor, id, 'transfer_ready', plan)
        row = this.db.prepare('select * from cross_transfers where job=?').get(id)
      }
      if (row.state === 'verified') {
        if (reconcileOnly) {
          this.w.set(actor, id, 'transfer_ready', plan)
          return { state: 'transfer_ready', target }
        }
        const original = await check(sourceAPI, source.path, source, source.etag),
          baseline = await sourceAPI.listTrash(),
          verifiedCopy = await check(destination, target, expected)
        if (!original || !verifiedCopy || !tags.every((tag) => verifiedCopy.tags.includes(tag)))
          throw new Error('Both files require inspection before clearing the inbox')
        guard()
        this.db
          .prepare("update cross_transfers set state='trash_intent',baseline=? where job=?")
          .run(JSON.stringify(baseline.map((f) => f.id)), id)
        this.w.event(actor, id, 'transfer_trash_intent', {
          resourceId: source.resourceId,
          targetSpace,
          resource: row.resource
        })
        try {
          await sourceAPI.trash(source.path, source.etag)
          this.db.prepare('update cross_transfers set trash_ack=1 where job=?').run(id)
        } catch {
          /* Never replay this request. */
        }
        row = this.db.prepare('select * from cross_transfers where job=?').get(id)
      }
      if (row.state === 'trash_intent') {
        if (await sourceAPI.stat(source.path))
          return { state: 'copy_intent', uncertain: true, target }
        const baseline = new Set(JSON.parse(row.baseline)),
          trash = await sourceAPI.listTrash(),
          node = source.resourceId.split('!').at(-1),
          entry = trash.filter(
            (f) =>
              !baseline.has(f.id) &&
              !f.folder &&
              f.path === source.path &&
              (row.trash_ack || f.resourceId === source.resourceId || f.id === node)
          )
        if (entry.length !== 1) return { state: 'copy_intent', uncertain: true, target }
        this.db.prepare("update cross_transfers set state='done' where job=?").run(id)
      }
      const final = await check(destination, target, expected)
      if (!final || !tags.every((tag) => final.tags.includes(tag)))
        throw new Error('The transferred destination changed')
      const canonical = this.canonical(actor, source.resourceId, source.space)
      this.db
        .prepare(
          'insert into file_locations values(?,?,?,?,?,?,?) on conflict(scope,resource) do update set space=excluded.space,target_resource=excluded.target_resource,path=excluded.path,sha=excluded.sha,job=excluded.job'
        )
        .run(scope, canonical, targetSpace, row.resource, target, source.sha256, id)
      for (const item of [
        { resource: source.resourceId, space: source.space },
        { resource: row.resource, space: targetSpace }
      ]) {
        this.db
          .prepare('insert or ignore into resource_aliases values(?,?,?,?)')
          .run(scope, item.resource, item.space, canonical)
        if (
          this.db
            .prepare('select canonical from resource_aliases where scope=? and resource=?')
            .get(scope, item.resource).canonical !== canonical
        )
          throw new Error('Transferred identity needs inspection')
      }
      plan.expectedTags = tags
      plan.targetResource = row.resource
      this.w.set(actor, id, 'done', plan)
      return {
        state: 'done',
        target,
        space: targetSpace,
        tags: final.tags,
        verification: {
          checkedAt: new Date().toISOString(),
          resourceId: row.resource,
          originalResourceId: source.resourceId,
          sha256: source.sha256
        }
      }
    } finally {
      releaseDestination?.()
    }
  }
}
