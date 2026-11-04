// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundedJSON, cloudCompletion } from '../../companion/provider-response.mjs'
import { listModels, generateProposal, tagReviewValues } from '../../companion/ollama.mjs'
import { samples } from '../../src/domain/samples.ts'

test('provider envelopes must be JSON objects and failures never expose response bodies', async () => {
  for (const body of ['null', '[]', '42', '"private provider detail"', '{broken'])
    await assert.rejects(
      boundedJSON(new Response(body)),
      /^Error: Ollama returned invalid response JSON$/
    )
  await assert.rejects(boundedJSON(new Response(null)), /invalid response JSON/)
  await assert.rejects(
    boundedJSON(new Response('private provider detail', { status: 503 })),
    /^Error: Ollama HTTP 503$/
  )
  assert.deepEqual(await boundedJSON(Response.json({ choices: [] })), { choices: [] })
})

test('bounded response reading cancels oversized streams before parsing provider content', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"content":"too long"}'))
      },
      cancel() {
        cancelled = true
      }
    })
  )
  await assert.rejects(boundedJSON(response, 5), /exceeds size limit/)
  assert.equal(cancelled, true)
})

test('model discovery ignores malformed and remote entries without making them local selections', async () => {
  const result = await listModels('http://127.0.0.1:11434', async () =>
    Response.json({
      models: [
        null,
        1,
        {},
        { name: 42 },
        { name: 'remote:cloud' },
        { name: 'alias', remote_host: 'elsewhere' },
        { name: 'local', digest: { bad: true } },
        { name: 'pinned', digest: 'digest' }
      ]
    })
  )
  assert.deepEqual(result, [
    { name: 'local', digest: null },
    { name: 'pinned', digest: 'digest' }
  ])
})

test('cloud completion validation rejects malformed choices, refusals and tool responses', () => {
  for (const data of [
    {},
    { choices: null },
    { choices: [null] },
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'refused' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: {} } }] }
  ])
    assert.throws(() => cloudCompletion(data), /^Error: Cloud result is incomplete or refused$/)
  assert.equal(
    cloudCompletion({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
    '{}'
  )
})

test('malformed local completions fail before a proposal callback or evidence validation', async () => {
  const { proposal: _proposal, ...input } = samples()[0]
  for (const message of [
    null,
    [],
    { content: 12 },
    { content: '{}', tool_calls: [{}] },
    { content: '{}', tool_calls: { length: 1 } }
  ]) {
    let callbacks = 0
    await assert.rejects(
      generateProposal(
        input,
        'local',
        'http://127.0.0.1:11434',
        async (url) =>
          String(url).endsWith('/api/tags')
            ? Response.json({ models: [{ name: 'local' }] })
            : Response.json({ done: true, message }),
        () => {
          callbacks++
        }
      ),
      /Incomplete or invalid Ollama response/
    )
    assert.equal(callbacks, 0)
  }
})

test('tag discovery requires an enabled catalogue and literal existing names', () => {
  const { proposal: _proposal, ...input } = samples()[0]
  const value = { subject: 'Invoice', existingTags: [], newTags: [] }
  assert.throws(
    () => tagReviewValues(input, value),
    (error) => error.code === 'TAGS_INVALID'
  )
  input.tagDiscovery = { mode: 'existing', catalog: ['123'] }
  for (const raw of [
    null,
    [],
    { ...value, existingTags: [null] },
    { ...value, existingTags: [{ value: 123 }] },
    { ...value, newTags: [{ value: 'Invoice' }] }
  ])
    assert.throws(
      () => tagReviewValues(input, raw),
      (error) => error.code === 'TAGS_INVALID'
    )
})

test('probe support uses structured provider failures, never matching display text', async () => {
  const { ProviderHTTPError, unsupportedProbe } =
    await import('../../companion/provider-response.mjs')
  const { WorkflowError, manualReviewReason } = await import('../../src/domain/errors.ts')
  const unsupported = new ProviderHTTPError(404)
  unsupported.message = 'Translated provider failure'
  assert.equal(unsupportedProbe(unsupported, [404, 405, 501]), true)
  assert.equal(unsupportedProbe(new Error('Ollama HTTP 404'), [404]), false)
  assert.equal(unsupportedProbe(new ProviderHTTPError(401), [404]), false)
  assert.equal(unsupportedProbe(new ProviderHTTPError(503), [404]), false)
  assert.equal(
    unsupportedProbe(
      new WorkflowError('UPSTREAM_FAILURE', 'Ollama returned invalid response JSON'),
      []
    ),
    false
  )
  const invalid = new WorkflowError('PROVIDER_RESPONSE_INVALID', 'Translated malformed envelope')
  assert.equal(unsupportedProbe(invalid, []), true)
  assert.equal(manualReviewReason(invalid), null)
})
