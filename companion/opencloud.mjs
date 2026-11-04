// SPDX-License-Identifier: AGPL-3.0-only
import { RemoteError, remoteResponse, responseBytes } from './remote-transport.mjs'
export { RemoteError, responseBytes } from './remote-transport.mjs'
import { XMLParser } from 'fast-xml-parser'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { safePath } from '../src/domain/review.ts'
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (n) => ['response', 'propstat', 'tag'].includes(n)
})
export function parseDAV(xml, base) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not allowed')
  const root = parser.parse(xml).multistatus
  if (!root || !Array.isArray(root.response)) throw new Error('Invalid DAV response')
  return root.response.map((r) => {
    const href = new URL(r.href, base),
      prefix = new URL(base)
    const decoded = decodeURIComponent(href.pathname),
      decodedBase = decodeURIComponent(prefix.pathname)
    if (href.origin !== prefix.origin || !decoded.startsWith(decodedBase))
      throw new Error('DAV response outside configured Space')
    const path = decoded.slice(decodedBase.length).replace(/\/$/, '')
    if (path) safePath(path)
    const props = {}
    for (const ps of r.propstat ?? []) if (/\s200\s/.test(ps.status)) Object.assign(props, ps.prop)
    const tags =
      props.tags?.tag ??
      (typeof props.tags === 'string'
        ? props.tags
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [])
    return {
      ...(typeof props.displayname === 'string' ? { displayName: props.displayname } : {}),
      path,
      resourceId: props.fileid ?? props.id,
      etag: props.getetag,
      tags: [...new Set(tags)],
      folder:
        !!props.resourcetype &&
        typeof props.resourcetype === 'object' &&
        'collection' in props.resourcetype,
      size: Number(props.getcontentlength ?? 0)
    }
  })
}
export class OpenCloudAdapter {
  constructor({ origin, space, token, username, appToken, fetcher = fetch }) {
    const u = new URL(origin)
    if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password)
      throw new Error('OpenCloud requires an HTTPS origin')
    if (typeof space !== 'string' || !space || /[/\\?#%\x00-\x20]/.test(space))
      throw new Error('Invalid configured Space ID')
    if (appToken !== undefined) {
      if (
        typeof username !== 'string' ||
        !username ||
        /[\r\n:]/.test(username) ||
        typeof appToken !== 'string' ||
        !appToken ||
        /[\r\n]/.test(appToken)
      )
        throw new Error('An OpenCloud app token and account name are required')
      this.credentials = { username, appToken }
    } else {
      if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
        throw new Error('An authenticated OpenCloud session is required')
      this.credentials = { token }
    }
    this.origin = origin
    this.space = space
    this.auth =
      appToken !== undefined
        ? 'Basic ' + Buffer.from(username + ':' + appToken).toString('base64')
        : `Bearer ${token}`
    this.fetcher = fetcher
    this.base = `${origin}/dav/spaces/${encodeURIComponent(space)}/`
    this.trashBase = `${origin}/dav/spaces/trash-bin/${encodeURIComponent(space)}/`
  }
  url(path) {
    return this.base + (path ? safePath(path).split('/').map(encodeURIComponent).join('/') : '')
  }
  async request(method, url, { body, headers = {}, max } = {}) {
    const res = await remoteResponse(this, method, url, { body, headers })
    return responseBytes(res, max)
  }
  forSpace(space) {
    return new OpenCloudAdapter({
      origin: this.origin,
      space,
      ...this.credentials,
      fetcher: this.fetcher
    })
  }
  async spaces() {
    const nextBase = this.origin + '/graph/v1.0/me/drives',
      seen = new Set(),
      found = new Map()
    let next = nextBase
    while (next) {
      const url = new URL(next)
      if (
        url.username ||
        url.password ||
        url.hash ||
        url.origin !== this.origin ||
        (url.pathname !== '/graph/v1.0/me/drives' && url.pathname !== '/graph/v1.0/me/drives/') ||
        seen.has(url.href)
      )
        throw new Error('Invalid Space listing continuation')
      seen.add(url.href)
      const data = JSON.parse(
        (await this.request('GET', url.href, { max: 4 * 1024 * 1024 })).toString()
      )
      if (!Array.isArray(data.value)) throw new Error('Invalid Space directory')
      for (const drive of data.value) {
        if (typeof drive.id !== 'string' || !drive.id || /[/\\?#%\x00-\x20]/.test(drive.id))
          throw new Error('Invalid Space ID')
        if (drive.root?.deleted || drive.deleted) continue
        found.set(drive.id, {
          id: drive.id,
          name: typeof drive.name === 'string' ? drive.name : drive.id,
          type: drive.driveType ?? 'project'
        })
      }
      next = data['@odata.nextLink'] ?? null
      if (next !== null && typeof next !== 'string')
        throw new Error('Invalid Space listing continuation')
    }
    return [...found.values()]
  }
  async accountIdentity() {
    const value = JSON.parse(
      (await this.request('GET', `${this.origin}/graph/v1.0/me`, { max: 64_000 })).toString()
    )
    if (typeof value.id !== 'string' || !value.id) throw new Error('Invalid authenticated identity')
    this.account = value.id
    return {
      account: value.id,
      name: value.displayName ?? value.id,
      ...(typeof value.onPremisesSamAccountName === 'string' &&
      value.onPremisesSamAccountName.trim() &&
      value.onPremisesSamAccountName.length <= 400 &&
      !/[\x00-\x1f\x7f:]/.test(value.onPremisesSamAccountName)
        ? { username: value.onPremisesSamAccountName }
        : {}),
      server: this.origin,
      space: this.space,
      mode: 'live'
    }
  }
  async identity() {
    const actor = await this.accountIdentity(),
      root = await this.stat('')
    if (!root?.folder) throw new RemoteError(403)
    return { ...actor, ...(root.displayName ? { spaceName: root.displayName } : {}) }
  }
  async isAdministrator() {
    if (!this.account) await this.accountIdentity()
    try {
      const data = JSON.parse(
        (
          await this.request(
            'GET',
            `${this.origin}/graph/v1.0/users/${encodeURIComponent(this.account)}/appRoleAssignments`,
            { max: 64000 }
          )
        ).toString()
      )
      return (
        Array.isArray(data.value) &&
        data.value.some(
          (role) =>
            role.principalId === this.account &&
            role.appRoleId === '71881883-1768-46bd-a24d-a356a2afdf7f'
        )
      )
    } catch (e) {
      if ([401, 403].includes(e.status)) return false
      throw e
    }
  }
  async put(path, bytes, { contentType = 'application/pdf' } = {}) {
    if (!['application/pdf', 'application/vnd.sqlite3', 'application/json'].includes(contentType))
      throw new Error('Unsupported upload type')
    const response = await remoteResponse(this, 'PUT', this.url(path), {
      body: bytes,
      timeout: 120000,
      statuses: [201],
      headers: { 'If-None-Match': '*', 'Content-Type': contentType }
    })
    await response.body?.cancel()
    const resourceId = response.headers.get('OC-FileId')
    if (!resourceId) throw new Error('Transfer response needs verification')
    return { resourceId }
  }
  async replacePDF(path, bytes, etag) {
    if (typeof etag !== 'string' || !etag || /[\r\n]/.test(etag))
      throw new Error('A current PDF version is required')
    const response = await remoteResponse(this, 'PUT', this.url(path), {
      body: bytes,
      timeout: 120000,
      statuses: [200, 204],
      headers: { 'If-Match': etag, 'Content-Type': 'application/pdf' }
    })
    await response.body?.cancel()
  }
  async putFile(path, file, { contentType } = {}) {
    if (!['application/vnd.sqlite3', 'application/json'].includes(contentType))
      throw new Error('Unsupported backup type')
    const size = (await stat(file)).size,
      stream = createReadStream(file)
    try {
      const response = await remoteResponse(this, 'PUT', this.url(path), {
        body: stream,
        duplex: 'half',
        timeout: 300000,
        statuses: [201],
        headers: {
          'If-None-Match': '*',
          'Content-Type': contentType,
          'Content-Length': String(size)
        }
      })
      await response.body?.cancel()
    } finally {
      stream.destroy()
    }
  }
  async digest(path, etag, max) {
    const response = await remoteResponse(this, 'GET', this.url(path), {
      timeout: 300000,
      headers: { 'If-Match': etag }
    })
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length
      if (bytes > max) throw new Error('Remote response exceeds limit')
      hash.update(chunk)
    }
    return { bytes, sha256: hash.digest('hex') }
  }
  async list(path = '') {
    const body =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/><oc:fileid/><oc:tags/></d:prop></d:propfind>'
    return parseDAV(
      (
        await this.request('PROPFIND', this.url(path), {
          body,
          headers: { Depth: '1', 'Content-Type': 'application/xml' },
          max: 16 * 1024 * 1024
        })
      ).toString(),
      this.base
    ).filter((f) => f.path !== path)
  }
  async stat(path) {
    const body =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:displayname/><d:getcontentlength/><d:getetag/><d:resourcetype/><oc:fileid/><oc:tags/></d:prop></d:propfind>'
    try {
      const rows = parseDAV(
        (
          await this.request('PROPFIND', this.url(path), {
            body,
            headers: { Depth: '0', 'Content-Type': 'application/xml' },
            max: 64_000
          })
        ).toString(),
        this.base
      )
      const f = rows.find((f) => f.path === path)
      if (!f?.resourceId || !f.etag) throw new Error('Incomplete DAV identity')
      return f
    } catch (e) {
      if (e.status === 404) return null
      throw e
    }
  }
  async get(path, etag, max = 100 * 1024 * 1024) {
    return this.request('GET', this.url(path), { headers: etag ? { 'If-Match': etag } : {}, max })
  }
  async mkdir(path) {
    const current = await this.stat(path)
    if (current) {
      if (!current.folder) throw new Error('File blocks folder')
      return
    }
    try {
      await this.request('MKCOL', this.url(path))
    } catch (e) {
      if (e.status !== 405) throw e
      const found = await this.stat(path)
      if (!found?.folder) throw e
    }
  }
  async move(source, target, etag) {
    await this.request('MOVE', this.url(source), {
      headers: { Destination: this.url(target), 'If-Match': etag, Overwrite: 'F' }
    })
  }
  async listTrash() {
    const body =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getcontentlength/><d:resourcetype/><oc:fileid/><oc:trashbin-original-location/><oc:trashbin-original-filename/><oc:trashbin-delete-datetime/></d:prop></d:propfind>'
    return parseTrash(
      (
        await this.request('PROPFIND', this.trashBase, {
          body,
          headers: { Depth: '1', 'Content-Type': 'application/xml' },
          max: 16 * 1024 * 1024
        })
      ).toString(),
      this.trashBase
    )
  }
  async trash(path, etag) {
    if (!path || !etag) throw new Error('A file identity is required for Trash')
    await this.request('DELETE', this.url(path), { headers: { 'If-Match': etag } })
  }
  async removeTags(resourceId, tags) {
    if (!tags.length) return
    await this.request('DELETE', `${this.origin}/graph/v1.0/extensions/org.libregraph/tags`, {
      body: JSON.stringify({
        resourceId: resourceId.includes('!') ? resourceId : `${this.space}!${resourceId}`,
        tags
      }),
      headers: { 'Content-Type': 'application/json' }
    })
  }
  async listTags() {
    const value = JSON.parse(
      (
        await this.request('GET', `${this.origin}/graph/v1.0/extensions/org.libregraph/tags`, {
          max: 4 * 1024 * 1024
        })
      ).toString()
    ).value
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string'))
      throw new Error('Invalid tag directory')
    return value
  }
  async addTags(resourceId, tags) {
    if (!tags.length) return
    await this.request('PUT', `${this.origin}/graph/v1.0/extensions/org.libregraph/tags`, {
      body: JSON.stringify({
        resourceId: resourceId.includes('!') ? resourceId : `${this.space}!${resourceId}`,
        tags
      }),
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// Trash has a separate, read-only URL boundary. Ordinary DAV parsing remains
// restricted to the selected live Space. No purge or trash DELETE is exposed.
export function parseTrash(xml, base) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not allowed')
  const root = parser.parse(xml).multistatus
  if (!root || !Array.isArray(root.response)) throw new Error('Invalid Trash response')
  const prefix = new URL(base),
    decodedBase = decodeURIComponent(prefix.pathname),
    rows = []
  for (const r of root.response) {
    const href = new URL(r.href, base),
      decoded = decodeURIComponent(href.pathname)
    if (href.origin !== prefix.origin || !decoded.startsWith(decodedBase))
      throw new Error('Trash response outside selected Space')
    const id = decoded.slice(decodedBase.length).replace(/\/$/, '')
    if (!id) continue
    if (id.includes('/') || id === '.' || id === '..') throw new Error('Invalid Trash identity')
    const props = {}
    for (const ps of r.propstat ?? []) if (/\s200\s/.test(ps.status)) Object.assign(props, ps.prop)
    const path = props['trashbin-original-location']
    if (typeof path !== 'string') throw new Error('Missing Trash original location')
    const clean = path.replace(/^\//, '')
    safePath(clean)
    rows.push({
      id,
      path: clean,
      resourceId: props.fileid,
      size: Number(props.getcontentlength ?? 0),
      folder:
        !!props.resourcetype &&
        typeof props.resourcetype === 'object' &&
        'collection' in props.resourcetype
    })
  }
  return rows
}
