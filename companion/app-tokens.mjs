// SPDX-License-Identifier: AGPL-3.0-only
import { errorProperty } from './error-properties.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { logEvent } from './logging.mjs'
import { lstat, realpath, readdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { OpenCloudAdapter } from './opencloud.mjs'
/** @param {string} value */
const hash = (value) => createHash('sha256').update(value).digest('hex')
/** @param {unknown} value @param {number} max @returns {value is string} */
const valid = (value, max = 16384) =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value)
export class AppTokenSessions {
  /** @param {import('./admin-contracts.d.mts').AppTokenOptions} options */
  constructor({
    directory,
    origin,
    excludedDirectories = [],
    attach,
    detach,
    adapterFactory = (options) => new OpenCloudAdapter(options),
    now = () => Date.now(),
    logger = logEvent
  }) {
    this.directory = directory ? resolve(directory) : null
    this.origin = origin
    this.excludedDirectories = excludedDirectories.map((p) => resolve(p))
    this.attach = attach
    this.detach = detach
    this.adapterFactory = adapterFactory
    this.now = now
    this.logger = logger
    /** @type {Map<string,import('./admin-contracts.d.mts').AppTokenEntry>} */
    this.sessions = new Map()
    /** @type {Map<string,Promise<unknown>>} */
    this.operations = new Map()
    /** @type {Promise<void>|null} */
    this.active = null
    this.stopped = false
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  status(actor) {
    const current = this.sessions.get(actor.account)
    return {
      available: !!this.directory,
      method: 'app_token',
      configured: !!current,
      ...(current?.health ?? { state: 'not_configured' }),
      renewable: false
    }
  }
  async checkDirectory() {
    if (!this.directory)
      throw new WorkflowError(
        'DEPENDENCY_UNAVAILABLE',
        'Private background token storage is not configured'
      )
    const root = await realpath(this.directory),
      s = await lstat(this.directory)
    if (
      root !== this.directory ||
      !s.isDirectory() ||
      s.mode & 0o077 ||
      this.excludedDirectories.some((p) => root === p || root.startsWith(p + '/'))
    )
      throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Private token storage is unavailable')
  }
  /** @param {string} account */
  path(account) {
    if (!this.directory)
      throw new WorkflowError(
        'DEPENDENCY_UNAVAILABLE',
        'Private background token storage is not configured'
      )
    return join(this.directory, hash(account) + '.json')
  }
  /** @param {unknown} input @returns {import('./admin-contracts.d.mts').AppTokenRecord} */
  validate(input) {
    const value =
      input && typeof input === 'object' ? /** @type {Record<string,unknown>} */ (input) : {}
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'account,appToken,server,username,version' ||
      value.version !== 1 ||
      value.server !== this.origin ||
      !valid(value.account, 400) ||
      !valid(value.username, 400) ||
      value.username.includes(':') ||
      !valid(value.appToken)
    )
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid background app token')
    return {
      version: 1,
      server: this.origin,
      account: value.account,
      username: value.username,
      appToken: value.appToken
    }
  }
  /** @param {string} path */
  async read(path) {
    await this.checkDirectory()
    const handle = await open(path, 'r')
    try {
      const s = await handle.stat(),
        link = await lstat(path)
      if (
        link.isSymbolicLink() ||
        !s.isFile() ||
        s.size > 32768 ||
        s.mode & 0o077 ||
        (s.uid !== process.getuid?.() && s.uid !== 0)
      )
        throw new WorkflowError('OPERATION_HELD', 'Unsafe token file')
      return this.validate(JSON.parse(await handle.readFile('utf8')))
    } finally {
      await handle.close()
    }
  }
  /** @param {import('./admin-contracts.d.mts').AppTokenRecord} value @param {string} space */
  adapter(value, space) {
    return this.adapterFactory({
      origin: this.origin,
      space,
      username: value.username,
      appToken: value.appToken
    })
  }
  /** @template T @param {string} account @param {()=>Promise<T>} run */
  withAccount(account, run) {
    if (this.stopped)
      return Promise.reject(
        new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Background service is stopping')
      )
    const task = (this.operations.get(account) ?? Promise.resolve()).catch(() => {}).then(run)
    this.operations.set(account, task)
    void task
      .finally(() => {
        if (this.operations.get(account) === task) this.operations.delete(account)
      })
      .catch(() => {})
    return task
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {{username:string;appToken:string}} value */
  connect(actor, value) {
    return this.withAccount(actor.account, () => this.connectPrivate(actor, value))
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  disconnect(actor) {
    return this.withAccount(actor.account, () => this.disconnectPrivate(actor))
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {{username:string;appToken:string}} input */
  async connectPrivate(actor, { username, appToken }) {
    await this.checkDirectory()
    const value = this.validate({
        version: 1,
        server: this.origin,
        account: actor.account,
        username,
        appToken
      }),
      api = this.adapter(value, actor.space),
      identity = await api.identity()
    if (
      identity.server !== actor.server ||
      identity.account !== actor.account ||
      identity.space !== actor.space
    )
      throw new WorkflowError(
        'ACCESS_DENIED',
        'The app token belongs to a different OpenCloud account'
      )
    const path = this.path(actor.account),
      temp = path + '.pending-' + randomUUID(),
      f = await open(temp, 'wx', 0o600)
    try {
      await f.writeFile(JSON.stringify(value) + '\n')
      await f.sync()
      await f.close()
      if (this.stopped)
        throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Background service is stopping')
      await rename(temp, path)
      const dir = await open(resolve(path, '..'), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } finally {
      await f.close().catch(() => {})
      await unlink(temp).catch(() => {})
    }
    const previous = this.sessions.get(actor.account)
    if (previous?.api) await this.detach(previous.api)
    /** @type {import('./admin-contracts.d.mts').AppTokenEntry} */
    const entry = {
      value,
      space: actor.space,
      api: null,
      health: { state: 'connecting', lastSuccess: null },
      nextAttempt: 0
    }
    this.sessions.set(actor.account, entry)
    await this.run(entry)
    return this.status(actor)
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  async disconnectPrivate(actor) {
    await this.checkDirectory()
    const entry = this.sessions.get(actor.account)
    this.sessions.delete(actor.account)
    if (entry?.api) await this.detach(entry.api)
    await unlink(this.path(actor.account)).catch((e) => {
      if (errorProperty(e, 'code') !== 'ENOENT') throw e
    })
    const dir = await open(resolve(this.path(actor.account), '..'), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
    return this.status(actor)
  }
  /** @param {import('./admin-contracts.d.mts').AppTokenEntry} entry */
  async run(entry) {
    try {
      const api = this.adapter(entry.value, entry.space),
        identity = (await api.accountIdentity?.()) ?? (await api.identity())
      if (identity.account !== entry.value.account || identity.server !== this.origin)
        throw new WorkflowError('ACCESS_DENIED', 'Account changed')
      if (this.sessions.get(identity.account) !== entry || this.stopped) return
      await this.attach(api, { account: entry.value.account })
      if (this.sessions.get(identity.account) !== entry || this.stopped) {
        await this.detach(api)
        return
      }
      const prior = entry.api
      entry.api = api
      if (prior) await this.detach(prior)
      entry.health = { state: 'connected', lastSuccess: this.now() }
      entry.nextAttempt = this.now() + 30000
    } catch (error) {
      this.logger('app_token_failed', error)
      if (entry.api) await this.detach(entry.api)
      entry.api = null
      entry.health = { ...entry.health, state: 'held', reason: 'app_token_access_required' }
      entry.nextAttempt = this.now() + 30000
    }
  }
  async tick() {
    if (this.active || this.stopped) return
    this.active = (async () => {
      for (const entry of this.sessions.values())
        if (this.now() >= entry.nextAttempt) await this.run(entry)
    })().finally(() => {
      this.active = null
    })
    await this.active
  }
  async start(space = '__space_directory__') {
    if (!this.directory) return
    await this.checkDirectory()
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const value = await this.read(join(this.directory, name))
        if (name !== hash(value.account) + '.json') continue
        this.sessions.set(value.account, {
          value,
          space,
          api: null,
          health: { state: 'connecting', lastSuccess: null },
          nextAttempt: 0
        })
      } catch (error) {
        this.logger('app_token_failed', error)
        /* Record only allowlisted diagnostics, never the malformed credential. */
      }
    }
    await this.tick()
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref()
  }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    await this.active
    await Promise.allSettled([...this.operations.values()])
    for (const entry of this.sessions.values()) if (entry.api) await this.detach(entry.api)
  }
}
