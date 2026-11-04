// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OpenCloudAdapter, RemoteError } from '../../companion/opencloud.mjs'

const adapter = (fetcher) =>
  new OpenCloudAdapter({
    origin: 'https://example.org',
    space: 'space',
    token: 'synthetic',
    fetcher
  })
test('buffered and streamed operations reject escaped endpoints before sending authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-transport-'))
  try {
    const file = join(dir, 'backup.json')
    await writeFile(file, '{}')
    let requests = 0
    const api = adapter(async () => {
      requests++
      return new Response(null, { status: 201 })
    })
    for (const url of [
      'https://other.example/dav/spaces/space/a.pdf',
      'https://example.org/dav/spaces/other/a.pdf',
      'https://example.org/dav/spaces/space/%2e%2e/other/a.pdf',
      'https://user@example.org/dav/spaces/space/a.pdf',
      'https://example.org/dav/spaces/space/a.pdf#fragment'
    ]) {
      api.url = () => url
      for (const operation of [
        () => api.request('GET', url),
        () => api.put('a.pdf', Buffer.from('pdf')),
        () => api.replacePDF('a.pdf', Buffer.from('pdf'), 'v1'),
        () => api.putFile('backup.json', file, { contentType: 'application/json' }),
        () => api.digest('a.pdf', 'v1', 100)
      ])
        await assert.rejects(operation(), /outside configured endpoints/)
    }
    assert.equal(requests, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('shared transport preserves conditional writes, streamed uploads and complete digest verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-transport-'))
  try {
    const file = join(dir, 'backup.json'),
      requests = []
    await writeFile(file, '{"synthetic":true}')
    const api = adapter(async (_url, options) => {
      requests.push(options)
      if (options.duplex) {
        const chunks = []
        for await (const chunk of options.body) chunks.push(chunk)
        assert.equal(Buffer.concat(chunks).toString(), '{"synthetic":true}')
      }
      return options.method === 'GET'
        ? new Response('full document')
        : new Response(null, {
            status: options.headers['If-Match'] ? 204 : 201,
            headers: { 'OC-FileId': 'new-file' }
          })
    })
    assert.deepEqual(await api.put('a.pdf', Buffer.from('pdf')), { resourceId: 'new-file' })
    await api.replacePDF('a.pdf', Buffer.from('pdf'), 'v1')
    await api.putFile('backup.json', file, { contentType: 'application/json' })
    assert.deepEqual(await api.digest('a.pdf', 'v1', 100), {
      bytes: 13,
      sha256: createHash('sha256').update('full document').digest('hex')
    })
    await assert.rejects(api.digest('a.pdf', 'v1', 3), /exceeds limit/)
    assert.equal(requests[0].headers['If-None-Match'], '*')
    assert.equal(requests[1].headers['If-Match'], 'v1')
    assert.equal(requests[2].duplex, 'half')
    assert.equal(requests[2].headers['Content-Length'], '18')
    assert.equal(requests[2].body.destroyed, true)
    assert.equal(requests[3].headers['If-Match'], 'v1')
    for (const options of requests) {
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.Authorization, 'Bearer synthetic')
      assert.ok(options.signal instanceof AbortSignal)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unexpected success statuses cannot bypass upload outcome verification', async () => {
  let cancelled = false
  const api = adapter(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          }
        }),
        { status: 200 }
      )
  )
  await assert.rejects(
    api.put('a.pdf', Buffer.from('pdf')),
    (error) => error instanceof RemoteError && error.status === 200
  )
  assert.equal(cancelled, true)
  const missingIdentity = adapter(async () => new Response(null, { status: 201 }))
  await assert.rejects(missingIdentity.put('a.pdf', Buffer.from('pdf')), /needs verification/)
  await assert.rejects(
    missingIdentity.replacePDF('a.pdf', Buffer.from('pdf'), 'v1'),
    (error) => error instanceof RemoteError && error.status === 201
  )
})
