// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { Duplicates } from '../../companion/duplicates.mjs'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-duplicates-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity()
  let now = 1000000,
    calls = 0,
    deletes = 0
  const intake = new Intake(w, {
      now: () => now,
      prepare: async (actor, api, path) => {
        calls++
        const source = {
            ...(await api.stat(path)),
            ...actor,
            sha256: createHash('sha256')
              .update(await api.get(path))
              .digest('hex')
          },
          id = 'job-' + source.resourceId
        j.db
          .prepare(
            'insert into proposals(id,scope,input,configuration,state,attempts,updated,result) values(?,?,?,?,?,?,?,?)'
          )
          .run(
            id,
            w.scope(actor),
            JSON.stringify({ source }),
            '{}',
            'needs_review',
            1,
            new Date().toISOString(),
            '{}'
          )
        return { id }
      }
    }),
    duplicates = new Duplicates(w, intake)
  intake.resume = (a, api) => duplicates.resume(a, api)
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  const realTrash = api.trash.bind(api)
  api.trash = async (...args) => {
    deletes++
    return realTrash(...args)
  }
  const s = {
    dir,
    path,
    j,
    w,
    api,
    actor,
    intake,
    duplicates,
    get calls() {
      return calls
    },
    get deletes() {
      return deletes
    },
    async cycle() {
      await intake.tick({ force: true })
      now += 3000
      await intake.tick({ force: true })
    },
    copy(data) {
      const bytes =
        data ??
        j.db.prepare("select data from demo_files where resourceId='demo-english'").get().data
      j.db
        .prepare('insert into demo_files values(?,?,?,?,?,?)')
        .run('Inbox/extra.pdf', 'extra-copy', '"v1"', '[]', 0, bytes)
    },
    item() {
      return intake.status(actor).queue.find((row) => row.resource === 'extra-copy')
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
  await s.cycle()
  s.copy()
  await s.cycle()
  return s
}
test('exact duplicates stay held until explicitly authorized; Trash preserves bytes, original and recoverability', async () => {
  const s = await setup()
  try {
    assert.equal(s.item().state, 'duplicate')
    assert.equal(s.deletes, 0)
    assert.equal(s.duplicates.action(s.actor), 'keep')
    s.duplicates.save(s.actor, 'trash', 'Inbox')
    await s.intake.tick({ force: true })
    assert.equal(s.item().state, 'trashed')
    assert.equal(s.deletes, 1)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
    assert.equal(await s.api.stat('Inbox/extra.pdf'), null)
    const [entry] = await s.api.listTrash()
    assert.equal(entry.resourceId, 'extra-copy')
    assert.equal(entry.path, 'Inbox/extra.pdf')
    assert.deepEqual(
      Buffer.from(s.j.db.prepare("select data from demo_trash where id='extra-copy'").get().data),
      await s.api.get('Inbox/english.pdf')
    )
    assert.equal(s.w.history(s.actor).filter((e) => e.kind === 'duplicate_trash_intent').length, 1)
    // Simulate recovery by OpenCloud: this saved intent must never delete it again.
    const restored = s.j.db.prepare("select * from demo_trash where id='extra-copy'").get()
    s.j.db
      .prepare('insert into demo_files values(?,?,?,?,?,?)')
      .run(restored.path, restored.resourceId, restored.etag, restored.tags, 0, restored.data)
    await s.intake.tick({ force: true })
    assert.ok(await s.api.stat(restored.path))
    assert.equal(s.deletes, 1)
    assert.equal(s.item().state, 'restored')
  } finally {
    s.close()
  }
})
test('a new scan or changed date, amount, invoice number or account is never an exact duplicate', async () => {
  for (const changed of [
    'scan metadata differs',
    'date 2026-11-01',
    'amount 123.46',
    'invoice INV-002',
    'account 002'
  ]) {
    const s = await setup()
    try {
      s.j.db.prepare("delete from intake_queue where resource='extra-copy'").run()
      s.j.db
        .prepare("update demo_files set data=? where resourceId='extra-copy'")
        .run(Buffer.from('%PDF-1.4\nRecurring bill, same layout; ' + changed))
      s.duplicates.save(s.actor, 'trash', 'Inbox')
      await s.cycle()
      assert.equal(s.item().state, 'prepared')
      assert.equal(s.deletes, 0)
      assert.ok(await s.api.stat('Inbox/extra.pdf'))
    } finally {
      s.close()
    }
  }
})
test('missing, changed or ambiguous kept originals hold the extra copy without DELETE', async () => {
  for (const mutation of ['missing', 'bytes', 'etag', 'folder']) {
    const s = await setup()
    try {
      if (mutation === 'missing')
        s.j.db.prepare("delete from demo_files where resourceId='demo-english'").run()
      if (mutation === 'bytes')
        s.j.db
          .prepare("update demo_files set data=? where resourceId='demo-english'")
          .run(Buffer.from('different monthly bill'))
      if (mutation === 'folder')
        s.j.db.prepare("update demo_files set folder=1 where resourceId='demo-english'").run()
      if (mutation === 'etag') {
        const get = s.api.get.bind(s.api)
        s.api.get = async (path, ...args) => {
          const bytes = await get(path, ...args)
          if (path === 'Inbox/english.pdf')
            s.j.db
              .prepare("update demo_files set etag='changed' where resourceId='demo-english'")
              .run()
          return bytes
        }
      }
      const result = await s.duplicates.process(s.actor, s.api, s.item().id)
      assert.equal(result.state, 'duplicate')
      assert.equal(s.deletes, 0)
      assert.ok(await s.api.stat('Inbox/extra.pdf'))
    } finally {
      s.close()
    }
  }
})
test('a moved and verified original can be kept while the extra copy goes to Trash', async () => {
  const s = await setup()
  try {
    const item = s.item()
    await s.api.move('Inbox/english.pdf', 'Filed/kept.pdf', '"v1"')
    s.j.db
      .prepare('insert into decisions(job,actor,state,record,updated) values(?,?,?,?,?)')
      .run(
        item.job,
        s.actor.account,
        'done',
        JSON.stringify({ actions: { target: 'Filed/kept.pdf' } }),
        new Date().toISOString()
      )
    assert.equal((await s.duplicates.process(s.actor, s.api, item.id)).state, 'trashed')
    assert.ok(await s.api.stat('Filed/kept.pdf'))
    assert.equal(s.deletes, 1)
  } finally {
    s.close()
  }
})
test('lost Trash response is reconciled by identity without a second DELETE', async () => {
  const s = await setup()
  try {
    const trash = s.api.trash.bind(s.api)
    s.api.trash = async (...args) => {
      await trash(...args)
      throw new Error('connection lost')
    }
    const result = await s.duplicates.process(s.actor, s.api, s.item().id)
    assert.equal(result.state, 'trashed')
    await s.duplicates.process(s.actor, s.api, s.item().id)
    assert.equal(s.deletes, 1)
  } finally {
    s.close()
  }
})
test('uncertain Trash remains read-only after retry and journal restart, including a restored source', async () => {
  const s = await setup()
  try {
    s.api.trash = async () => {
      throw new Error('unknown outcome')
    }
    assert.equal((await s.duplicates.process(s.actor, s.api, s.item().id)).uncertain, true)
    let mutations = 0
    s.api.trash = async () => {
      mutations++
    }
    await s.duplicates.process(s.actor, s.api, s.item().id)
    const j = new ProposalJournal(s.path),
      w = new Workflow(j),
      intake = new Intake(w),
      duplicates = new Duplicates(w, intake)
    try {
      const result = await duplicates.process(s.actor, s.api, s.item().id)
      assert.equal(result.uncertain, true)
      assert.equal(mutations, 0)
      assert.ok(await s.api.stat('Inbox/extra.pdf'))
    } finally {
      j.close()
    }
  } finally {
    s.close()
  }
})
test('Trash must be readable before mutation; pausing or changing the inbox during verification prevents DELETE', async () => {
  for (const mutation of ['unreadable', 'paused', 'folder']) {
    const s = await setup()
    try {
      s.duplicates.save(s.actor, 'trash', 'Inbox')
      const list = s.api.listTrash.bind(s.api)
      s.api.listTrash = async () => {
        if (mutation === 'unreadable') throw new Error('no access')
        if (mutation === 'paused')
          s.intake.save(s.actor, { ...s.intake.configuration(s.actor), enabled: false }, s.api)
        if (mutation === 'folder')
          s.intake.save(s.actor, { ...s.intake.configuration(s.actor), folder: 'Other' }, s.api)
        return list()
      }
      assert.equal(
        (await s.duplicates.process(s.actor, s.api, s.item().id, { automatic: true })).state,
        'duplicate'
      )
      assert.equal(s.deletes, 0)
    } finally {
      s.close()
    }
  }
})
test('duplicate actions and authorization are isolated by account, Space and inbox folder', async () => {
  const s = await setup()
  try {
    s.duplicates.save(s.actor, 'trash', 'Inbox')
    for (const actor of [
      { ...s.actor, account: 'other' },
      { ...s.actor, space: 'local-archive' }
    ]) {
      assert.equal(s.duplicates.action(actor), 'keep')
      await assert.rejects(s.duplicates.process(actor, s.api, s.item().id), /not found/)
    }
    s.intake.save(s.actor, { ...s.intake.configuration(s.actor), folder: 'NewInbox' }, s.api)
    assert.equal(s.duplicates.action(s.actor), 'keep')
    assert.equal((await s.duplicates.process(s.actor, s.api, s.item().id)).state, 'duplicate')
    assert.equal(s.deletes, 0)
  } finally {
    s.close()
  }
})

test('non-Error duplicate verification failures retain both copies and release all locks', async () => {
  const s = await setup()
  try {
    const item = s.item()
    s.api.listTrash = async () => {
      throw null
    }
    const result = await s.duplicates.process(s.actor, s.api, item.id)
    assert.equal(result.state, 'duplicate')
    assert.equal(result.uncertain, false)
    assert.equal(s.deletes, 0)
    assert.ok(await s.api.stat('Inbox/extra.pdf'))
    for (const key of [
      'duplicate:' + s.w.scope(s.actor) + ':' + item.id,
      'resource:' + s.w.scope(s.actor) + ':extra-copy'
    ]) {
      const release = s.w.lock(key)
      release()
    }
  } finally {
    s.close()
  }
})
