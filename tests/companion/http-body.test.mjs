// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRequestBody } from '../../companion/http-body.mjs'
import { apiError } from '../../companion/api-errors.mjs'
import { createDraftAPI } from '../../companion/draft-api.mjs'

function input(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks), { headers })
}
test('JSON bodies are bounded by bytes, reject non-objects and hide malformed input', async () => {
  assert.deepEqual(await readRequestBody(input([Buffer.from('{"x":'), Buffer.from('1}')])), {
    x: 1
  })
  for (const text of ['null', '[]', '5', '{"secret":"private-value"']) {
    await assert.rejects(readRequestBody(input([text])), (error) => {
      const failure = apiError(error)
      assert.equal(failure.status, 400)
      assert.equal(failure.body.code, 'REQUEST_INVALID')
      assert.ok(!JSON.stringify(failure).includes('private-value'))
      return true
    })
  }
  await assert.rejects(readRequestBody(input(['あああ']), 8), { code: 'REQUEST_TOO_LARGE' })
  let read = false
  const req = {
    headers: { 'content-length': '9' },
    async *[Symbol.asyncIterator]() {
      read = true
      yield '{}'
    }
  }
  await assert.rejects(readRequestBody(req, 8), { code: 'REQUEST_TOO_LARGE' })
  assert.equal(read, false)
  await assert.rejects(readRequestBody(input([], { 'content-length': 'invalid' })), {
    code: 'REQUEST_INVALID'
  })
})
test('missing or expired live authentication never consumes the request body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-request-auth-'))
  const api = createDraftAPI({
    database: join(directory, 'journal.sqlite'),
    mode: 'live',
    origin: 'https://fixture.invalid',
    space: 'fixture-space',
    allowOrigin: 'http://127.0.0.1:5175',
    logger: () => {},
    adapterFactory: () => ({
      identity: async () => {
        throw Object.assign(new Error('expired'), { status: 401 })
      }
    })
  })
  try {
    for (const authorization of [undefined, 'Bearer expired']) {
      let read = false,
        status
      await api.handle(
        {
          url: '/_workflow/api/status',
          method: 'POST',
          headers: {
            host: '127.0.0.1:5175',
            origin: 'http://127.0.0.1:5175',
            ...(authorization ? { authorization } : {})
          },
          async *[Symbol.asyncIterator]() {
            read = true
            yield '{}'
          }
        },
        {
          writeHead: (value) => {
            status = value
          },
          end: () => {}
        }
      )
      assert.equal(status, 401)
      assert.equal(read, false)
    }
  } finally {
    api.close()
    rmSync(directory, { recursive: true })
  }
})
test('a streamed overflow returns HTTP 413 instead of resetting the response socket', async () => {
  const server = createServer(async (req, res) => {
    try {
      await readRequestBody(req, 8)
      res.end('{}')
    } catch (error) {
      const failure = apiError(error)
      res.writeHead(failure.status, { Connection: 'close' })
      res.end(JSON.stringify(failure.body))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.address().port, method: 'POST' },
        (res) => {
          const parts = []
          res.on('data', (part) => parts.push(part))
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) })
          )
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.write('12345')
      req.end('67890')
    })
    assert.equal(result.status, 413)
    assert.equal(result.body.code, 'REQUEST_TOO_LARGE')
  } finally {
    server.close()
    server.closeAllConnections()
    await once(server, 'close')
  }
})

test('API returns 400 for malformed JSON and 413 for declared overflow after session verification', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-request-status-'))
  const order = []
  const api = createDraftAPI({
    database: join(directory, 'journal.sqlite'),
    mode: 'live',
    origin: 'https://fixture.invalid',
    space: 'fixture-space',
    allowOrigin: 'http://127.0.0.1:5175',
    logger: () => {},
    adapterFactory: () => ({
      identity: async () => {
        order.push('identity')
        return { server: 'https://fixture.invalid', account: 'fixture', space: 'fixture-space' }
      }
    })
  })
  try {
    for (const oversized of [false, true]) {
      order.length = 0
      let status, body
      await api.handle(
        {
          url: '/_workflow/api/status',
          method: 'POST',
          headers: {
            host: '127.0.0.1:5175',
            origin: 'http://127.0.0.1:5175',
            authorization: 'Bearer synthetic',
            ...(oversized ? { 'content-length': '32000001' } : {})
          },
          async *[Symbol.asyncIterator]() {
            order.push('body')
            yield '{"private":"do-not-echo"'
          }
        },
        {
          writeHead: (value) => {
            status = value
          },
          end: (value) => {
            body = JSON.parse(value)
          }
        }
      )
      assert.equal(status, oversized ? 413 : 400)
      assert.equal(body.code, oversized ? 'REQUEST_TOO_LARGE' : 'REQUEST_INVALID')
      assert.deepEqual(order, oversized ? ['identity'] : ['identity', 'body'])
      assert.ok(!JSON.stringify(body).includes('do-not-echo'))
    }
  } finally {
    api.close()
    rmSync(directory, { recursive: true })
  }
})
