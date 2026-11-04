// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Conversions } from '../../companion/conversions.mjs'
const actor = { server: 'https://example.org', account: 'owner', space: 'one' },
  pdf = Buffer.from('%PDF-1.7 synthetic conversion fixture')
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-convert-test-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j)
  w.intake = { configuration: () => ({ folder: 'Inbox' }) }
  const files = new Map([
    [
      'Inbox/sub/photo.jpg',
      {
        resourceId: 'source',
        etag: '"v1"',
        folder: false,
        tags: ['Family'],
        bytes: Buffer.from('synthetic image input')
      }
    ]
  ])
  let moves = 0,
    puts = 0
  const api = {
    identity: async () => actor,
    stat: async (path) => {
      const file = files.get(path)
      return file ? { ...file, path } : null
    },
    get: async (path) => files.get(path).bytes,
    mkdir: async () => {},
    put: async (path, bytes) => {
      puts++
      assert.ok(!files.has(path))
      const resourceId = puts === 1 ? 'pdf' : 'copy-' + puts
      files.set(path, { resourceId, etag: '"p1"', folder: false, tags: [], bytes })
      return { resourceId }
    },
    addTags: async (id, tags) => {
      for (const file of files.values()) if (file.resourceId === id) file.tags.push(...tags)
    },
    move: async (source, target, etag) => {
      moves++
      assert.equal(files.get(source).etag, etag)
      assert.ok(!files.has(target))
      files.set(target, files.get(source))
      files.delete(source)
    }
  }
  const service = new Conversions(w, { render: async () => pdf })
  service.wait = async () => {}
  const input = { path: 'Inbox/sub/photo.jpg', resourceId: 'source', etag: '"v1"' }
  return {
    j,
    w,
    files,
    api,
    service,
    input,
    counts: () => ({ moves, puts }),
    close: () => {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('conversion verifies PDF and preserves original identity, bytes, tags and relative path in archive', async () => {
  const f = fixture()
  try {
    const result = await f.service.convert(actor, f.api, f.input)
    assert.equal(result.state, 'done')
    assert.equal(f.service.association(actor, 'pdf').archivePath, 'Archive/sub/photo.jpg')
    assert.equal(f.service.association({ ...actor, space: 'other' }, 'pdf'), null)
    assert.equal(result.target, 'Inbox/sub/photo.jpg.pdf')
    assert.equal(result.original, 'Archive/sub/photo.jpg')
    assert.equal(f.files.get(result.original).resourceId, 'source')
    assert.equal(f.files.get(result.original).bytes.toString(), 'synthetic image input')
    assert.deepEqual(f.files.get(result.target).tags, ['Family'])
    assert.deepEqual(f.counts(), { puts: 1, moves: 1 })
    await f.service.convert(actor, f.api, f.input)
    assert.deepEqual(f.counts(), { puts: 1, moves: 1 })
    assert.throws(() => f.service.record({ ...actor, account: 'other' }, result.id), /not found/)
  } finally {
    f.close()
  }
})
test('failed rendering, collision or source change cannot move originals', async () => {
  for (const failure of ['render', 'collision', 'changed']) {
    const f = fixture()
    try {
      if (failure === 'render')
        f.service.render = async () => {
          throw Error('Unsupported image')
        }
      if (failure === 'collision') f.files.set(f.input.path + '.pdf', { folder: false })
      if (failure === 'changed') f.input.etag = '"stale"'
      await assert.rejects(f.service.convert(actor, f.api, f.input))
      assert.equal(f.counts().moves, 0)
      assert.ok(f.files.has(f.input.path))
    } finally {
      f.close()
    }
  }
})
test('unconfirmed upload is held and verification never replays PUT or moves original', async () => {
  const f = fixture()
  try {
    const put = f.api.put
    f.api.put = async (...args) => {
      await put(...args)
      throw Error('Lost response')
    }
    const result = await f.service.convert(actor, f.api, f.input)
    assert.equal(result.uncertain, true)
    assert.equal(f.counts().moves, 0)
    const verified = await f.service.reconcile(actor, f.api, result.id)
    assert.equal(verified.state, 'held')
    assert.deepEqual(f.counts(), { puts: 1, moves: 0 })
    assert.ok(f.files.has(f.input.path))
  } finally {
    f.close()
  }
})
test('lost MOVE response reconciles read-only, never moving or creating twice', async () => {
  const f = fixture()
  try {
    const move = f.api.move
    f.api.move = async (...args) => {
      await move(...args)
      throw Error('Lost response')
    }
    const result = await f.service.convert(actor, f.api, f.input)
    assert.equal(result.state, 'held')
    const restored = new Conversions(f.w, {
      render: async () => assert.fail('No repeated conversion')
    })
    assert.equal((await restored.reconcile(actor, f.api, result.id)).state, 'done')
    assert.deepEqual(f.counts(), { puts: 1, moves: 1 })
  } finally {
    f.close()
  }
})
test('incorrect uploaded bytes prevent archival; archive must stay outside watched Inbox', async () => {
  const f = fixture()
  try {
    const put = f.api.put
    f.api.put = async (path) => put(path, Buffer.from('corrupt'))
    assert.equal((await f.service.convert(actor, f.api, f.input)).state, 'held')
    assert.equal(f.counts().moves, 0)
    assert.throws(() => f.service.save(actor, 'Inbox/Archive'), /outside/)
    assert.throws(() => f.service.save(actor, '../Archive'))
    assert.equal(f.service.save(actor, 'Originals').archive, 'Originals')
  } finally {
    f.close()
  }
})
test('the source lock stays held until PDF readback and archival finish', async () => {
  const f = fixture()
  let unblock, entered
  const gate = new Promise((resolve) => (unblock = resolve)),
    reading = new Promise((resolve) => (entered = resolve)),
    get = f.api.get
  f.api.get = async (path, ...args) => {
    if (path.endsWith('.pdf')) {
      entered()
      await gate
    }
    return get(path, ...args)
  }
  try {
    const first = f.service.convert(actor, f.api, f.input)
    await reading
    await assert.rejects(f.service.convert(actor, f.api, f.input), /already running/)
    assert.equal(f.counts().moves, 0)
    unblock()
    assert.equal((await first).state, 'done')
    assert.deepEqual(f.counts(), { puts: 1, moves: 1 })
  } finally {
    unblock()
    f.close()
  }
})
test('conversion refuses an adapter for another Space before reading or writing files', async () => {
  const f = fixture()
  try {
    f.api.identity = async () => ({ ...actor, space: 'other' })
    await assert.rejects(f.service.convert(actor, f.api, f.input), /Inbox Space/)
    assert.deepEqual(f.counts(), { puts: 0, moves: 0 })
  } finally {
    f.close()
  }
})
async function spreadsheetFixture() {
  const f = fixture(),
    conversion = await f.service.convert(actor, f.api, f.input),
    original = conversion.original
  conversion.original = 'Archive/sub/table.xlsx'
  f.files.set(conversion.original, f.files.get(original))
  f.files.delete(original)
  f.service.persist(actor, conversion)
  f.service.render = async () => Buffer.from('%PDF-1.7 readable spreadsheet revision')
  return { ...f, conversion }
}
test('spreadsheet recreation verifies a backup first and preserves workbook bytes, PDF identity and tags', async () => {
  const f = await spreadsheetFixture()
  let replacements = 0
  f.api.replacePDF = async (path, bytes, etag) => {
    replacements++
    assert.equal(etag, f.files.get(path).etag)
    assert.ok([...f.files.keys()].some((path) => path.includes('/PDF versions/')))
    const file = f.files.get(path)
    file.bytes = bytes
    file.etag = '"new"'
  }
  try {
    const result = await f.service.reformat(actor, f.api, f.conversion.id)
    assert.equal(result.state, 'done')
    assert.equal(replacements, 1)
    assert.equal(f.files.get(result.path).resourceId, 'pdf')
    assert.deepEqual(f.files.get(result.path).tags, ['Family'])
    assert.equal(f.files.get(f.conversion.original).bytes.toString(), 'synthetic image input')
    assert.equal(f.files.get(result.backup).bytes.toString(), pdf.toString())
    assert.equal((await f.service.reformat(actor, f.api, f.conversion.id)).cached, true)
    assert.equal(replacements, 1)
  } finally {
    f.close()
  }
})
test('unconfirmed PDF replacement is read-only reconciled after restart and never resent', async () => {
  const f = await spreadsheetFixture()
  let replacements = 0
  f.api.replacePDF = async (path, bytes) => {
    replacements++
    f.files.get(path).bytes = bytes
    throw Error('Lost response')
  }
  try {
    const result = await f.service.reformat(actor, f.api, f.conversion.id)
    assert.equal(result.state, 'done')
    assert.equal((await f.service.verifyReformat(actor, f.api, result.id)).state, 'done')
    assert.equal(replacements, 1)
    assert.equal((await f.service.reformat(actor, f.api, f.conversion.id)).cached, true)
  } finally {
    f.close()
  }
})
test('changed originals or PDFs cannot be replaced and an unverified backup keeps the current PDF', async () => {
  for (const failure of ['source', 'pdf', 'backup']) {
    const f = await spreadsheetFixture()
    let replacements = 0
    f.api.replacePDF = async () => {
      replacements++
    }
    try {
      if (failure === 'source')
        f.files.get(f.conversion.original).bytes = Buffer.from('changed workbook')
      if (failure === 'pdf') f.files.get(f.conversion.target).bytes = Buffer.from('changed PDF')
      if (failure === 'backup') {
        const put = f.api.put
        f.api.put = async (path) => put(path, Buffer.from('damaged backup'))
        assert.equal((await f.service.reformat(actor, f.api, f.conversion.id)).uncertain, true)
      } else await assert.rejects(f.service.reformat(actor, f.api, f.conversion.id), /changed/)
      assert.equal(replacements, 0)
    } finally {
      f.close()
    }
  }
})
test('delayed backup visibility can continue on an explicit request before any replacement was attempted', async () => {
  const f = await spreadsheetFixture()
  f.service.wait = async () => {}
  let visible = false,
    replacements = 0
  const stat = f.api.stat
  f.api.stat = async (path) => (path.includes('/PDF versions/') && !visible ? null : stat(path))
  f.api.replacePDF = async (path, bytes) => {
    replacements++
    f.files.get(path).bytes = bytes
  }
  try {
    const first = await f.service.reformat(actor, f.api, f.conversion.id)
    assert.equal(first.state, 'backup_intent')
    assert.equal(first.uncertain, true)
    assert.equal(replacements, 0)
    assert.equal(f.counts().puts, 2)
    visible = true
    assert.equal((await f.service.reformat(actor, f.api, f.conversion.id)).state, 'done')
    assert.equal(replacements, 1)
    assert.equal(f.counts().puts, 2)
  } finally {
    f.close()
  }
})
test('a lost backup-tag response is verified before the first replacement, without repeating the tag request', async () => {
  const f = await spreadsheetFixture()
  let tags = 0,
    replacements = 0
  const add = f.api.addTags
  f.api.addTags = async (...args) => {
    tags++
    await add(...args)
    throw Error('Lost tag response')
  }
  f.api.replacePDF = async (path, bytes) => {
    replacements++
    f.files.get(path).bytes = bytes
  }
  try {
    assert.equal(
      (await f.service.reformat(actor, f.api, f.conversion.id)).state,
      'backup_tags_intent'
    )
    assert.equal(replacements, 0)
    assert.equal((await f.service.reformat(actor, f.api, f.conversion.id)).state, 'done')
    assert.equal(tags, 1)
    assert.equal(replacements, 1)
  } finally {
    f.close()
  }
})
