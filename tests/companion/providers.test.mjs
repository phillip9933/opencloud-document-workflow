// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRouted, executionConfig, cloudEndpoint } from '../../companion/providers.mjs'
import { defaultAIConfig } from '../../src/domain/ai.ts'
import { defaultPolicy } from '../../src/domain/review.ts'
import { samples } from '../../src/domain/samples.ts'
import { defaultFilingRules } from '../../src/domain/filing.ts'
const sample = samples()[0],
  { proposal, ...input } = sample
function prefs() {
  const ai = defaultAIConfig()
  ai.local.model = 'local-model'
  ai.cloud = { endpoint: 'https://provider.example/v1', model: 'cloud-model' }
  ai.tasks = { facts: 'local', filing: 'local', tags: 'cloud' }
  return { ai, policy: defaultPolicy() }
}
const runtime = {
  local: 'http://127.0.0.1:11434',
  cloud: 'https://provider.example/v1',
  cloudKey: 'fixture-not-a-real-key'
}
test('task routing uses only explicitly enabled operator endpoints and never stores credentials', () => {
  const config = executionConfig(prefs(), runtime)
  assert.equal(config.routes.tags.provider, 'cloud')
  assert.equal(JSON.stringify(config).includes(runtime.cloudKey), false)
  assert.throws(() => executionConfig(prefs(), { ...runtime, cloudKey: null }), /not enabled/)
  assert.throws(() => cloudEndpoint('http://provider.example/v1'))
  assert.throws(() => cloudEndpoint('https://user:pass@provider.example/v1'))
})
test('mixed models execute their assigned stages, share identical routes, and validate cloud evidence', async () => {
  const config = executionConfig(prefs(), runtime),
    calls = []
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-model' }] })
    if (url.endsWith('/api/chat'))
      return Response.json({ done: true, message: { content: JSON.stringify(proposal) } })
    if (url.endsWith('/chat/completions'))
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }]
      })
    throw new Error('unexpected target')
  }
  const result = await generateRouted(input, config, { cloudKey: runtime.cloudKey, fetcher })
  assert.equal(result.state, 'needs_review')
  assert.equal(calls.filter((c) => c.url.endsWith('/api/chat')).length, 1)
  const request = calls.find((c) => c.url.endsWith('/chat/completions'))
  assert.equal(request.options.headers.Authorization, 'Bearer ' + runtime.cloudKey)
  assert.equal(JSON.parse(request.options.body).store, false)
  assert.equal(request.options.redirect, 'error')
})
test('disabled optional tasks make no provider call and remove their suggestions', async () => {
  const p = prefs()
  p.ai.tasks = { facts: 'local', filing: 'off', tags: 'off' }
  const config = executionConfig(p, runtime),
    calls = []
  const fetcher = async (url) => {
    calls.push(url)
    return url.endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'local-model' }] })
      : Response.json({ done: true, message: { content: JSON.stringify(proposal) } })
  }
  const r = await generateRouted(input, config, { fetcher })
  assert.equal(r.proposal.folder.value, 'Other')
  assert.deepEqual(r.proposal.tags, [])
  assert.equal(calls.length, 2)
})
test('local and cloud task routes both support an intentionally empty AI tag taxonomy', async () => {
  for (const provider of ['local', 'cloud']) {
    const p = prefs(),
      rules = defaultFilingRules(),
      emptyProposal = { ...proposal, tags: [] }
    rules.tags = []
    p.ai.tasks = { facts: provider, filing: provider, tags: provider }
    let format
    const result = await generateRouted({ ...input, rules }, executionConfig(p, runtime), {
      cloudKey: runtime.cloudKey,
      fetcher: async (url, options) => {
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-model' }] })
        const body = JSON.parse(options.body)
        format = body.format ?? body.response_format.json_schema.schema
        assert.equal(format.properties.tags.maxItems, 0)
        assert.equal(Object.hasOwn(format.properties.tags.items.properties.value, 'enum'), false)
        return provider === 'local'
          ? Response.json({ done: true, message: { content: JSON.stringify(emptyProposal) } })
          : Response.json({
              choices: [
                { finish_reason: 'stop', message: { content: JSON.stringify(emptyProposal) } }
              ]
            })
      }
    })
    assert.ok(format)
    assert.deepEqual(result.proposal.tags, [])
    assert.equal(result.state, 'needs_review')
  }
})
test('cloud refusal or fabricated facts fail closed without a local fallback', async () => {
  const p = prefs()
  p.ai.tasks = { facts: 'cloud', filing: 'cloud', tags: 'cloud' }
  const c = executionConfig(p, runtime)
  let calls = 0
  const fetcher = async () => {
    calls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: { refusal: 'refused' } }] })
  }
  await assert.rejects(generateRouted(input, c, { cloudKey: runtime.cloudKey, fetcher }), /refused/)
  assert.equal(calls, 1)
  const changed = structuredClone(proposal)
  changed.issuer.value = 'Fabricated'
  await assert.rejects(
    generateRouted(input, c, {
      cloudKey: runtime.cloudKey,
      fetcher: async () =>
        Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(changed) } }]
        })
    }),
    /Fact is not present/
  )
})

test('optional semantic review uses a focused second call for local and cloud routes without writing tags or changing source', async () => {
  for (const provider of ['local', 'cloud']) {
    const p = prefs()
    p.ai.tasks = { facts: provider, filing: provider, tags: provider }
    p.ai.tagDiscovery = 'create'
    const rules = defaultFilingRules()
    rules.tags = []
    const checked = { ...input, rules, tagDiscovery: { mode: 'create', catalog: [] } },
      calls = []
    let progress = 0
    const result = await generateRouted(checked, executionConfig(p, runtime), {
      cloudKey: runtime.cloudKey,
      onTagReview: () => progress++,
      fetcher: async (url, options) => {
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-model' }] })
        const body = JSON.parse(options.body)
        calls.push(body)
        const schema = body.format ?? body.response_format.json_schema.schema,
          isTags = schema.required.includes('subject'),
          output = isTags
            ? {
                subject: 'Household electricity',
                existingTags: [],
                newTags: [{ value: 'Home utilities', evidence: proposal.kind.evidence }]
              }
            : { ...proposal, tags: [] }
        assert.equal(
          body.messages.some((m) => m.content.includes('EXISTING_TAGS')),
          isTags
        )
        if (isTags) {
          assert.ok(body.messages[0].content.includes('closely related concept'))
          assert.deepEqual(
            JSON.parse(body.messages[1].content).CURRENT_DOCUMENT.map((p) => p.text),
            input.pages
          )
        }
        return provider === 'local'
          ? Response.json({ done: true, message: { content: JSON.stringify(output) } })
          : Response.json({
              choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }]
            })
      }
    })
    assert.equal(calls.length, 2)
    assert.equal(progress, 1)
    assert.deepEqual(result.bundle.source, input.source)
    assert.deepEqual(result.bundle.tagDiscovery, checked.tagDiscovery)
    assert.equal(result.proposal.tags[0].value, 'Home utilities')
    assert.ok(
      calls.every((call) =>
        provider === 'local'
          ? call.truncate === false && call.shift === false
          : call.store === false
      )
    )
  }
})

test('cloud tag review budgets the actual focused messages and both tag schemas before any provider request', async () => {
  const { tagReviewPromptSize, promptContext } = await import('../../companion/ollama.mjs'),
    p = prefs()
  p.ai.tasks = { facts: 'cloud', filing: 'cloud', tags: 'cloud' }
  p.ai.tagDiscovery = 'create'
  const checked = {
      ...input,
      tagDiscovery: {
        mode: 'create',
        catalog: Array.from(
          { length: 1000 },
          (_, n) => 'Existing topic ' + String(n).padStart(5, '0')
        )
      }
    },
    actual = tagReviewPromptSize(checked)
  const smaller = promptContext(checked, 1048576)
  assert.ok(actual > smaller)
  const config = { ...executionConfig(p, runtime), contextTokens: smaller }
  let called = false
  await assert.rejects(
    generateRouted(checked, config, {
      cloudKey: runtime.cloudKey,
      fetcher: async () => {
        called = true
        throw Error('must not send')
      }
    }),
    /context capacity/
  )
  assert.equal(called, false)
})
