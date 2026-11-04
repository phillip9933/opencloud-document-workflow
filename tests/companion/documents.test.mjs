// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { DocumentLibrary } from '../../companion/documents.mjs'
import { samples } from '../../src/domain/samples.ts'
const actor = { server: 'https://opencloud.example', account: 'library-user', space: 'trial' }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-library-')),
    journal = new ProposalJournal(join(dir, 'state.sqlite3')),
    w = new Workflow(journal)
  w.metadata = new Metadata(w)
  const library = new DocumentLibrary(w)
  function add(
    index,
    {
      owner = actor,
      resource = `resource-${index}`,
      state = 'done',
      updated = '2026-10-30T12:00:00.000Z',
      path = `Filed/${index}.pdf`,
      sender = 'Synthetic sender',
      fields = {}
    } = {}
  ) {
    const id = createHash('sha256')
        .update(`${owner.account}:${owner.space}:${index}`)
        .digest('hex'),
      bundle = structuredClone(samples()[0])
    bundle.source = { ...bundle.source, ...owner, resourceId: resource, path: `Inbox/${index}.pdf` }
    bundle.proposal.issuer.value = sender
    const { proposal, ...input } = bundle,
      scope = w.scope(owner)
    w.db
      .prepare(
        'insert into proposals(id,scope,input,configuration,state,result,updated) values(?,?,?,?,?,?,?)'
      )
      .run(id, scope, JSON.stringify(input), '{}', 'needs_review', JSON.stringify(bundle), updated)
    w.db
      .prepare('insert into decisions(job,actor,record,state,plan,updated) values(?,?,?,?,?,?)')
      .run(
        id,
        owner.account,
        JSON.stringify({ actions: { target: path, addTags: ['Reviewed'] } }),
        state,
        JSON.stringify({ expectedTags: ['Keep existing', 'Reviewed'] }),
        updated
      )
    w.db
      .prepare(
        'insert into metadata values(?,?,?,?,?) on conflict(scope,resource) do update set fields=excluded.fields'
      )
      .run(scope, resource, 1, JSON.stringify(fields), updated)
    return id
  }
  return {
    w,
    library,
    add,
    close() {
      journal.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('filed records are scoped, paged without gaps at tied times, and independent of the 200-job inbox window', () => {
  const s = setup()
  try {
    for (let n = 0; n < 205; n++) s.add(n)
    s.add('other-account', { owner: { ...actor, account: 'other' } })
    s.add('other-space', { owner: { ...actor, space: 'other' } })
    s.add('unfinished', { state: 'approved' })
    assert.equal(s.w.jobs(actor).length, 200)
    assert.equal(s.w.jobs(actor, { activeOnly: true }).length, 1)
    assert.equal(s.w.jobsHaveMore(actor), true)
    assert.equal(s.w.jobsHaveMore(actor, { activeOnly: true }), false)
    let cursor,
      ids = []
    do {
      const page = s.library.list(actor, { limit: 37, cursor })
      ids.push(...page.documents.map((d) => d.id))
      cursor = page.nextCursor
      assert.equal(page.hasMore, !!cursor)
    } while (cursor)
    assert.equal(ids.length, 205)
    assert.equal(new Set(ids).size, 205)
    const older = ids.find((id) => !s.w.jobs(actor).some((job) => job.id === id))
    assert(older)
    assert.equal(s.w.jobView(actor, older).id, older)
    assert.throws(() => s.w.jobView({ ...actor, account: 'other' }, older), /not found/)
  } finally {
    s.close()
  }
})
test('search includes Unicode names and saved fields and treats wildcard characters literally', () => {
  const s = setup()
  try {
    s.add(1, {
      path: 'Filed/Électricité 水道.pdf',
      sender: 'Énergie',
      fields: { invoice_number: 'INV_%42' }
    })
    s.add(2, { fields: { invoice_number: 'unrelated' } })
    for (const search of ['éLECTRICITÉ', '水道', 'éNERGIE', 'inv_%42'])
      assert.equal(s.library.list(actor, { search }).documents.length, 1)
    assert.equal(s.library.list(actor, { search: '%' }).documents.length, 1)
    assert.equal(s.library.list(actor, { search: "' OR 1=1 --" }).documents.length, 0)
  } finally {
    s.close()
  }
})
test('only the latest completed filing for each canonical resource is shown with preserved tags and fields', () => {
  const s = setup()
  try {
    s.add(1, { resource: 'same', path: 'Filed/old.pdf' })
    s.add(2, {
      resource: 'same',
      path: 'Filed/new.pdf',
      updated: '2026-10-30T12:01:00.000Z',
      fields: { invoice_number: 'KEPT' }
    })
    const page = s.library.list(actor)
    assert.equal(page.documents.length, 1)
    assert.equal(page.documents[0].path, 'Filed/new.pdf')
    assert.equal(page.documents[0].fields.invoice_number, 'KEPT')
    assert.deepEqual(page.documents[0].tags, ['Keep existing', 'Reviewed'])
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { search: 'x'.repeat(201) },
      { cursor: 'bad' },
      {
        cursor: Buffer.from(JSON.stringify({ v: 1, id: 'bad', updated: 'not a date' })).toString(
          'base64url'
        )
      }
    ])
      assert.throws(() => s.library.list(actor, options))
  } finally {
    s.close()
  }
})
test('confirmed tags added after filing remain searchable without replacing required filing tags', () => {
  const s = setup()
  try {
    s.add(1, { resource: 'tagged' })
    s.w.db
      .prepare('insert into metadata_changes values(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'change',
        s.w.scope(actor),
        'tagged',
        'Filed/1.pdf',
        'a'.repeat(64),
        'v1',
        1,
        '{}',
        JSON.stringify(['Keep existing', 'Reviewed', 'Paid']),
        'done',
        '2026-10-30T12:02:00.000Z'
      )
    const record = s.library.list(actor, { search: 'Paid' }).documents[0]
    assert(record)
    assert.deepEqual(record.tags, ['Keep existing', 'Reviewed', 'Paid'])
    assert.equal(
      s.library.list({ ...actor, account: 'other' }, { search: 'Paid' }).documents.length,
      0
    )
  } finally {
    s.close()
  }
})
test('search finds extracted body text and saved views are isolated by account and Space', () => {
  const s = setup()
  try {
    s.add(1)
    assert.equal(s.library.list(actor, { search: 'SYNTHETIC DOCUMENT' }).documents.length, 1)
    const id = '12345678-1234-1234-1234-123456789012'
    s.library.saveView(actor, { id, name: 'Electricity', query: { search: 'Electricity' } })
    assert.equal(s.library.views(actor)[0].query.search, 'Electricity')
    assert.deepEqual(s.library.views({ ...actor, space: 'other' }), [])
    assert.deepEqual(s.library.views({ ...actor, account: 'other' }), [])
    s.library.deleteView({ ...actor, space: 'other' }, id)
    assert.equal(s.library.views(actor).length, 1)
    s.library.deleteView(actor, id)
    assert.equal(s.library.views(actor).length, 0)
  } finally {
    s.close()
  }
})
test('review and activity pagination reach every older row at tied timestamps', () => {
  const s = setup()
  try {
    for (let n = 0; n < 430; n++) {
      s.add(n, { state: 'approved' })
      s.w.event(actor, null, 'pagination_test', { n })
    }
    let cursor,
      ids = []
    do {
      const page = s.w.jobPage(actor, { limit: 137, cursor, activeOnly: true })
      ids.push(...page.jobs.map((j) => j.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(new Set(ids).size, 430)
    let events = []
    cursor = undefined
    do {
      const page = s.w.activityPage(actor, { limit: 137, cursor })
      events.push(...page.events.map((e) => e.seq))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(new Set(events).size, 430)
    assert.throws(() => s.w.jobPage(actor, { cursor: 'wrong' }), /cursor/)
  } finally {
    s.close()
  }
})

test('library folder browsing reads all formats only inside the configured destination and checks its Space', async () => {
  const s = setup(),
    calls = []
  try {
    s.w.configuration = {
      settings: () => ({ rules: { root: 'Docs' } }),
      destinationSpace: () => 'destination'
    }
    s.w.transfers = {
      canonical: (_a, id) => id,
      adapter: async (a, api, space) => {
        assert.equal(a, actor)
        assert.equal(space, 'destination')
        return {
          list: async (path) => {
            calls.push(path)
            return [
              { path: path + '/photo.jpg', resourceId: 'image', folder: false, tags: [] },
              { path: path + '/sheet.xlsx', resourceId: 'sheet', folder: false, tags: [] }
            ]
          }
        }
      }
    }
    s.add('image', { resource: 'image', fields: { reference: 'VISIBLE' } })
    s.add('foreign', {
      owner: { ...actor, account: 'other' },
      resource: 'sheet',
      fields: { reference: 'PRIVATE' }
    })
    const result = await s.library.browse(actor, {})
    assert.deepEqual(
      result.files.map((file) => file.fields),
      [{ reference: 'VISIBLE' }, {}]
    )
    assert.equal(result.files.length, 2)
    assert.equal(result.space, 'destination')
    assert.deepEqual(calls, ['Docs'])
    await assert.rejects(s.library.browse(actor, {}, { path: 'Inbox' }), /inside/)
    assert.deepEqual(calls, ['Docs'])
    s.w.transfers.adapter = async () => ({
      list: async () => [{ path: 'DocsElsewhere/private.pdf' }]
    })
    await assert.rejects(s.library.browse(actor, {}), /outside/)
  } finally {
    s.close()
  }
})

test('external file and parent-folder renames update history/search by identity without rewriting approvals, tags or fields', async () => {
  const s = setup()
  try {
    s.w.configuration = {
      settings: () => ({ rules: { root: 'Docs' } }),
      destinationSpace: () => actor.space
    }
    let path = 'Docs/Vehicles/2025/car.pdf',
      tags = ['Vehicles', 'Phil'],
      fail = false
    const physical = {
      list: async (folder) => {
        if (fail && folder === 'Docs/Vehicles') throw Error('access lost')
        return folder === 'Docs'
          ? [{ path: 'Docs/Vehicles', folder: true }]
          : folder === 'Docs/Vehicles'
            ? [{ path: 'Docs/Vehicles/2025', folder: true }]
            : [{ path, resourceId: 'car', etag: 'v2', tags, folder: false }]
      },
      stat: async (wanted) =>
        wanted === path ? { path, resourceId: 'car', etag: 'v2', tags, folder: false } : null
    }
    s.w.transfers = {
      canonical: (_a, id) => id,
      adapter: async (a, api, space) => {
        if (a.account !== actor.account) throw Error('access denied')
        assert.equal(space, actor.space)
        return physical
      }
    }
    // Create the tables normally owned by Transfers without introducing a second
    // copy/alias; an external same-Space rename preserves this resource identity.
    const id = s.add('car', {
        resource: 'car',
        path: 'Docs/Old/car.pdf',
        fields: { reference: 'KEPT' }
      }),
      original = s.w.decision(actor, id).record
    const result = await s.library.currentList(actor, physical, { search: '2025' })
    assert.equal(result.documents[0].path, path)
    assert.deepEqual(result.documents[0].tags, tags)
    assert.equal(result.documents[0].fields.reference, 'KEPT')
    assert.equal((await s.w.location(actor, { ...physical, space: actor.space }, id)).path, path)
    path = 'Docs/Vehicles/2025/renamed.pdf'
    tags = ['Vehicles', 'Updated externally']
    const renamed = await s.library.currentList(actor, physical, { search: 'renamed' })
    assert.equal(renamed.documents[0].path, path)
    assert.deepEqual(renamed.documents[0].tags, tags)
    assert.equal(s.w.decision(actor, id).record, original)
    assert.equal(s.w.decision(actor, id).state, 'done')
    await assert.rejects(
      s.library.currentList({ ...actor, account: 'other' }, physical),
      /access denied/
    )
    assert.equal(s.library.list({ ...actor, account: 'other' }).documents.length, 0)
    fail = true
    await assert.rejects(s.library.currentList(actor, physical), /access lost/)
    assert.equal(
      s.library.list(actor).documents[0].path,
      path,
      'a partial scan cannot publish a missing location'
    )
  } finally {
    s.close()
  }
})

test('external tracking rejects copied identities, path escapes, duplicate IDs and configuration changes, and never redirects unfinished approvals', async () => {
  const s = setup()
  try {
    let root = 'Docs',
      rows = [{ path: 'Docs/copy.pdf', resourceId: 'copy', etag: 'v1', tags: [], folder: false }]
    s.w.configuration = {
      settings: () => ({ rules: { root } }),
      destinationSpace: () => actor.space
    }
    const physical = { space: actor.space, list: async () => rows, stat: async () => null }
    s.w.transfers = { canonical: (_a, id) => id, adapter: async () => physical }
    const id = s.add('source', { resource: 'source', path: 'Docs/old.pdf' })
    await assert.rejects(s.w.location(actor, physical, id), /could not be located/)
    rows = [
      { path: 'Elsewhere/source.pdf', resourceId: 'source', etag: 'v1', tags: [], folder: false }
    ]
    await assert.rejects(s.library.currentList(actor, physical), /outside/)
    rows = [
      { path: 'Docs/one.pdf', resourceId: 'source', etag: 'v1', tags: [], folder: false },
      { path: 'Docs/two.pdf', resourceId: 'source', etag: 'v1', tags: [], folder: false }
    ]
    await assert.rejects(s.library.currentList(actor, physical), /repeated/)
    rows = [{ path: 'Docs/one.pdf', resourceId: 'source', etag: 'v1', tags: [], folder: false }]
    const pending = s.add('pending', {
      state: 'approved',
      resource: 'source',
      path: 'Docs/old.pdf'
    })
    await assert.rejects(s.w.location(actor, physical, pending), /could not be located/)
    physical.list = async () => {
      root = 'Changed'
      return rows
    }
    await assert.rejects(s.library.currentList(actor, physical), /destination changed/)
  } finally {
    s.close()
  }
})

test('job pages read conversion and automation associations in a fixed number of scoped queries', () => {
  const s = setup()
  try {
    const id = s.add(0),
      second = s.add(1)
    for (let n = 2; n < 205; n++) s.add(n)
    s.w.db
      .prepare('insert into automatic_runs values(?,?,?,?,?,?,?)')
      .run(id, s.w.scope(actor), '{}', 'review', 'Synthetic hold', 'now', 'now')
    s.w.db.prepare('insert into conversions values(?,?,?)').run(
      'conversion',
      s.w.scope(actor),
      JSON.stringify({
        id: 'conversion',
        pdfResourceId: 'resource-0',
        resourceId: 'original',
        original: 'Archive/original.png',
        sha256: 'a'.repeat(64),
        state: 'done'
      })
    )
    // An unrelated actor's matching resource must never attach its archive.
    s.w.db.prepare('insert into conversions values(?,?,?)').run(
      'foreign',
      s.w.scope({ ...actor, account: 'someone-else' }),
      JSON.stringify({
        id: 'foreign',
        pdfResourceId: 'resource-1',
        state: 'done',
        original: 'private'
      })
    )
    const prepare = s.w.db.prepare.bind(s.w.db)
    let reads = 0
    s.w.db.prepare = (...args) => {
      if (/^select/i.test(args[0])) reads++
      return prepare(...args)
    }
    for (const limit of [1, 200]) {
      reads = 0
      assert.equal(s.w.jobPage(actor, { limit }).jobs.length, limit)
      assert.equal(reads, 3)
    }
    const job = s.w.jobPage(actor, { id }).jobs[0]
    assert.equal(job.automation.state, 'review')
    assert.equal(job.conversion.archivePath, 'Archive/original.png')
    assert.equal(s.w.jobPage(actor, { id: second }).jobs[0].conversion, null)
  } finally {
    s.close()
  }
})
