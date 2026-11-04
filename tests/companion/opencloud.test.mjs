// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCloudAdapter, parseDAV } from '../../companion/opencloud.mjs'
const xml = (href, props) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
test('DAV parsing handles namespace prefixes, XML escaping and encoded/unencoded Space identities', () => {
  const body = xml(
    '/dav/spaces/storage$space/Inbox/A%20%26%20B.pdf',
    '<oc:fileid>storage$space!file</oc:fileid><d:getetag>&quot;v1&quot;</d:getetag><oc:tags><oc:tag>Keep &amp; preserve</oc:tag></oc:tags><d:resourcetype/>'
  )
  const [r] = parseDAV(body, 'https://example.org/dav/spaces/storage%24space/')
  assert.equal(r.path, 'Inbox/A & B.pdf')
  assert.equal(r.etag, '"v1"')
  assert.deepEqual(r.tags, ['Keep & preserve'])
  assert.equal(r.folder, false)
})
test('DAV parsing rejects external entities and responses outside the configured Space', () => {
  assert.throws(() =>
    parseDAV(
      '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><x/>',
      'https://example.org/dav/spaces/a/'
    )
  )
  for (const href of [
    '/dav/spaces/other/test.pdf',
    'https://other.example/dav/spaces/a/test.pdf',
    '/dav/spaces/a/../other/test.pdf'
  ])
    assert.throws(() =>
      parseDAV(xml(href, '<oc:fileid>x</oc:fileid>'), 'https://example.org/dav/spaces/a/')
    )
})
test('live adapter sends conditional non-overwriting moves and additive tags with ephemeral session auth', async () => {
  const requests = [],
    api = new OpenCloudAdapter({
      origin: 'https://example.org',
      space: 'storage$space',
      token: 'ephemeral-test-session',
      fetcher: async (url, opts) => {
        requests.push({ url, ...opts })
        return new Response(null, { status: 201 })
      }
    })
  await api.move('Inbox/請求.pdf', 'Filed/請求.pdf', '"v1"')
  const move = requests[0]
  assert.equal(move.method, 'MOVE')
  assert.equal(move.headers['If-Match'], '"v1"')
  assert.equal(move.headers.Overwrite, 'F')
  assert.equal(move.redirect, 'error')
  assert.equal(move.headers.Authorization, 'Bearer ephemeral-test-session')
  assert.ok(move.headers.Destination.startsWith('https://example.org/dav/spaces/storage%24space/'))
  await api.addTags('storage$space!file', ['Invoice'])
  assert.equal(requests[1].method, 'PUT')
  assert.deepEqual(JSON.parse(requests[1].body), {
    resourceId: 'storage$space!file',
    tags: ['Invoice']
  })
  await assert.rejects(api.request('GET', 'https://foreign.example/dav/spaces/x'), /outside/)
})
test('live identity comes from OpenCloud rather than client-supplied account identifiers', async () => {
  const api = new OpenCloudAdapter({
    origin: 'https://example.org',
    space: 'space',
    token: 'test',
    fetcher: async (url) =>
      new Response(
        url.endsWith('/me')
          ? JSON.stringify({ id: 'server-account', displayName: 'Tester' })
          : xml(
              '/dav/spaces/space/',
              '<oc:fileid>space!root</oc:fileid><d:getetag>&quot;root&quot;</d:getetag><d:resourcetype><d:collection/></d:resourcetype>'
            )
      )
  })
  assert.equal((await api.identity()).account, 'server-account')
})

test('live identity refuses journal access when current Space access has been revoked', async () => {
  const api = new OpenCloudAdapter({
    origin: 'https://example.org',
    space: 'space',
    token: 'test',
    fetcher: async (url) =>
      url.endsWith('/me')
        ? new Response(JSON.stringify({ id: 'server-account' }))
        : new Response(null, { status: 404 })
  })
  await assert.rejects(api.identity(), /403/)
})

test('Space directory follows only authenticated same-origin member directory pages', async () => {
  const urls = [],
    api = new OpenCloudAdapter({
      origin: 'https://opencloud.example',
      space: 'default',
      token: 'fixture',
      fetcher: async (url, options) => {
        urls.push(url)
        assert.equal(options.redirect, 'error')
        assert.equal(options.headers.Authorization, 'Bearer fixture')
        return Response.json(
          url.includes('skip')
            ? { value: [{ id: 'second', name: 'Archive', driveType: 'project' }] }
            : {
                value: [{ id: 'first', name: 'Personal', driveType: 'personal' }],
                '@odata.nextLink': 'https://opencloud.example/graph/v1.0/me/drives?$skiptoken=next'
              }
        )
      }
    })
  assert.deepEqual(
    (await api.spaces()).map((s) => s.id),
    ['first', 'second']
  )
  assert.equal(urls.length, 2)
  for (const continuation of [
    'https://foreign.example/graph/v1.0/me/drives',
    'https://opencloud.example/graph/v1.0/drives',
    'https://opencloud.example/graph/v1.0/me/drives'
  ]) {
    let calls = 0
    api.fetcher = async () => {
      calls++
      return Response.json({ value: [], '@odata.nextLink': continuation })
    }
    await assert.rejects(api.spaces(), /continuation/)
    assert.equal(calls, 1)
  }
})

test('Trash listing uses the selected Space and permits no purge endpoint', async () => {
  const { parseTrash } = await import('../../companion/opencloud.mjs'),
    base = 'https://example.org/dav/spaces/trash-bin/storage%24space/'
  const body = xml(
    '/dav/spaces/trash-bin/storage$space/file-id',
    '<oc:fileid>storage$space!file-id</oc:fileid><d:getcontentlength>512</d:getcontentlength><oc:trashbin-original-location>Inbox/bill.pdf</oc:trashbin-original-location><d:resourcetype/>'
  )
  assert.deepEqual(parseTrash(body, base), [
    {
      id: 'file-id',
      path: 'Inbox/bill.pdf',
      resourceId: 'storage$space!file-id',
      size: 512,
      folder: false
    }
  ])
  for (const href of [
    '/dav/spaces/trash-bin/other/file-id',
    '/dav/spaces/trash-bin/storage$space/../other/file-id',
    'https://foreign.example/dav/spaces/trash-bin/storage$space/file-id'
  ])
    assert.throws(() =>
      parseTrash(
        xml(href, '<oc:trashbin-original-location>Inbox/file.pdf</oc:trashbin-original-location>'),
        base
      )
    )
  const requests = [],
    api = new OpenCloudAdapter({
      origin: 'https://example.org',
      space: 'storage$space',
      token: 'fixture',
      fetcher: async (url, opts) => {
        requests.push({ url, ...opts })
        return new Response(opts.method === 'PROPFIND' ? body : null, {
          status: opts.method === 'PROPFIND' ? 207 : 204
        })
      }
    })
  await api.listTrash()
  assert.equal(requests[0].url, base)
  assert.equal(requests[0].headers.Depth, '1')
  await api.trash('Inbox/bill.pdf', '"v1"')
  assert.equal(requests[1].headers['If-Match'], '"v1"')
  assert.equal(requests[1].url, 'https://example.org/dav/spaces/storage%24space/Inbox/bill.pdf')
  await assert.rejects(api.request('DELETE', base), /outside/)
  await assert.rejects(api.request('DELETE', base + 'file-id'), /outside/)
  assert.equal(requests.length, 2)
})

test('OCR administration verifies the authenticated account’s existing fixed Admin role without any role mutation', async () => {
  const calls = [],
    account = 'verified-account',
    api = new OpenCloudAdapter({
      origin: 'https://example.org',
      space: 'space',
      token: 'test',
      fetcher: async (url, options) => {
        calls.push({ url, ...options })
        return Response.json(
          url.endsWith('/me')
            ? { id: account }
            : {
                value: [{ principalId: account, appRoleId: '71881883-1768-46bd-a24d-a356a2afdf7f' }]
              }
        )
      }
    })
  await api.accountIdentity()
  assert.equal(await api.isAdministrator(), true)
  assert.equal(
    calls[1].url,
    'https://example.org/graph/v1.0/users/verified-account/appRoleAssignments'
  )
  assert.equal(
    calls.every((c) => c.method === 'GET'),
    true
  )
  api.fetcher = async () =>
    Response.json({
      value: [{ principalId: 'other', appRoleId: '71881883-1768-46bd-a24d-a356a2afdf7f' }]
    })
  assert.equal(await api.isAdministrator(), false)
  api.fetcher = async () => new Response(null, { status: 403 })
  assert.equal(await api.isAdministrator(), false)
  await assert.rejects(
    api.request('GET', 'https://example.org/graph/v1.0/users/other/appRoleAssignments'),
    /outside/
  )
})

test('backup uploads and verification stream bytes through the selected authenticated Space with no overwrite', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { createHash } = await import('node:crypto'),
    dir = await mkdtemp(join(tmpdir(), 'backup-stream-')),
    file = join(dir, 'fixture.sqlite3'),
    bytes = Buffer.from('synthetic database bytes')
  await writeFile(file, bytes)
  let uploads = 0
  const api = new OpenCloudAdapter({
    origin: 'https://opencloud.example',
    space: 'space',
    token: 'synthetic-session',
    fetcher: async (url, options) => {
      assert.equal(url, 'https://opencloud.example/dav/spaces/space/Backups/fixture.sqlite3')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.Authorization, 'Bearer synthetic-session')
      if (options.method === 'PUT') {
        assert.equal(options.headers['If-None-Match'], '*')
        assert.equal(options.headers['Content-Type'], 'application/vnd.sqlite3')
        assert.equal(options.headers['Content-Length'], String(bytes.length))
        const chunks = []
        for await (const chunk of options.body) chunks.push(chunk)
        assert.deepEqual(Buffer.concat(chunks), bytes)
        uploads++
        return new Response(null, { status: 201 })
      }
      assert.equal(options.headers['If-Match'], 'fixture-etag')
      return new Response(bytes)
    }
  })
  try {
    await api.putFile('Backups/fixture.sqlite3', file, { contentType: 'application/vnd.sqlite3' })
    assert.equal(uploads, 1)
    assert.deepEqual(await api.digest('Backups/fixture.sqlite3', 'fixture-etag', bytes.length), {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    await assert.rejects(
      api.digest('Backups/fixture.sqlite3', 'fixture-etag', bytes.length - 1),
      /exceeds/
    )
  } finally {
    await rm(dir, { recursive: true })
  }
})
test('derived PDF replacement always requires If-Match and never accepts a create or precondition failure', async () => {
  const requests = []
  let status = 204
  const api = new OpenCloudAdapter({
    origin: 'https://example.org',
    space: 'space',
    token: 'test',
    fetcher: async (url, options) => {
      requests.push(options)
      return new Response(null, { status })
    }
  })
  await assert.rejects(
    api.replacePDF('Inbox/copy.pdf', Buffer.from('%PDF-'), ''),
    /current PDF version/
  )
  assert.equal(requests.length, 0)
  await api.replacePDF('Inbox/copy.pdf', Buffer.from('%PDF-'), '"v1"')
  assert.equal(requests[0].headers['If-Match'], '"v1"')
  assert.equal(requests[0].method, 'PUT')
  assert.equal(requests[0].redirect, 'error')
  for (status of [201, 412])
    await assert.rejects(api.replacePDF('Inbox/copy.pdf', Buffer.from('%PDF-'), '"v1"'))
})

test('authenticated identity exposes the server login name separately from its immutable ID', async () => {
  let username = 'login.person'
  const api = new OpenCloudAdapter({
    origin: 'https://example.org',
    space: 'space',
    token: 'synthetic',
    fetcher: async () =>
      Response.json({
        id: 'immutable-id',
        displayName: 'Display Person',
        onPremisesSamAccountName: username
      })
  })
  const identity = await api.accountIdentity()
  assert.equal(identity.account, 'immutable-id')
  assert.equal(identity.username, 'login.person')
  assert.equal(identity.name, 'Display Person')
  for (username of [undefined, '', 'bad:name', 'bad\nname'])
    assert.equal((await api.accountIdentity()).username, undefined)
})

test('tag directory uses only authenticated read access and validates the native string collection', async () => {
  const calls = [],
    api = new OpenCloudAdapter({
      origin: 'https://example.org',
      space: 'space',
      token: 'synthetic',
      fetcher: async (url, options) => {
        calls.push({ url, method: options.method })
        return Response.json({ value: ['Existing', '日本語'] })
      }
    })
  assert.deepEqual(await api.listTags(), ['Existing', '日本語'])
  assert.deepEqual(calls, [
    { url: 'https://example.org/graph/v1.0/extensions/org.libregraph/tags', method: 'GET' }
  ])
  api.fetcher = async () => Response.json({ value: [{}] })
  await assert.rejects(api.listTags(), /Invalid tag/)
})

test('tag removal uses the native resource-scoped unassignment body, never a global tag deletion', async () => {
  let called
  const api = new OpenCloudAdapter({
    origin: 'https://opencloud.example',
    space: 'space',
    token: 'fixture',
    fetcher: async (url, options) => {
      called = { url, options }
      return new Response(null, { status: 204 })
    }
  })
  await api.removeTags('resource', ['Vehicles'])
  assert.equal(called.url, 'https://opencloud.example/graph/v1.0/extensions/org.libregraph/tags')
  assert.equal(called.options.method, 'DELETE')
  assert.deepEqual(JSON.parse(called.options.body), {
    resourceId: 'space!resource',
    tags: ['Vehicles']
  })
})
