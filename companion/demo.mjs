// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { withTransaction } from './transactions.mjs'
// An isolated local simulation; never reads or writes OpenCloud storage.
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { RemoteError } from './opencloud.mjs'
export class DemoAdapter {
  /** @param {import('node:sqlite').DatabaseSync} db @param {{space?:string}} options */
  constructor(db, { space = 'local-draft' } = {}) {
    if (!['local-draft', 'local-archive'].includes(space)) throw new RemoteError(403)
    this.db = db
    this.origin = 'https://opencloud.example'
    this.account = 'local-demo'
    this.space = space
    this.table =
      space === 'local-draft'
        ? 'demo_files'
        : 'demo_files_' + createHash('sha256').update(space).digest('hex').slice(0, 12)
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table}(path TEXT PRIMARY KEY,resourceId TEXT UNIQUE,etag TEXT NOT NULL,tags TEXT NOT NULL,folder INTEGER NOT NULL,data BLOB)`
    )
  }
  /** @param {string} space */
  forSpace(space) {
    return new DemoAdapter(this.db, { space })
  }
  async isAdministrator() {
    return true
  }
  /** @param {string} path @param {Buffer} bytes */
  async put(path, bytes) {
    if (await this.stat(path)) throw new RemoteError(412)
    const resourceId = randomUUID()
    this.db
      .prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,?)`)
      .run(path, resourceId, '"uploaded"', '[]', 0, bytes)
    return { resourceId }
  }
  /** @param {string} path @param {Buffer} bytes @param {string} etag */
  async replacePDF(path, bytes, etag) {
    const result = this.db
      .prepare(`update ${this.table} set data=?,etag=? where path=? and etag=? and folder=0`)
      .run(bytes, '"replaced"', path, etag)
    if (!result.changes) throw new RemoteError(412)
  }
  async spaces() {
    return [
      { id: 'local-draft', name: 'Local documents', type: 'project' },
      { id: 'local-archive', name: 'Local archive', type: 'project' }
    ]
  }
  /** @returns {Promise<string[]>} */
  async listTags() {
    return [
      ...new Set(
        this.db
          .prepare(`select tags from ${this.table} where folder=0`)
          .all()
          .flatMap((row) => JSON.parse(String(row.tags)))
      )
    ]
  }
  /** @returns {Promise<import('./contracts.d.mts').Actor & {name:string}>} */
  async identity() {
    return {
      mode: 'demo',
      server: this.origin,
      account: this.account,
      space: this.space,
      name: 'Local draft tester'
    }
  }
  seed() {
    if (this.db.prepare(`select count(*) n from ${this.table}`).get()?.n) return
    for (const path of ['Inbox', 'Filed'])
      this.db
        .prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,?)`)
        .run(path, `folder-${path}`, '"folder-v1"', '[]', 1, null)
    for (const name of ['english', 'japanese', 'image-only'])
      this.db
        .prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,?)`)
        .run(
          `Inbox/${name}.pdf`,
          `demo-${name}`,
          '"v1"',
          JSON.stringify(['Keep existing']),
          0,
          readFileSync(new URL(`../tests/fixtures/${name}.pdf`, import.meta.url))
        )
  }
  addScannedFixture() {
    const id = randomUUID(),
      path = `Inbox/scanned-${id.slice(0, 8)}.pdf`
    this.db
      .prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,?)`)
      .run(
        path,
        id,
        '"v1"',
        JSON.stringify(['Keep existing']),
        0,
        readFileSync(new URL('../tests/fixtures/scanned-english.pdf', import.meta.url))
      )
    return { path, resourceId: id }
  }
  /** @param {string} path */
  async stat(path) {
    const r = this.db
      .prepare(
        `select path,resourceId,etag,tags,folder,length(data) size from ${this.table} where path=?`
      )
      .get(path)
    return r
      ? {
          path: String(r.path),
          resourceId: String(r.resourceId),
          etag: String(r.etag),
          size: Number(r.size),
          tags: /** @type {string[]} */ (JSON.parse(String(r.tags))),
          folder: !!r.folder
        }
      : null
  }
  async list(path = '') {
    const all = this.db.prepare(`select path from ${this.table}`).all()
    const rows = []
    for (const r of all) {
      if (
        String(r.path).startsWith(path ? path + '/' : '') &&
        !String(r.path)
          .slice(path ? path.length + 1 : 0)
          .includes('/')
      ) {
        const file = await this.stat(String(r.path))
        if (file) rows.push(file)
      }
    }
    return rows
  }
  /** @param {string} path @param {string} [etag] */
  async get(path, etag) {
    const r = this.db.prepare(`select etag,data from ${this.table} where path=?`).get(path)
    if (!r) throw new RemoteError(404)
    if (etag && r.etag !== etag) throw new RemoteError(412)
    if (!(r.data instanceof Uint8Array))
      throw new WorkflowError('OPERATION_HELD', 'Document bytes are missing')
    return Buffer.from(r.data)
  }
  /** @param {string} path */
  async mkdir(path) {
    const r = await this.stat(path)
    if (r) {
      if (!r.folder) throw new WorkflowError('OPERATION_HELD', 'File blocks folder')
      return
    }
    this.db
      .prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,?,?)`)
      .run(path, `folder-${path}`, '"folder-v1"', '[]', 1, null)
  }
  /** @param {string} source @param {string} target @param {string} etag */
  async move(source, target, etag) {
    if (await this.stat(target)) throw new RemoteError(412)
    const result = this.db
      .prepare(`update ${this.table} set path=?,etag=? where path=? and etag=?`)
      .run(target, '"moved"', source, etag)
    if (!result.changes) throw new RemoteError(412)
  }
  async listTrash() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS demo_trash(space TEXT,id TEXT,path TEXT,resourceId TEXT,etag TEXT,tags TEXT,folder INTEGER,data BLOB,PRIMARY KEY(space,id))`
    )
    return this.db
      .prepare('select id,path,resourceId,folder,length(data) size from demo_trash where space=?')
      .all(this.space)
      .map((r) => ({
        id: String(r.id),
        path: String(r.path),
        resourceId: String(r.resourceId),
        size: Number(r.size),
        folder: !!r.folder
      }))
  }
  /** @param {string} path @param {string} etag */
  async trash(path, etag) {
    await this.listTrash()
    const file = this.db
      .prepare(`select * from ${this.table} where path=? and etag=? and folder=0`)
      .get(path, etag)
    if (!file) throw new RemoteError(412)
    withTransaction(this.db, () => {
      this.db
        .prepare('insert into demo_trash values(?,?,?,?,?,?,?,?)')
        .run(
          this.space,
          file.resourceId,
          file.path,
          file.resourceId,
          file.etag,
          file.tags,
          file.folder,
          file.data
        )
      this.db.prepare(`delete from ${this.table} where path=? and etag=?`).run(path, etag)
    })
  }
  /** @param {string} resourceId @param {string[]} tags */
  async removeTags(resourceId, tags) {
    const file = this.db
      .prepare(`select tags from ${this.table} where resourceId=?`)
      .get(resourceId)
    if (!file) throw new RemoteError(404)
    this.db
      .prepare(`update ${this.table} set tags=? where resourceId=?`)
      .run(
        JSON.stringify(
          JSON.parse(String(file.tags)).filter(
            /** @param {unknown} tag */ (tag) => typeof tag === 'string' && !tags.includes(tag)
          )
        ),
        resourceId
      )
  }
  /** @param {string} resourceId @param {string[]} tags */
  async addTags(resourceId, tags) {
    const r = this.db.prepare(`select tags from ${this.table} where resourceId=?`).get(resourceId)
    if (!r) throw new RemoteError(404)
    this.db
      .prepare(`update ${this.table} set tags=? where resourceId=?`)
      .run(JSON.stringify([...new Set([...JSON.parse(String(r.tags)), ...tags])]), resourceId)
  }
}
