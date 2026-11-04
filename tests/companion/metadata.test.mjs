// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { suggestMetadata } from '../../src/domain/metadata.ts'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-meta-')),
    j = new ProposalJournal(join(dir, 'db.sqlite3')),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity(),
    m = new Metadata(w)
  m.saveSchema(actor, {
    fields: [
      { id: 'invoice', label: 'Invoice', type: 'text', aliases: ['Invoice number'], choices: [] }
    ],
    tags: []
  })
  const d = await m.get(actor, api, 'Inbox/english.pdf')
  return {
    j,
    w,
    api,
    actor,
    m,
    d,
    request: {
      path: d.source.path,
      resourceId: d.source.resourceId,
      etag: d.source.etag,
      sha256: d.source.sha256,
      version: 0,
      fields: { invoice: 'ABC-42' },
      addTags: ['Household']
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('custom fields follow canonical resource ID across filing and preserve existing tags', async () => {
  const s = await setup()
  try {
    await s.m.save(s.actor, s.api, s.request)
    assert.equal(s.m.read(s.actor, 'demo-english').fields.invoice, 'ABC-42')
    assert.deepEqual((await s.api.stat(s.request.path)).tags, ['Keep existing', 'Household'])
    await s.api.move(s.request.path, 'Filed/test.pdf', s.request.etag)
    const d = await s.m.get(s.actor, s.api, 'Filed/test.pdf')
    assert.equal(d.record.version, 1)
    assert.equal(d.record.fields.invoice, 'ABC-42')
    assert.equal(s.m.read({ ...s.actor, account: 'other' }, 'demo-english').version, 0)
  } finally {
    s.close()
  }
})
test('manual family tag library persists without automatic name matching and allows additive joint ownership', async () => {
  const s = await setup()
  try {
    const schema = {
      fields: [],
      tags: [
        { tag: 'Person: Alex', terms: [] },
        { tag: 'Person: Haruka', terms: [] }
      ]
    }
    s.m.saveSchema(s.actor, schema)
    assert.deepEqual(s.m.schema(s.actor), schema)
    await s.m.save(s.actor, s.api, {
      ...s.request,
      fields: {},
      addTags: ['Person: Alex', 'Person: Haruka']
    })
    assert.deepEqual((await s.api.stat(s.request.path)).tags, [
      'Keep existing',
      'Person: Alex',
      'Person: Haruka'
    ])
    assert.deepEqual((await s.m.get(s.actor, s.api, s.request.path)).suggestions.tags, [])
  } finally {
    s.close()
  }
})
test('persisted name aliases normalize scripts into one canonical person tag without partial Latin or single-kanji compound matches', async () => {
  const s = await setup()
  try {
    const schema = {
      fields: [],
      tags: [
        {
          tag: 'Person: Alex',
          terms: [
            'Alex',
            'Alexander',
            'AlexanderJames',
            'Alexander James',
            'アレックス',
            'アレクサンダー',
            'アレクサンダージェームズ',
            'あれっくす',
            'あれくさんだー',
            'あれくさんだーじぇーむず'
          ],
          match: 'name'
        },
        { tag: 'Person: Haruka', terms: ['Haruka', '葵', 'はるか', 'ハルカ'], match: 'name' },
        { tag: 'Person: Sora', terms: ['Sora', '空良', 'そら', 'ソラ'], match: 'name' }
      ]
    }
    s.m.saveSchema(s.actor, schema)
    const saved = s.m.schema(s.actor)
    for (const line of ['ALEXANDER JAMES', 'Ａｌｅｘ', 'ｱﾚｸｻﾝﾀﾞｰｼﾞｪｰﾑｽﾞ', 'あれっくす'])
      assert.deepEqual(
        suggestMetadata(saved, [line]).tags.map((t) => t.value),
        ['Person: Alex']
      )
    assert.deepEqual(suggestMetadata(saved, ['Alexanders bought 葵祭.']).tags, [])
    const line = '氏名：葵 / 空良'
    const tags = suggestMetadata(saved, [line]).tags
    assert.deepEqual(
      tags.map((t) => t.value),
      ['Person: Haruka', 'Person: Sora']
    )
    assert.equal(tags[0].evidence[0].quote, line)
    assert.equal(suggestMetadata(saved, ['Alex / Alexander / アレックス']).tags.length, 1)
  } finally {
    s.close()
  }
})
test('stale metadata or document cannot overwrite current values or add tags', async () => {
  const s = await setup()
  try {
    await s.m.save(s.actor, s.api, s.request)
    await assert.rejects(s.m.save(s.actor, s.api, s.request), /Metadata changed/)
    s.j.db.prepare('update demo_files set etag=? where path=?').run('"changed"', s.request.path)
    await assert.rejects(s.m.save(s.actor, s.api, { ...s.request, version: 1 }), /Document changed/)
    assert.equal(s.m.read(s.actor, 'demo-english').version, 1)
  } finally {
    s.close()
  }
})
test('lost committed tag response is read-only reconciled exactly once, including concurrent rechecks', async () => {
  const s = await setup()
  try {
    const add = s.api.addTags.bind(s.api)
    let calls = 0
    s.api.addTags = async (...a) => {
      calls++
      await add(...a)
      throw new Error('lost response')
    }
    await assert.rejects(s.m.save(s.actor, s.api, s.request))
    const d = await s.m.get(s.actor, s.api, s.request.path)
    assert.equal(d.pending.length, 1)
    await Promise.all([
      s.m.reconcile(s.actor, s.api, d.pending[0].id),
      s.m.reconcile(s.actor, s.api, d.pending[0].id)
    ])
    assert.equal(s.m.read(s.actor, 'demo-english').version, 1)
    assert.equal(calls, 1)
    assert.equal(s.w.history(s.actor).filter((e) => e.kind === 'metadata_saved').length, 1)
  } finally {
    s.close()
  }
})
test('unconfirmed tags block further metadata writes and are never resent', async () => {
  const s = await setup()
  try {
    let calls = 0
    s.api.addTags = async () => {
      calls++
      throw new Error('unknown outcome')
    }
    await assert.rejects(s.m.save(s.actor, s.api, s.request))
    const d = await s.m.get(s.actor, s.api, s.request.path)
    assert.equal((await s.m.reconcile(s.actor, s.api, d.pending[0].id)).uncertain, true)
    await assert.rejects(s.m.save(s.actor, s.api, s.request), /pending/)
    assert.equal(calls, 1)
    assert.equal(s.m.read(s.actor, 'demo-english').version, 0)
  } finally {
    s.close()
  }
})

test('connected tag rules and manual additions reuse existing capitalization without merging native tag variants', async () => {
  const s = await setup()
  try {
    const schema = await s.m.saveConnectedSchema(s.actor, s.api, {
      fields: [],
      tags: [{ tag: 'keep EXISTING', terms: ['test'] }]
    })
    assert.equal(schema.tags[0].tag, 'Keep existing')
    let additions = 0
    const add = s.api.addTags.bind(s.api)
    s.api.addTags = async (...args) => {
      additions++
      return add(...args)
    }
    await s.m.save(s.actor, s.api, { ...s.request, fields: {}, addTags: ['KEEP EXISTING'] })
    assert.equal(additions, 0)
    assert.deepEqual((await s.api.stat(s.request.path)).tags, ['Keep existing'])
    await assert.rejects(
      s.m.saveConnectedSchema(s.actor, s.api, {
        fields: [],
        tags: [
          { tag: 'New', terms: [] },
          { tag: 'new', terms: [] }
        ]
      }),
      /unique/
    )
  } finally {
    s.close()
  }
})
test('removing one document tag preserves other tags, saved fields and bytes, and verifies without replaying DELETE', async () => {
  const s = await setup()
  try {
    await s.m.save(s.actor, s.api, s.request)
    const d = await s.m.get(s.actor, s.api, s.request.path),
      remove = s.api.removeTags.bind(s.api)
    let calls = 0
    s.api.removeTags = async (...args) => {
      calls++
      return remove(...args)
    }
    const result = await s.m.removeTag(s.actor, s.api, {
      ...d.source,
      version: d.record.version,
      tag: 'Household'
    })
    assert.equal(result.state, 'done')
    assert.equal(calls, 1)
    const after = await s.m.get(s.actor, s.api, s.request.path)
    assert.deepEqual(after.source.tags, ['Keep existing'])
    assert.deepEqual(result.source, after.source)
    assert.equal(after.record.fields.invoice, 'ABC-42')
    assert.equal(after.source.sha256, d.source.sha256)
    assert.equal(after.record.version, 2)
    const id = s.j.db.prepare('select change_id from metadata_tag_removals').get().change_id
    await s.m.reconcile(s.actor, s.api, id)
    assert.equal(calls, 1)
    await assert.rejects(s.m.reconcile({ ...s.actor, account: 'other' }, s.api, id), /not found/)
  } finally {
    s.close()
  }
})
test('lost tag-removal responses reconcile committed outcomes; unknown outcomes never replay and block conflicting edits', async () => {
  const s = await setup()
  try {
    let calls = 0
    const remove = s.api.removeTags.bind(s.api)
    s.api.removeTags = async (...args) => {
      calls++
      await remove(...args)
      throw Error('response lost')
    }
    const result = await s.m.removeTag(s.actor, s.api, {
      ...s.d.source,
      version: 0,
      tag: 'Keep existing'
    })
    assert.equal(result.state, 'done')
    assert.equal(calls, 1)
    assert.deepEqual((await s.api.stat(s.request.path)).tags, [])
    await s.api.addTags('demo-english', ['Another'])
    const d = await s.m.get(s.actor, s.api, s.request.path)
    s.api.removeTags = async () => {
      calls++
      throw Error('unknown outcome')
    }
    await assert.rejects(
      s.m.removeTag(s.actor, s.api, { ...d.source, version: d.record.version, tag: 'Another' }),
      /unknown/
    )
    const held = await s.m.get(s.actor, s.api, s.request.path)
    assert.equal((await s.m.reconcile(s.actor, s.api, held.pending[0].id)).uncertain, true)
    await assert.rejects(
      s.m.save(s.actor, s.api, { ...s.request, version: d.record.version }),
      /pending/
    )
    assert.equal(calls, 2)
  } finally {
    s.close()
  }
})
test('changed source/version, absent tag and refused removal cannot delete another tag or change stored fields', async () => {
  const s = await setup()
  try {
    let calls = 0
    s.api.removeTags = async () => {
      calls++
      throw Object.assign(Error('refused'), { status: 403 })
    }
    for (const override of [
      { resourceId: 'other' },
      { etag: 'changed' },
      { sha256: '0'.repeat(64) },
      { version: 5 },
      { tag: 'Not attached' }
    ])
      await assert.rejects(
        s.m.removeTag(s.actor, s.api, {
          ...s.d.source,
          version: 0,
          tag: 'Keep existing',
          ...override
        })
      )
    assert.equal(calls, 0)
    await assert.rejects(
      s.m.removeTag(s.actor, s.api, { ...s.d.source, version: 0, tag: 'Keep existing' }),
      /refused/
    )
    assert.equal(calls, 1)
    assert.equal((await s.m.get(s.actor, s.api, s.request.path)).pending.length, 0)
    assert.deepEqual((await s.api.stat(s.request.path)).tags, ['Keep existing'])
    assert.equal(s.m.read(s.actor, 'demo-english').version, 0)
  } finally {
    s.close()
  }
})
