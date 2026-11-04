// SPDX-License-Identifier: AGPL-3.0-only
import { safePath } from '../src/domain/review.ts'
import { FiledLocations } from './locations.mjs'
const fold = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
function position(cursor) {
  if (cursor === undefined || cursor === null) return null
  try {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error()
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'id,updated,v' ||
      value.v !== 1 ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.id) ||
      typeof value.updated !== 'string' ||
      new Date(value.updated).toISOString() !== value.updated
    )
      throw new Error()
    return value
  } catch {
    throw new Error('Invalid document page; refresh the filed list')
  }
}

// Filing records and authenticated destination listings share no second file store.
// Each browse read is scoped to one configured folder; the UI builds its tree.
export class DocumentLibrary {
  constructor(workflow) {
    this.w = workflow
    this.db = workflow.db
    new FiledLocations(workflow)
    this.db.function('workflow_contains', { deterministic: true }, (text, query) =>
      fold(text).includes(fold(query)) ? 1 : 0
    )
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS saved_views(scope TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,query TEXT NOT NULL,PRIMARY KEY(scope,id));
   CREATE INDEX IF NOT EXISTS decisions_updated ON decisions(updated,job);
   CREATE INDEX IF NOT EXISTS proposals_scope_updated ON proposals(scope,updated,id);
   CREATE INDEX IF NOT EXISTS metadata_changes_lookup ON metadata_changes(scope,resource,state,created,id);`)
  }
  views(actor) {
    return this.db
      .prepare('select id,name,query from saved_views where scope=? order by name,id')
      .all(this.w.scope(actor))
      .map((row) => ({ ...row, query: JSON.parse(row.query) }))
  }
  saveView(actor, { id, name, query }) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      !query ||
      Object.keys(query).join(',') !== 'search' ||
      typeof query.search !== 'string' ||
      query.search.length > 200
    )
      throw new Error('Invalid saved view')
    this.db
      .prepare(
        'insert into saved_views values(?,?,?,?) on conflict(scope,id) do update set name=excluded.name,query=excluded.query'
      )
      .run(this.w.scope(actor), id, name.trim(), JSON.stringify(query))
    this.w.event(actor, null, 'view_saved', { id, name })
    return this.views(actor)
  }
  deleteView(actor, id) {
    this.db.prepare('delete from saved_views where scope=? and id=?').run(this.w.scope(actor), id)
    this.w.event(actor, null, 'view_deleted', { id })
    return this.views(actor)
  }
  async browse(actor, api, { path } = {}) {
    const root = safePath(this.w.configuration.settings(actor).rules.root),
      space = this.w.configuration.destinationSpace(actor)
    path = path === undefined ? root : safePath(path)
    if (path !== root && !path.startsWith(root + '/'))
      throw new Error('Choose a folder inside the document destination')
    const physical = await this.w.transfers.adapter(actor, api, space),
      files = await physical.list(path)
    for (const file of files) {
      safePath(file.path)
      if (!file.path.startsWith(path + '/') || file.path.slice(path.length + 1).includes('/'))
        throw new Error('Library listing outside requested folder')
    }
    return {
      root,
      path,
      space,
      files: files.map(({ path, resourceId, etag, folder, size, tags }) => ({
        path,
        resourceId,
        etag,
        folder,
        size,
        tags: tags ?? [],
        ...(!folder ? { fields: this.w.metadata?.read(actor, resourceId)?.fields ?? {} } : {})
      }))
    }
  }
  async currentList(actor, api, options = {}) {
    await this.w.locations.refresh(actor, api)
    return this.list(actor, options)
  }
  list(actor, { search = '', limit = 50, cursor } = {}) {
    if (
      typeof search !== 'string' ||
      search.length > 200 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid document search or page size')
    const after = position(cursor),
      scope = this.w.scope(actor),
      processed = this.db
        .prepare("select 1 from sqlite_master where type='table' and name='automatic_runs'")
        .get()
    const rows = this.db
      .prepare(
        `WITH records AS (
   SELECT d.job,d.updated,json_extract(d.record,'$.actions.target') path,coalesce(json_extract(d.record,'$.actions.targetSpace'),json_extract(p.input,'$.source.space')) physicalSpace,
    json_extract(p.input,'$.source.path') originalPath,json_extract(p.input,'$.source.resourceId') resourceId,
    json_extract(p.input,'$.source.sha256') sha256,json_extract(d.plan,'$.expectedTags') tags,
    json_extract(p.result,'$.proposal.issuer.value') sender,json_extract(p.result,'$.proposal.date.value') date,
    json_extract(p.result,'$.proposal.kind.value') kind,json_extract(p.input,'$.pages') extractedText,0 processed
   FROM decisions d JOIN proposals p ON p.id=d.job
   WHERE p.scope=? AND d.actor=? AND d.state='done'
   ${processed ? `UNION ALL SELECT p.id,a.updated,json_extract(p.input,'$.source.path'),json_extract(p.input,'$.source.space'),json_extract(p.input,'$.source.path'),json_extract(p.input,'$.source.resourceId'),json_extract(p.input,'$.source.sha256'),'[]',json_extract(p.result,'$.proposal.issuer.value'),json_extract(p.result,'$.proposal.date.value'),json_extract(p.result,'$.proposal.kind.value'),json_extract(p.input,'$.pages'),1 FROM automatic_runs a JOIN proposals p ON a.job=p.id LEFT JOIN decisions d ON d.job=p.id WHERE a.scope=? AND a.state='done' AND d.job IS NULL` : ''}
  ), canonical AS (SELECT records.*,${this.w.transfers ? 'coalesce((select l.canonical from resource_aliases l where l.scope=? and l.resource=records.resourceId),resourceId)' : 'resourceId'} canonicalResource FROM records), filed AS (SELECT canonical.*,row_number() OVER(PARTITION BY canonicalResource ORDER BY updated DESC,job DESC) revision FROM canonical), confirmed AS (SELECT f.*,l.path currentPath,l.tags currentTags,m.fields,coalesce(m.version,0) metadataVersion,
    (SELECT c.tags FROM metadata_changes c WHERE c.scope=? AND c.resource=f.canonicalResource AND c.state='done' AND c.created>=f.updated ORDER BY c.created DESC,c.id DESC LIMIT 1) metadataTags
   FROM filed f
   LEFT JOIN metadata m ON m.scope=? AND m.resource=f.canonicalResource
   LEFT JOIN filed_locations l ON l.scope=? AND l.space=${this.w.transfers ? 'coalesce((select space from file_locations where scope=l.scope and resource=f.canonicalResource),f.physicalSpace)' : 'f.physicalSpace'} AND l.resource=${this.w.transfers ? 'coalesce((select target_resource from file_locations where scope=l.scope and resource=f.canonicalResource),f.resourceId)' : 'f.resourceId'}
   WHERE revision=1) SELECT * FROM confirmed f WHERE (? IS NULL OR f.updated<? OR (f.updated=? AND f.job<?))
    AND workflow_contains(json_array(f.extractedText,coalesce(f.currentPath,f.path),f.sender,f.date,f.kind,coalesce(f.currentTags,f.tags),CASE WHEN f.currentTags IS NULL THEN f.metadataTags ELSE '[]' END,coalesce(f.fields,'{}')),?)
   ORDER BY f.updated DESC,f.job DESC LIMIT ?`
      )
      .all(
        scope,
        actor.account,
        ...(processed ? [scope] : []),
        ...(this.w.transfers ? [scope] : []),
        scope,
        scope,
        scope,
        after?.updated ?? null,
        after?.updated ?? null,
        after?.updated ?? null,
        after?.id ?? null,
        search.trim(),
        limit + 1
      )
    const hasMore = rows.length > limit,
      page = rows.slice(0, limit)
    const documents = page.map((row) => ({
      id: row.job,
      ...(this.w.transfers
        ? {
            space:
              this.db
                .prepare('select space from file_locations where scope=? and resource=?')
                .get(scope, row.canonicalResource)?.space ??
              row.physicalSpace ??
              actor.space
          }
        : {}),
      path: safePath(row.currentPath ?? row.path),
      originalPath: row.originalPath,
      resourceId: this.w.transfers
        ? (this.db
            .prepare('select target_resource from file_locations where scope=? and resource=?')
            .get(scope, row.canonicalResource)?.target_resource ?? row.resourceId)
        : row.resourceId,
      sha256: row.sha256,
      sender: row.sender,
      date: row.date,
      kind: row.kind,
      tags: row.currentTags
        ? JSON.parse(row.currentTags)
        : [...new Set([...JSON.parse(row.tags ?? '[]'), ...JSON.parse(row.metadataTags ?? '[]')])],
      fields: JSON.parse(row.fields ?? '{}'),
      metadataVersion: row.metadataVersion,
      processed: row.processed === 1,
      updated: row.updated
    }))
    const last = page.at(-1),
      nextCursor = hasMore
        ? Buffer.from(JSON.stringify({ v: 1, updated: last.updated, id: last.job })).toString(
            'base64url'
          )
        : null
    return { documents, nextCursor, hasMore }
  }
}
