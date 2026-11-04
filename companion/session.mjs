// SPDX-License-Identifier: AGPL-3.0-only
import { errorProperty } from './error-properties.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { logEvent } from './logging.mjs'
import { constants } from 'node:fs'
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { OpenCloudAdapter } from './opencloud.mjs'

/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest('hex')
/** @param {unknown} value @returns {value is string} */
const token = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\x00-\x20\x7f]/.test(value)
/** @param {string} code */
const reason = (code) =>
  Object.assign(new WorkflowError('OPERATION_HELD', code), { sessionReason: code })

// This store is intentionally separate from document state and backups. It is
// provisioned by the operator, never by a document or a browser API request.
export class PrivateSessionFile {
  /** @param {string} path @param {{excludedDirectory?:string;excludedDirectories?:string[]}} options */
  constructor(path, { excludedDirectory, excludedDirectories = [] } = {}) {
    this.path = resolve(path)
    this.intent = this.path + '.refresh-intent'
    this.excluded = [...excludedDirectories, ...(excludedDirectory ? [excludedDirectory] : [])].map(
      (p) => resolve(p)
    )
  }
  async checkDirectory() {
    const parent = dirname(this.path),
      actual = await realpath(parent),
      s = await lstat(parent)
    if (
      actual !== parent ||
      !s.isDirectory() ||
      s.mode & 0o077 ||
      this.excluded.some((p) => actual === p || actual.startsWith(p + '/'))
    )
      throw reason('private_file_required')
  }
  /** @param {string} path */
  async readFile(path) {
    await this.checkDirectory()
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = await f.stat()
      if (
        !s.isFile() ||
        s.size > 32768 ||
        s.mode & 0o077 ||
        (s.uid !== process.getuid?.() && s.uid !== 0)
      )
        throw reason('private_file_required')
      return await f.readFile('utf8')
    } finally {
      await f.close()
    }
  }
  /** @returns {Promise<import('./admin-contracts.d.mts').SessionRecord>} */
  async read() {
    const raw = await this.readFile(this.path)
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      if (!/^[[{]/.test(raw.trim()) && token(raw.trim()))
        return {
          value: { version: 1, access_token: raw.trim(), expires_at: null },
          hash: digest(raw),
          legacy: true
        }
      throw reason('credential_format')
    }
    if (
      !value ||
      Object.keys(value).some(
        (k) =>
          !['version', 'access_token', 'expires_at', 'refresh_token', 'client_secret'].includes(k)
      ) ||
      value.version !== 1 ||
      !token(value.access_token) ||
      !Number.isSafeInteger(value.expires_at) ||
      value.expires_at <= 0 ||
      (value.refresh_token !== undefined && !token(value.refresh_token)) ||
      (value.client_secret !== undefined && !token(value.client_secret))
    )
      throw reason('credential_format')
    return { value, hash: digest(raw), legacy: false }
  }
  async pending() {
    try {
      const value = JSON.parse(await this.readFile(this.intent))
      if (
        value.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(value.hash) ||
        !Number.isSafeInteger(value.created) ||
        (value.reason !== undefined && value.reason !== 'sign_in_required')
      )
        throw reason('refresh_uncertain')
      return value
    } catch (e) {
      if (errorProperty(e, 'code') === 'ENOENT') return null
      throw reason('refresh_uncertain')
    }
  }
  async syncDirectory() {
    const directory = await open(dirname(this.path), constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  /** @param {string} hash */
  async begin(hash) {
    await this.checkDirectory()
    const f = await open(
      this.intent,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await f.writeFile(JSON.stringify({ version: 1, hash, created: Date.now() }))
      await f.sync()
    } finally {
      await f.close()
    }
    await this.syncDirectory()
  }
  async clear() {
    await unlink(this.intent)
    await this.syncDirectory()
  }
  async block() {
    const value = await this.pending()
    if (!value) throw reason('refresh_uncertain')
    const f = await open(this.intent, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    try {
      await f.writeFile(JSON.stringify({ ...value, reason: 'sign_in_required' }))
      await f.sync()
    } finally {
      await f.close()
    }
  }
  /** @param {import('./admin-contracts.d.mts').SessionRecord} previous @param {import('./admin-contracts.d.mts').SessionValue} value */
  async replace(previous, value) {
    const current = await this.read()
    if (current.hash !== previous.hash) throw reason('credential_changed')
    const tmp = this.path + '.pending-' + randomUUID()
    let published = false
    try {
      const f = await open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        await f.writeFile(JSON.stringify(value) + '\n')
        await f.sync()
      } finally {
        await f.close()
      }
      // The directory is private; reject an operator replacement rather than
      // overwriting a newly supplied grant with an older in-flight response.
      if ((await this.read()).hash !== previous.hash) throw reason('credential_changed')
      await rename(tmp, this.path)
      published = true
      const directory = await open(dirname(this.path), constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      if (!published) await unlink(tmp).catch(() => {})
    }
  }
}

export class SessionSupervisor {
  /** @param {import('./admin-contracts.d.mts').SessionOptions} options */
  constructor({
    file,
    origin,
    space,
    account,
    attach,
    detach,
    tokenEndpoint,
    clientId,
    excludedDirectory,
    excludedDirectories,
    fetcher = fetch,
    adapterFactory = (options) => new OpenCloudAdapter(options),
    now = () => Date.now(),
    intervalMs = 30000,
    logger = logEvent
  }) {
    if (!account || typeof account !== 'string')
      throw new WorkflowError('OPERATION_HELD', 'Background access requires an explicit account ID')
    if (tokenEndpoint) {
      const u = new URL(tokenEndpoint)
      if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || !clientId)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Background renewal requires an explicit HTTPS token endpoint and client ID'
        )
    }
    this.store = new PrivateSessionFile(file, { excludedDirectory, excludedDirectories })
    this.origin = origin
    this.space = space
    this.account = account
    this.attach = attach
    this.detach = detach
    this.tokenEndpoint = tokenEndpoint
    this.clientId = clientId
    this.fetcher = fetcher
    this.adapterFactory = adapterFactory
    this.now = now
    this.intervalMs = intervalMs
    this.logger = logger
    /** @type {import('./api-contracts.d.mts').ServiceAdapter|null} */
    this.current = null
    /** @type {Promise<void>|null} */
    this.active = null
    this.stopped = false
    this.nextAttempt = 0
    this.failures = 0
    /** @type {{state:string;expiresAt:number|null;lastSuccess:number|null;reason:string|null}} */
    this.health = { state: 'starting', expiresAt: null, lastSuccess: null, reason: null }
  }
  /** @param {import('./contracts.d.mts').Actor|undefined} actor */
  status(actor) {
    if (actor && (actor.account !== this.account || actor.server !== this.origin))
      return { configured: false, state: 'not_configured' }
    return {
      configured: true,
      ...this.health,
      nextAttempt: this.nextAttempt || null,
      renewable: !!this.tokenEndpoint && this.hasRefresh === true
    }
  }
  /** @param {string} code */
  async hold(code) {
    const prior = this.current
    this.current = null
    if (prior) await this.detach(prior)
    this.health = { ...this.health, state: 'held', reason: code }
    this.failures++
    this.nextAttempt =
      this.now() + Math.min(300000, this.intervalMs * 2 ** Math.min(this.failures - 1, 4))
  }
  /** @param {import('./admin-contracts.d.mts').SessionRecord} record */
  async renew(record) {
    if (!this.tokenEndpoint || !this.clientId || !record.value.refresh_token)
      throw reason('sign_in_required')
    await this.store.begin(record.hash)
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.value.refresh_token,
      client_id: this.clientId
    })
    if (record.value.client_secret) body.set('client_secret', record.value.client_secret)
    let response
    try {
      response = await this.fetcher(this.tokenEndpoint, {
        method: 'POST',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      })
    } catch {
      throw reason('refresh_uncertain')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if ([400, 401, 403].includes(response.status)) {
        await this.store.block()
        throw reason('sign_in_required')
      }
      throw reason('refresh_uncertain')
    }
    let bytes = 0,
      parts = []
    try {
      for await (const part of response.body ?? []) {
        bytes += part.length
        if (bytes > 32768) {
          await response.body?.cancel().catch(() => {})
          throw reason('refresh_uncertain')
        }
        parts.push(part)
      }
      const value = JSON.parse(Buffer.concat(parts).toString())
      if (
        !token(value.access_token) ||
        (value.refresh_token !== undefined && !token(value.refresh_token)) ||
        value.token_type?.toLowerCase() !== 'bearer' ||
        !Number.isSafeInteger(value.expires_in) ||
        value.expires_in < 1 ||
        value.expires_in > 366 * 86400
      )
        throw reason('refresh_uncertain')
      const next = {
        ...record.value,
        access_token: value.access_token,
        refresh_token: value.refresh_token ?? record.value.refresh_token,
        expires_at: this.now() + value.expires_in * 1000
      }
      await this.store.replace(record, next)
      await this.store.clear()
      return this.store.read()
    } catch (e) {
      throw errorProperty(e, 'sessionReason') ? e : reason('refresh_uncertain')
    }
  }
  async run() {
    try {
      let record = await this.store.read(),
        pending = await this.store.pending()
      this.hasRefresh = !!record.value.refresh_token
      if (pending) {
        if (pending.hash === record.hash) throw reason(pending.reason ?? 'refresh_uncertain')
        await this.store.clear()
      }
      this.health = { ...this.health, expiresAt: record.value.expires_at }
      if (record.value.expires_at !== null && record.value.expires_at <= this.now() + 60000) {
        this.health.state = 'renewing'
        record = await this.renew(record)
      }
      if (this.stopped) return
      const api = this.adapterFactory({
        origin: this.origin,
        space: this.space,
        token: record.value.access_token
      })
      const actor = await this.attach(api, { account: this.account })
      if (
        actor.account !== this.account ||
        actor.server !== this.origin ||
        actor.space !== this.space
      ) {
        await this.detach(api)
        throw reason('identity_changed')
      }
      const previous = this.current
      this.current = api
      if (previous && previous !== api) await this.detach(previous)
      this.failures = 0
      this.nextAttempt = this.now() + this.intervalMs
      this.health = {
        state: 'connected',
        expiresAt: record.value.expires_at,
        lastSuccess: this.now(),
        reason: null
      }
    } catch (e) {
      this.logger('session_failed', e)
      await this.hold(
        String(
          errorProperty(e, 'sessionReason') ??
            ([401, 403].includes(Number(errorProperty(e, 'status')))
              ? 'sign_in_required'
              : errorProperty(e, 'code') === 'ENOENT'
                ? 'credential_missing'
                : 'connection_unavailable')
        )
      )
    }
  }
  tick({ force = false } = {}) {
    if (this.stopped || this.active || (!force && this.now() < this.nextAttempt))
      return this.active ?? Promise.resolve()
    this.active = this.run().finally(() => {
      this.active = null
    })
    return this.active
  }
  async start() {
    await this.tick()
    if (!this.stopped) {
      this.timer = setInterval(() => {
        void this.tick()
      }, 1000)
      this.timer.unref()
    }
  }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    await this.active
    if (this.current) await this.detach(this.current)
    this.current = null
  }
}
