// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, lstat, symlink, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { backup } from 'node:sqlite'
import { BackupManager, verifySnapshot, restoreSnapshot } from '../../companion/backups.mjs'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultPolicy, validateBundle, reviewDigest } from '../../src/domain/review.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-backup-')),
    database = join(directory, 'state.sqlite3'),
    backups = join(directory, 'backups'),
    journal = new ProposalJournal(database),
    workflow = new Workflow(journal),
    metadata = new Metadata(workflow),
    intake = new Intake(workflow),
    api = new DemoAdapter(journal.db)
  api.seed()
  const actor = await api.identity()
  intake.save(actor, { ...defaultIntake(), enabled: true }, api)
  return {
    directory,
    database,
    backups,
    journal,
    workflow,
    metadata,
    intake,
    api,
    actor,
    close: async () => {
      journal.close()
      await rm(directory, { recursive: true })
    }
  }
}

test('online snapshots include committed WAL data and verify hashes, integrity and private permissions', async () => {
  const f = await fixture(),
    manager = new BackupManager({ database: f.database, directory: f.backups })
  try {
    f.journal.db
      .prepare('insert into metadata values(?,?,?,?,?)')
      .run(
        f.workflow.scope(f.actor),
        'fixture-resource',
        7,
        '{"invoice_number":"WAL-42"}',
        new Date().toISOString()
      )
    const result = await manager.tick()
    assert.ok(result)
    assert.equal(manager.status().state, 'ready')
    assert.equal(result.counts.metadata, 1)
    assert.equal((await lstat(join(result.directory, 'database.sqlite3'))).mode & 0o077, 0)
    assert.equal((await lstat(result.directory)).mode & 0o077, 0)
    assert.equal((await verifySnapshot(result.directory)).sha256, result.sha256)
    assert.equal(
      (await readdir(result.directory)).some((n) => n.endsWith('-wal')),
      false
    )
    assert.equal(f.journal.db.prepare('select version from metadata').get().version, 7)
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('concurrent timers serialize and capacity holds retain every prior snapshot', async () => {
  const f = await fixture()
  let calls = 0,
    release,
    entered
  const started = new Promise((resolve) => {
      entered = resolve
    }),
    manager = new BackupManager({
      database: f.database,
      directory: f.backups,
      maxSnapshots: 1,
      copy: async (...args) => {
        calls++
        entered()
        await new Promise((resolve) => {
          release = resolve
        })
        return backup(...args)
      }
    })
  try {
    const first = manager.tick()
    await started
    const second = manager.tick({ force: true })
    release()
    const [one, two] = await Promise.all([first, second])
    assert.equal(one.directory, two.directory)
    assert.equal(calls, 1)
    const original = await readFile(join(one.directory, 'database.sqlite3'))
    assert.equal(await manager.tick({ force: true }), null)
    assert.equal(manager.status().reason, 'capacity_hold')
    assert.deepEqual(await readFile(join(one.directory, 'database.sqlite3')), original)
    assert.equal(calls, 1)
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('storage errors hold safely without inventing a successful backup or exposing a private error body', async () => {
  const f = await fixture(),
    manager = new BackupManager({
      database: f.database,
      directory: f.backups,
      copy: async () => {
        throw new Error('private-path-and-secret ENOSPC')
      }
    })
  try {
    assert.equal(await manager.tick(), null)
    assert.equal(manager.status().lastSuccess, null)
    assert.equal(manager.status().reason, 'backup_unavailable')
    assert.equal(JSON.stringify(manager.status()).includes('private-path'), false)
    assert.equal(
      f.journal.db.prepare('select count(*) n from demo_files where folder=0').get().n,
      3
    )
    assert.equal(
      (await readdir(f.backups)).some((n) => n.startsWith('snapshot-')),
      false
    )
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('corrupted snapshots and symlinked paths are refused before any restore target is created', async () => {
  const f = await fixture(),
    manager = new BackupManager({ database: f.database, directory: f.backups })
  try {
    const result = await manager.tick(),
      target = join(f.directory, 'restore', 'state.sqlite3')
    const file = join(result.directory, 'database.sqlite3')
    await writeFile(file, 'corrupt')
    await assert.rejects(restoreSnapshot(result.directory, target), /checksum_failed/)
    await assert.rejects(lstat(target), { code: 'ENOENT' })
    const alias = join(f.directory, 'alias')
    await symlink(result.directory, alias)
    await assert.rejects(verifySnapshot(alias), /private_directory_required/)
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('a restore drill preserves approval, fields and original bytes, pauses ingestion and never replays a completed filing', async () => {
  const f = await fixture(),
    manager = new BackupManager({ database: f.database, directory: f.backups })
  let restored
  try {
    const policy = defaultPolicy(),
      config = { endpoint: 'http://127.0.0.1:11434', model: 'fixture-model', policy },
      originalPrepare = f.journal.prepare.bind(f.journal)
    const claim = (value, quote = value) => ({ value, evidence: [{ page: 1, quote }] })
    f.journal.prepare = (input, c, o) =>
      originalPrepare(input, c, {
        ...o,
        planner: async (i) =>
          validateBundle({
            ...i,
            proposal: {
              issuer: claim('Example Electricity Company'),
              date: claim('2026-10-29'),
              kind: claim('Electricity invoice'),
              folder: claim('Utilities/Electricity', 'Electricity invoice'),
              tags: []
            }
          })
      })
    const prepared = await f.workflow.prepare(f.actor, f.api, 'Inbox/english.pdf', config),
      review = validateBundle(prepared.bundle),
      manual = { target: 'Filed/Restore/verified.pdf', addTags: ['Restore fixture'] }
    f.metadata.saveSchema(f.actor, {
      fields: [
        {
          id: 'invoice_number',
          label: 'Invoice number',
          type: 'text',
          aliases: ['Invoice number'],
          choices: []
        }
      ],
      tags: []
    })
    const detail = await f.metadata.get(f.actor, f.api, 'Inbox/english.pdf')
    await f.metadata.save(f.actor, f.api, {
      path: detail.source.path,
      resourceId: detail.source.resourceId,
      etag: detail.source.etag,
      sha256: detail.source.sha256,
      version: 0,
      fields: { invoice_number: 'SYN-EN-20261029' },
      addTags: []
    })
    await f.workflow.approve(
      f.actor,
      f.api,
      prepared.id,
      policy,
      await reviewDigest(review, policy, manual),
      manual
    )
    await f.workflow.apply(f.actor, f.api, prepared.id)
    f.journal.db
      .prepare('insert into workflow_locks values(?,?,?,?)')
      .run('stale-fixture', 'owner', process.pid, 'fixture-host')
    const before = f.workflow.decision(f.actor, prepared.id),
      snapshot = await manager.tick(),
      target = join(f.directory, 'isolated-restore', 'state.sqlite3'),
      receipt = await restoreSnapshot(snapshot.directory, target)
    assert.equal(receipt.ingestionPaused, true)
    assert.equal(receipt.networkRequests, 0)
    assert.equal(
      receipt.restoredSHA256,
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
    )
    await assert.rejects(restoreSnapshot(snapshot.directory, target), /restore_target_exists/)
    restored = new ProposalJournal(target)
    const w = new Workflow(restored),
      api = new DemoAdapter(restored.db),
      intake = new Intake(w),
      metadata = new Metadata(w)
    assert.deepEqual(w.decision(f.actor, prepared.id), before)
    assert.equal(intake.configuration(f.actor).enabled, false)
    assert.equal(f.intake.configuration(f.actor).enabled, true)
    assert.equal(restored.db.prepare('select count(*) n from workflow_locks').get().n, 0)
    assert.equal(f.journal.db.prepare('select count(*) n from workflow_locks').get().n, 1)
    assert.equal(
      metadata.read(f.actor, detail.source.resourceId).fields.invoice_number,
      'SYN-EN-20261029'
    )
    let writes = 0
    api.move = api.addTags = async () => {
      writes++
      throw new Error('must not replay')
    }
    const checked = await w.apply(f.actor, api, prepared.id, { reconcileOnly: true })
    assert.equal(checked.state, 'done')
    assert.equal(checked.verification.sha256, review.bundle.source.sha256)
    assert.equal(writes, 0)
    assert.equal(
      w.history(f.actor).filter((e) => e.job === prepared.id && e.kind === 'done').length,
      1
    )
  } finally {
    restored?.close()
    await manager.stop()
    await f.close()
  }
})

test('scheduled backups respect the saved interval across manager restart', async () => {
  const f = await fixture()
  let now = 1000000,
    manager = new BackupManager({
      database: f.database,
      directory: f.backups,
      now: () => now,
      intervalMs: 60000
    })
  try {
    assert.ok(await manager.tick())
    await manager.stop()
    manager = new BackupManager({
      database: f.database,
      directory: f.backups,
      now: () => now,
      intervalMs: 60000
    })
    assert.equal(await manager.tick(), null)
    now += 60000
    assert.ok(await manager.tick())
    assert.equal((await readdir(f.backups)).filter((n) => n.startsWith('snapshot-')).length, 2)
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('backup controls persist across restart, pause without deleting copies, and reject invalid limits', async () => {
  const f = await fixture()
  let now = 1000000,
    manager = new BackupManager({ database: f.database, directory: f.backups, now: () => now })
  try {
    await manager.configure({ enabled: false, intervalMinutes: 30, maxSnapshots: 7, maxMiB: 5 })
    assert.equal(await manager.tick({ force: true }), null)
    assert.equal(manager.status().state, 'disabled')
    await manager.stop()
    manager = new BackupManager({ database: f.database, directory: f.backups, now: () => now })
    await manager.tick()
    assert.equal(manager.status().state, 'disabled')
    assert.equal(manager.settings().maxSnapshots, 7)
    await manager.configure({ enabled: true, intervalMinutes: 30, maxSnapshots: 7, maxMiB: 5 })
    assert.ok(await manager.tick())
    now += 29 * 60000
    assert.equal(await manager.tick(), null)
    now += 60000
    assert.ok(await manager.tick())
    assert.equal((await manager.report()).storage.count, 2)
    for (const patch of [
      { intervalMinutes: 0 },
      { maxSnapshots: 0 },
      { maxMiB: 0 },
      { enabled: 'yes' },
      { extra: true }
    ])
      assert.throws(() => manager.configure({ ...manager.settings(), ...patch }), /Invalid/)
    await manager.configure({ ...manager.settings(), enabled: false })
    assert.equal((await readdir(f.backups)).filter((n) => n.startsWith('snapshot-')).length, 2)
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('disabling backups waits for the current snapshot and prevents every subsequent timer', async () => {
  const f = await fixture()
  let release, entered
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r)),
    manager = new BackupManager({
      database: f.database,
      directory: f.backups,
      copy: async (...args) => {
        entered()
        await gate
        return backup(...args)
      }
    })
  try {
    const run = manager.tick()
    await started
    const change = manager.configure({ ...manager.settings(), enabled: false })
    release()
    assert.ok(await run)
    await change
    assert.equal(await manager.tick({ force: true }), null)
    assert.equal((await manager.report()).storage.count, 1)
  } finally {
    release()
    await manager.stop()
    await f.close()
  }
})

async function remoteFixture() {
  const f = await fixture(),
    target = f.api.forSpace('local-archive')
  await target.mkdir('Backups')
  await target.mkdir('Backups/Document Workflow')
  const destination = {
      server: f.actor.server,
      account: f.actor.account,
      space: 'local-archive',
      folder: 'Backups/Document Workflow'
    },
    manager = new BackupManager({ database: f.database, directory: f.backups })
  manager.attach(f.actor, f.api)
  await manager.configure({ ...manager.settings(), destination })
  return { ...f, manager, target, destination }
}
test('OpenCloud backups verify uploaded bytes and manifest, report usage, and restore without any app token', async () => {
  const f = await remoteFixture()
  try {
    const result = await f.manager.tick()
    assert.equal(result.storage, 'opencloud')
    const files = await f.target.list(f.destination.folder)
    assert.equal(files.length, 2)
    assert.equal((await f.manager.report()).storage.count, 1)
    assert.equal(
      (await readdir(f.backups)).some((n) => n.startsWith('.pending-snapshot-')),
      false
    )
    const local = join(f.directory, 'downloaded')
    await mkdir(local, { mode: 0o700 })
    for (const file of files)
      await writeFile(
        join(local, file.path.endsWith('.json') ? 'manifest.json' : file.path.split('/').at(-1)),
        await f.target.get(file.path),
        { mode: 0o600 }
      )
    assert.equal((await verifySnapshot(local)).sha256, result.sha256)
    const receipt = await restoreSnapshot(local, join(f.directory, 'restore', 'state.sqlite3'))
    assert.equal(receipt.ingestionPaused, true)
    assert.equal(receipt.networkRequests, 0)
    await f.manager.stop()
    const restarted = new BackupManager({ database: f.database, directory: f.backups })
    try {
      assert.equal(await restarted.tick({ force: true }), null)
      assert.equal(restarted.status().reason, 'backup_access_required')
      restarted.attach(f.actor, f.api)
      assert.ok(await restarted.tick())
    } finally {
      await restarted.stop()
    }
  } finally {
    await f.manager.stop()
    await f.close()
  }
})

test('lost backup upload responses verify remotely without repeating a PUT; missing outcomes hold across restart', async () => {
  for (const committed of [true, false]) {
    const f = await remoteFixture()
    let calls = 0
    const put = f.target.put.bind(f.target)
    f.api.forSpace = () => f.target
    f.target.put = async (...args) => {
      calls++
      if (committed) await put(...args)
      throw Error('lost response')
    }
    try {
      const first = await f.manager.tick()
      if (committed) {
        assert.ok(first)
        assert.equal(calls, 2)
      } else {
        assert.equal(first, null)
        assert.equal(f.manager.status().reason, 'backup_upload_held')
        assert.equal(calls, 1)
        await f.manager.stop()
        const restarted = new BackupManager({ database: f.database, directory: f.backups })
        restarted.attach(f.actor, f.api)
        try {
          assert.equal(await restarted.tick({ force: true }), null)
          assert.equal(calls, 1)
          assert.equal(
            (await readdir(f.backups)).filter((n) => n.startsWith('.pending-snapshot-')).length,
            1
          )
          await assert.rejects(
            restarted.configure({
              ...f.manager.settings(),
              destination: { ...f.destination, folder: 'Other' }
            }),
            /pending/
          )
        } finally {
          await restarted.stop()
        }
      }
    } finally {
      await f.manager.stop()
      await f.close()
    }
  }
})

test('remote backup limits retain prior copies and wrong accounts cannot publish', async () => {
  const f = await remoteFixture()
  try {
    await f.manager.configure({ ...f.manager.settings(), maxSnapshots: 1 })
    assert.ok(await f.manager.tick())
    assert.equal(await f.manager.tick({ force: true }), null)
    assert.equal(f.manager.status().reason, 'capacity_hold')
    assert.equal((await f.target.list(f.destination.folder)).length, 2)
    f.manager.sessions.clear()
    f.manager.attach({ ...f.actor, account: 'someone-else' }, f.api)
    assert.equal(await f.manager.tick({ force: true }), null)
    assert.equal(f.manager.status().reason, 'backup_access_required')
    assert.equal((await f.target.list(f.destination.folder)).length, 2)
  } finally {
    await f.manager.stop()
    await f.close()
  }
})

test('backup folder setup pins the signed-in owner, validates before folder writes, and can disable after access is revoked', async () => {
  const f = await fixture(),
    manager = new BackupManager({ database: f.database, directory: f.backups })
  let folders = 0
  const target = f.api.forSpace('local-archive'),
    mkdir = target.mkdir.bind(target)
  target.mkdir = async (...args) => {
    folders++
    return mkdir(...args)
  }
  f.api.forSpace = () => target
  try {
    const input = {
      ...manager.settings(),
      destination: {
        server: 'https://forged.example',
        account: 'forged',
        space: 'local-archive',
        folder: 'Backups/Document Workflow'
      }
    }
    await manager.configureFor(f.actor, f.api, input)
    assert.equal(manager.settings().destination.account, f.actor.account)
    assert.equal(manager.settings().destination.server, f.actor.server)
    assert.equal(folders, 2)
    await assert.rejects(
      manager.configureFor(f.actor, f.api, { ...input, maxSnapshots: 0 }),
      /Invalid/
    )
    assert.equal(folders, 2)
    target.identity = async () => {
      throw Error('revoked')
    }
    await assert.rejects(manager.configureFor(f.actor, f.api, input), /revoked/)
    await manager.configureFor(f.actor, f.api, {
      enabled: false,
      intervalMinutes: 30,
      maxSnapshots: 8,
      maxMiB: 4
    })
    assert.equal(manager.settings().enabled, false)
    assert.equal(manager.settings().destination.folder, 'Backups/Document Workflow')
  } finally {
    await manager.stop()
    await f.close()
  }
})

test('revoking the destination owner administrator role holds instance-wide backups before any file upload', async () => {
  const f = await remoteFixture()
  f.api.forSpace = () => f.target
  f.target.isAdministrator = async () => false
  try {
    assert.equal(await f.manager.tick({ force: true }), null)
    assert.equal(f.manager.status().reason, 'backup_access_required')
    assert.equal((await f.target.list(f.destination.folder)).length, 0)
    f.target.isAdministrator = async () => true
    assert.ok(await f.manager.tick({ force: true }))
    assert.equal((await f.target.list(f.destination.folder)).length, 2)
  } finally {
    await f.manager.stop()
    await f.close()
  }
})
test('backup sessions prefer the verified background adapter across browser polling and credential rotation', async () => {
  const f = await fixture(),
    manager = new BackupManager({ database: f.database, directory: f.backups }),
    actor = { server: 'https://fixture.test', account: 'owner' },
    key = JSON.stringify([actor.server, actor.account]),
    token = {},
    renewed = {},
    browser = {}
  try {
    manager.attach(actor, token, { background: true })
    manager.attach(actor, browser)
    assert.equal(manager.sessions.get(key), token)
    manager.attach(actor, renewed, { background: true })
    manager.detach(token)
    assert.equal(manager.sessions.get(key), renewed)
    manager.detach(renewed)
    assert.equal(manager.sessions.has(key), false)
    assert.equal(manager.backgroundSessions.has(key), false)
  } finally {
    await manager.stop()
    await f.close()
  }
})
