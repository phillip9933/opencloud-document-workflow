// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { healthResponse } from '../../companion/health.mjs'
test('public installer health exposes readiness without disclosing the version and never handles other API operations', () => {
  let headers, body
  const res = {
    writeHead(status, value) {
      assert.equal(status, 200)
      headers = value
    },
    end(value) {
      body = JSON.parse(value)
    }
  }
  assert.equal(
    healthResponse({ url: '/_workflow/api/healthz', method: 'GET' }, res, '0.13.0'),
    true
  )
  assert.equal(body.service, 'document-workflow')
  assert.equal(body.apiVersion, 1)
  assert.equal(body.ready, true)
  assert.equal(body.version, undefined)
  const publicInstance = body.instance
  assert.match(publicInstance, /^[a-f0-9-]{36}$/)
  const local = {
    url: '/_workflow/api/healthz',
    method: 'GET',
    headers: { host: '127.0.0.1:5175' },
    socket: { remoteAddress: '127.0.0.1' }
  }
  assert.equal(healthResponse(local, res, '0.13.0'), true)
  assert.equal(body.version, '0.13.0')
  assert.equal(body.instance, publicInstance)
  assert.equal(
    healthResponse({ ...local, socket: { remoteAddress: '192.168.1.12' } }, res, '0.13.0'),
    true
  )
  assert.equal(body.version, undefined)
  assert.equal(headers['Cache-Control'], 'no-store')
  for (const request of [
    { url: '/_workflow/api/status', method: 'GET' },
    { url: '/_workflow/api/healthz', method: 'POST' },
    { url: '/_workflow/api/healthz?dump=secrets', method: 'GET' }
  ])
    assert.equal(healthResponse(request, res, '0.13.0'), false)
})
