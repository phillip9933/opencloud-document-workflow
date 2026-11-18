// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { stoppedCheckpoint } from '../../companion/stopped-checkpoint.mjs'
import { composeUpgrade } from '../../deploy/installer/compose-upgrade.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-compose-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'document-workflow')
  await mkdir(app)
  await writeFile(join(app, 'manifest.json'), JSON.stringify({ version: '1.2.9' }))
  const database = join(root, 'workflow.sqlite3')
  const journal = new ProposalJournal(database)
  journal.close()
  return {
    apps: root,
    database,
    backups: join(root, 'backups'),
    stoppedCheckpoint,
    release: { appId: 'document-workflow', version: '1.2.10' }
  }
}

test('a newer Compose release verifies a checkpoint without changing the journal', async (t) => {
  const setup = await fixture(t)
  const before = await readFile(setup.database)
  assert.deepEqual(await composeUpgrade(setup), {
    state: 'checkpointed',
    from: '1.2.9',
    version: '1.2.10'
  })
  assert.ok((await readdir(setup.backups)).some((name) => name.startsWith('snapshot-')))
  assert.deepEqual(await readFile(setup.database), before)
})

test('same-version runs skip checkpointing, and downgrades and pending journals block deployment', async (t) => {
  const setup = await fixture(t)
  setup.release.version = '1.2.9'
  const { inventory } = await import('../../deploy/installer/web-assets.mjs')
  setup.release.files = await inventory(join(setup.apps, setup.release.appId))
  assert.equal((await composeUpgrade(setup)).state, 'unchanged')
  await assert.rejects(readdir(setup.backups), { code: 'ENOENT' })
  setup.release.version = '1.2.8'
  await assert.rejects(composeUpgrade(setup), /cannot downgrade/)
  setup.release.version = '1.2.10'
  await writeFile(setup.database + '-wal', 'pending data')
  await assert.rejects(composeUpgrade(setup), /pending journal/)
  await assert.rejects(readdir(setup.backups), { code: 'ENOENT' })
})

test('a changed web inventory still checkpoints an earlier build with the same version number', async (t) => {
  const setup = await fixture(t)
  setup.release = {
    appId: 'document-workflow',
    version: '1.2.9',
    files: { 'manifest.json': 'different' }
  }
  assert.equal((await composeUpgrade(setup)).state, 'checkpointed')
  assert.ok((await readdir(setup.backups)).some((name) => name.startsWith('snapshot-')))
})
