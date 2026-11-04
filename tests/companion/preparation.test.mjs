// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  readDocument,
  validatePreparedReview,
  manualFallbackReason
} from '../../companion/preparation.mjs'
import { samples } from '../../src/domain/samples.ts'
import { defaultPolicy } from '../../src/domain/review.ts'

const actor = { server: 'https://synthetic.invalid', account: 'fixture', space: 'fixture-space' }
const before = {
  path: 'Inbox/fixture.pdf',
  resourceId: 'fixture-id',
  etag: '"fixture-etag"',
  tags: []
}
const failOCR = () => assert.fail('OCR must remain off')

test('document reading pins identity and bytes and passes a finite default download limit', async () => {
  const bytes = readFileSync(new URL('../fixtures/english.pdf', import.meta.url))
  const calls = []
  const result = await readDocument({
    actor,
    path: before.path,
    before,
    configuration: { policy: defaultPolicy() },
    api: {
      get: async (...args) => {
        calls.push(args)
        return bytes
      },
      stat: async () => before
    },
    progress: failOCR,
    onOCR: failOCR
  })
  assert.deepEqual(calls, [[before.path, before.etag, 100 * 1024 * 1024]])
  assert.equal(result.ocrAttempted, false)
  assert.equal(result.input.source.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(result.input.source, result.source)
  assert.equal(result.source.resourceId, before.resourceId)
  assert.match(result.input.pages.join('\n'), /SYNTHETIC/)
})
test('changed or missing source identity stops before extraction or OCR', async () => {
  for (const after of [
    null,
    { ...before, etag: '"new"' },
    { ...before, resourceId: 'replacement' }
  ]) {
    await assert.rejects(
      readDocument({
        actor,
        path: before.path,
        before,
        configuration: { policy: { ...defaultPolicy(), ocr: 'automatic' }, ocrLanguages: ['eng'] },
        api: { get: async () => Buffer.from('not a PDF'), stat: async () => after },
        progress: failOCR,
        onOCR: failOCR
      }),
      /Source changed during reading/
    )
  }
})
test('provider result validation keeps exact input and refuses changed identity or added extracted text', () => {
  const bundle = samples()[0],
    { proposal, ...input } = bundle
  assert.deepEqual(validatePreparedReview(input, bundle).bundle.source, input.source)
  for (const mutation of [
    (value) => {
      value.source.etag = '"replacement"'
    },
    (value) => {
      value.pages[0] += '\nInjected source text'
    }
  ]) {
    const changed = structuredClone(bundle)
    mutation(changed)
    assert.throws(
      () => validatePreparedReview(input, changed),
      /changed source identity or extracted pages/
    )
  }
})
test('manual fallback permits only known validation failures and never hides infrastructure or identity failures', () => {
  for (const [message, reason] of [
    ['Quote is absent from its page', 'evidence'],
    ['Invalid calendar date', 'date'],
    ['Document exceeds configured model context capacity: synthetic', 'capacity']
  ]) {
    assert.equal(manualFallbackReason(new Error(message), true), reason)
    assert.equal(manualFallbackReason(new Error(message), false), null)
  }
  for (const error of [
    null,
    undefined,
    'Quote is absent from its page',
    { message: 1 },
    new Error('fetch failed'),
    new Error('Provider result changed source identity or extracted pages')
  ])
    assert.equal(manualFallbackReason(error, true), null)
})
