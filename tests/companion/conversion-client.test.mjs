// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRemotePDF } from '../../companion/conversion-client.mjs'
const source = Buffer.from('synthetic image')
test('conversion client refuses unconfigured or non-private endpoints before sending bytes', async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw Error('Unexpected request')
  }
  try {
    for (const endpoint of [
      undefined,
      'https://converter:5180',
      'http://outside.example:5180',
      'http://converter:5180/path',
      'http://user:secret@converter:5180'
    ])
      await assert.rejects(() => renderRemotePDF(endpoint, source, 'png'))
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = previous
  }
})
test('conversion error responses are bounded and do not expose arbitrary remote details', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response('private remote diagnostic', { status: 422 })
  try {
    await assert.rejects(
      () => renderRemotePDF('http://converter:5180', source, 'png'),
      (error) => error.code === 'OPERATION_HELD' && !error.message.includes('private')
    )
    globalThis.fetch = async () => new Response('x'.repeat(2048), { status: 422 })
    await assert.rejects(
      () => renderRemotePDF('http://converter:5180', source, 'png'),
      /exceeds limit/
    )
  } finally {
    globalThis.fetch = previous
  }
})
test('conversion client rejects a missing PDF body and preserves bounded successful bytes', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 200 })
  try {
    await assert.rejects(() => renderRemotePDF('http://converter:5180', source, 'png'), /no PDF/)
    const pdf = Buffer.from('%PDF-1.7 synthetic')
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://converter:5180/convert/png')
      assert.equal(options.redirect, 'error')
      assert.equal(options.body, source)
      return new Response(pdf, { status: 200 })
    }
    assert.deepEqual(await renderRemotePDF('http://converter:5180', source, 'png'), pdf)
  } finally {
    globalThis.fetch = previous
  }
})
