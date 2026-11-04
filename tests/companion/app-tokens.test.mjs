// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppTokenSessions } from '../../companion/app-tokens.mjs'
import { OpenCloudAdapter } from '../../companion/opencloud.mjs'
const actor = { server: 'https://opencloud.example', account: 'person', space: 'space' }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-app-token-')),
    privateDir = join(dir, 'credentials')
  mkdirSync(privateDir, { mode: 0o700 })
  let attached = [],
    detached = [],
    valid = true,
    now = 1000
  const options = {
    directory: privateDir,
    origin: actor.server,
    attach: async (api) => {
      attached.push(api)
      return actor
    },
    detach: async (api) => {
      detached.push(api)
    },
    now: () => now,
    adapterFactory: (options) => ({
      ...options,
      identity: async () => {
        if (!valid) throw Error('revoked fixture-secret')
        return actor
      }
    })
  }
  return {
    dir,
    privateDir,
    options,
    get attached() {
      return attached
    },
    get detached() {
      return detached
    },
    advance() {
      now += 31000
    },
    revoke() {
      valid = false
    },
    close() {
      rmSync(dir, { recursive: true })
    }
  }
}
test('OpenCloud app tokens use Basic only against configured endpoints and remain transient in scoped adapters', async () => {
  const calls = [],
    api = new OpenCloudAdapter({
      origin: actor.server,
      space: actor.space,
      username: 'fixture-account',
      appToken: 'fixture app token',
      fetcher: async (url, options) => {
        calls.push({ url, ...options })
        return Response.json({ id: actor.account })
      }
    })
  await api.accountIdentity()
  await api.forSpace('another').accountIdentity()
  assert.equal(
    calls[0].headers.Authorization,
    'Basic ' + Buffer.from('fixture-account:fixture app token').toString('base64')
  )
  assert.equal(calls[1].headers.Authorization, calls[0].headers.Authorization)
  assert.equal(calls[0].redirect, 'error')
  await assert.rejects(api.request('GET', 'https://foreign.example/graph/v1.0/me'), /outside/)
})
test('app token persists only in a private file and reconnects without a browser or OAuth provider', async () => {
  const s = setup(),
    manager = new AppTokenSessions(s.options)
  try {
    const result = await manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    assert.equal(result.state, 'connected')
    assert.equal(result.method, 'app_token')
    assert.equal(result.renewable, false)
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false)
    const path = join(s.privateDir, readdirSync(s.privateDir)[0])
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(path)).appToken, 'fixture-secret')
    await manager.stop()
    const next = new AppTokenSessions(s.options)
    try {
      await next.start('space')
      assert.equal(next.status(actor).state, 'connected')
      assert.equal(s.attached.length, 2)
    } finally {
      await next.stop()
    }
  } finally {
    await manager.stop()
    s.close()
  }
})
test('revocation detaches only the managed adapter and visibly holds background work', async () => {
  const s = setup(),
    manager = new AppTokenSessions(s.options)
  try {
    await manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    s.revoke()
    s.advance()
    await manager.tick()
    assert.equal(manager.status(actor).state, 'held')
    assert.equal(s.detached.length, 1)
    assert.equal(JSON.stringify(manager.status(actor)).includes('fixture-secret'), false)
  } finally {
    await manager.stop()
    s.close()
  }
})
test('wrong account, unsafe private storage and missing directories never save a credential', async () => {
  const s = setup()
  try {
    const other = new AppTokenSessions({
      ...s.options,
      adapterFactory: () => ({ identity: async () => ({ ...actor, account: 'other' }) })
    })
    await assert.rejects(
      other.connect(actor, { username: 'other', appToken: 'fixture-secret' }),
      /different/
    )
    assert.equal(readdirSync(s.privateDir).length, 0)
    const nested = new AppTokenSessions({ ...s.options, excludedDirectories: [s.dir] })
    await assert.rejects(
      nested.connect(actor, { username: 'person', appToken: 'fixture-secret' }),
      /unavailable/
    )
    assert.equal(s.attached.length, 0)
  } finally {
    s.close()
  }
})
test('disconnect removes only the current account credential and does not revoke or create an OpenCloud token', async () => {
  const s = setup(),
    manager = new AppTokenSessions(s.options)
  try {
    await manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    const other = { ...actor, account: 'other' },
      mismatched = new AppTokenSessions({
        ...s.options,
        adapterFactory: (o) => ({ ...o, identity: async () => other })
      })
    try {
      await mismatched.connect(other, { username: 'other', appToken: 'other-fixture-secret' })
      assert.equal(readdirSync(s.privateDir).length, 2)
      await manager.disconnect(actor)
      assert.equal(readdirSync(s.privateDir).length, 1)
      assert.equal(manager.status(actor).configured, false)
      assert.equal(s.detached.length, 1)
    } finally {
      await mismatched.stop()
    }
  } finally {
    await manager.stop()
    s.close()
  }
})
test('unsafe symlinked credential files do not attach on restart', async () => {
  const s = setup(),
    manager = new AppTokenSessions(s.options)
  try {
    await manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    await manager.stop()
    const file = join(s.privateDir, readdirSync(s.privateDir)[0]),
      outside = join(s.dir, 'outside')
    ;(await import('node:fs')).renameSync(file, outside)
    symlinkSync(outside, file)
    const next = new AppTokenSessions(s.options)
    try {
      await next.start('space')
      assert.equal(next.status(actor).configured, false)
      assert.equal(s.attached.length, 1)
    } finally {
      await next.stop()
    }
  } finally {
    await manager.stop()
    s.close()
  }
})

test('disconnect waits for an in-flight connection and leaves no credential or attached adapter', async () => {
  const s = setup()
  let entered, release
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r)),
    manager = new AppTokenSessions({
      ...s.options,
      adapterFactory: (options) => ({
        ...options,
        identity: async () => {
          entered()
          await gate
          return actor
        }
      })
    })
  try {
    const connecting = manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    await started
    const disconnecting = manager.disconnect(actor)
    release()
    await connecting
    await disconnecting
    assert.equal(manager.status(actor).configured, false)
    assert.equal(readdirSync(s.privateDir).length, 0)
    assert.equal(s.attached.length, 1)
    assert.equal(s.detached.length, 1)
  } finally {
    release()
    await manager.stop()
    s.close()
  }
})

test('a restart without an operator default Space uses account discovery rather than an invalid adapter', async () => {
  const s = setup(),
    manager = new AppTokenSessions(s.options)
  try {
    await manager.connect(actor, { username: 'person', appToken: 'fixture-secret' })
    await manager.stop()
    const next = new AppTokenSessions(s.options)
    try {
      await next.start()
      assert.equal(next.status(actor).state, 'connected')
      assert.equal(s.attached.at(-1).space, '__space_directory__')
    } finally {
      await next.stop()
    }
  } finally {
    await manager.stop()
    s.close()
  }
})
