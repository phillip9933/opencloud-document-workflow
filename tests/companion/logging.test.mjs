// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../../companion/logging.mjs'
import { handleRequest } from '../../companion/http-handler.mjs'

test('structured logs discard document, credential, URL and arbitrary error data', () => {
  const lines = []
  const log = createLogger((line) => lines.push(line))
  const error = Object.assign(new Error('Bearer private-token document-secret'), {
    code: 'ERR_SQLITE_ERROR',
    status: 503,
    body: 'document-secret',
    headers: { authorization: 'private-token' },
    stack:
      'Error: private-token\n    at request (/private/user/project/companion/draft-api.mjs:12:5)\n    at private-function (https://private.example:123/secret:1:1)\n    at fake (/companion/private-token.mjs:1:1)'
  })
  log('request_failed', error)
  const record = JSON.parse(lines[0])
  assert.equal(record.event, 'request_failed')
  assert.equal(record.code, 'ERR_SQLITE_ERROR')
  assert.equal(record.status, 503)
  assert.deepEqual(record.locations, ['draft-api.mjs:12:5'])
  assert.doesNotMatch(lines[0], /private|secret|Bearer|authorization/)
  error.code = 'private-token'
  error.name = 'document-secret'
  error.status = 'private-token'
  log('document-secret', error)
  assert.doesNotMatch(lines[1], /private|secret/)
  assert.doesNotThrow(() =>
    createLogger(() => {
      throw Error('disk unavailable')
    })('request_failed', error)
  )
})

test('HTTP failures after sending a response produce one safe log without a second response', async () => {
  const lines = []
  await handleRequest(
    async () => {
      throw Error('credential-secret')
    },
    createLogger((line) => lines.push(line))
  )({}, { headersSent: true, writableEnded: true })
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).event, 'http_handler_failed')
  assert.doesNotMatch(lines[0], /credential-secret/)
})
