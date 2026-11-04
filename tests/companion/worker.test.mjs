import { WorkflowError } from '../../src/domain/errors.ts'
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { samples } from '../../src/domain/samples.ts'
import { defaultPolicy, validateBundle } from '../../src/domain/review.ts'
import { ProposalJournal } from '../../companion/journal.mjs'
import { generateProposal, localEndpoint, listModels } from '../../companion/ollama.mjs'
import { defaultFilingRules } from '../../src/domain/filing.ts'
import { suggestMetadata } from '../../src/domain/metadata.ts'
const input = () => {
  const { proposal, ...b } = samples()[0]
  return b
}
const config = { endpoint: 'http://127.0.0.1:11434', model: 'test-local', policy: defaultPolicy() }
const reply = () =>
  new Response(
    JSON.stringify({ done: true, message: { content: JSON.stringify(samples()[0].proposal) } })
  )
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-'))
  const path = join(dir, 'jobs.sqlite3')
  return { dir, path, j: new ProposalJournal(path) }
}
test('persists completed proposals across process objects without replay', async () => {
  const s = setup()
  let calls = 0
  try {
    const planner = async () => {
      calls++
      return validateBundle(samples()[0])
    }
    const a = await s.j.prepare(input(), config, { planner })
    s.j.close()
    s.j = new ProposalJournal(s.path)
    const b = await s.j.prepare(input(), config, { planner })
    assert.equal(b.cached, true)
    assert.equal(a.id, b.id)
    assert.equal(calls, 1)
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('scopes jobs by account, Space, resource, ETag, bytes and input text', async () => {
  const s = setup()
  try {
    const ids = new Set()
    const planner = async (i) => validateBundle({ ...i, proposal: samples()[0].proposal })
    ids.add((await s.j.prepare(input(), config, { planner })).id)
    for (const key of ['account', 'space', 'resourceId', 'etag', 'sha256']) {
      const i = input()
      i.source[key] = key === 'sha256' ? 'd'.repeat(64) : 'other'
      ids.add((await s.j.prepare(i, config, { planner })).id)
    }
    assert.equal(ids.size, 6)
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('holds image-only pages without a model call', async () => {
  const s = setup()
  try {
    const { proposal, ...i } = samples()[2]
    const r = await s.j.prepare(i, config, {
      planner: () => {
        throw new Error('must not call')
      }
    })
    assert.equal(r.review.state, 'needs_ocr')
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('failures require an explicit retry for every further attempt and never trigger fallback', async () => {
  const s = setup()
  let calls = 0
  try {
    const planner = async () => {
      calls++
      throw new Error('offline')
    }
    await assert.rejects(s.j.prepare(input(), config, { planner }))
    await assert.rejects(s.j.prepare(input(), config, { planner }), /explicit retry/)
    for (let n = 0; n < 2; n++)
      await assert.rejects(s.j.prepare(input(), config, { planner, retry: true }))
    await assert.rejects(s.j.prepare(input(), config, { planner, retry: true }), /offline/)
    assert.equal(calls, 4)
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('does not steal a running request or repeat a concurrent request', async () => {
  const s = setup()
  let release
  try {
    const pending = s.j.prepare(input(), config, {
      planner: () =>
        new Promise((r) => {
          release = r
        })
    })
    await assert.rejects(s.j.prepare(input(), config, { retry: true }), /still running/)
    release(validateBundle(samples()[0]))
    await pending
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('rejects unsupported evidence and enforces AI Off switches', async () => {
  const s = setup()
  try {
    await assert.rejects(
      s.j.prepare(input(), { ...config, policy: { ...defaultPolicy(), aiInput: 'off' } }),
      /enabled/
    )
    const b = samples()[0]
    b.proposal.issuer.value = 'Invented city'
    await assert.rejects(
      s.j.prepare(input(), config, { planner: async () => ({ bundle: b }) }),
      /Fact/
    )
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('adapter uses structured output, no redirects, and validates actual quotes', async () => {
  let payload
  const r = await generateProposal(input(), 'test-local', config.endpoint, async (url, options) => {
    if (url.endsWith('/api/tags'))
      return new Response(JSON.stringify({ models: [{ name: 'test-local' }] }))
    assert.match(url, /\/api\/chat$/)
    assert.equal(options.redirect, 'error')
    payload = JSON.parse(options.body)
    return reply()
  })
  assert.equal(payload.stream, false)
  assert.equal(payload.think, false)
  assert.equal(payload.format.additionalProperties, false)
  assert.equal(r.state, 'needs_review')
  assert.equal(r.excluded[0].value, 'Japanese')
})
test('zero AI tags use valid empty-array structured output while independent metadata aliases still work', async () => {
  const i = input(),
    rules = defaultFilingRules(),
    proposal = structuredClone(samples()[0].proposal)
  rules.tags = []
  i.rules = rules
  i.pages[0] += '\nName: Example'
  proposal.tags = []
  let format
  const emptyEnum = (value) =>
    !!value &&
    typeof value === 'object' &&
    ((Array.isArray(value.enum) && value.enum.length === 0) || Object.values(value).some(emptyEnum))
  const result = await generateProposal(i, 'test-local', config.endpoint, async (url, options) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test-local' }] })
    format = JSON.parse(options.body).format
    if (emptyEnum(format))
      return Response.json({ error: 'enum must contain at least one value' }, { status: 400 })
    return Response.json({ done: true, message: { content: JSON.stringify(proposal) } })
  })
  assert.equal(format.properties.tags.maxItems, 0)
  assert.equal(Object.hasOwn(format.properties.tags.items.properties.value, 'enum'), false)
  assert.equal(result.state, 'needs_review')
  assert.deepEqual(result.proposal.tags, [])
  assert.deepEqual(
    suggestMetadata(
      { fields: [], tags: [{ tag: 'Person: Example', terms: ['Example'], match: 'name' }] },
      i.pages
    ).tags.map((tag) => tag.value),
    ['Person: Example']
  )
  assert.throws(
    () =>
      validateBundle({
        ...i,
        proposal: {
          ...proposal,
          tags: [{ value: 'Synthetic', evidence: [{ page: 1, quote: 'SYNTHETIC DOCUMENT' }] }]
        }
      }),
    /Invalid tag proposals/
  )
})
test('restricts endpoints and local models, and rejects incomplete responses', async () => {
  for (const u of [
    'https://hosted.example',
    'http://169.254.169.254',
    'http://192.168.1.2?key=secret',
    'http://user:pass@localhost'
  ])
    assert.throws(() => localEndpoint(u))
  await assert.rejects(generateProposal(input(), 'example:cloud', config.endpoint), /model/)
  await assert.rejects(
    generateProposal(
      input(),
      'test',
      config.endpoint,
      async (url) =>
        new Response(
          JSON.stringify(
            url.endsWith('/api/tags')
              ? { models: [{ name: 'test' }] }
              : { done: false, message: { content: '{}' } }
          )
        )
    ),
    /Incomplete/
  )
  const models = await listModels(
    config.endpoint,
    async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: 'local' },
            { name: 'remote:cloud' },
            { name: 'alias', remote_host: 'cloud.example' }
          ]
        })
      )
  )
  assert.deepEqual(
    models.map((m) => m.name),
    ['local']
  )
})
test('refuses a provider result that changes scope or extracted evidence', async () => {
  const s = setup()
  try {
    const changed = samples()[0]
    changed.source.account = 'other'
    await assert.rejects(
      s.j.prepare(input(), config, { planner: async () => validateBundle(changed) }),
      /changed source/
    )
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('one evidence correction can recover literal facts, but a second unsupported response remains held', async () => {
  const bad = structuredClone(samples()[0].proposal)
  bad.issuer.value = 'Invented issuer'
  for (const recover of [true, false]) {
    let calls = 0
    const fetcher = async (url, options) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test-local' }] })
      calls++
      const body = JSON.parse(options.body)
      if (calls === 2) {
        assert.equal(body.messages.length, 4)
        assert.match(body.messages[3].content, /Fact is not present/)
        assert.match(body.messages[3].content, /not copied from their evidence: issuer/)
      }
      return Response.json({
        done: true,
        message: { content: JSON.stringify(calls === 2 && recover ? samples()[0].proposal : bad) }
      })
    }
    if (recover)
      assert.equal(
        (await generateProposal(input(), 'test-local', config.endpoint, fetcher)).state,
        'needs_review'
      )
    else
      await assert.rejects(
        generateProposal(input(), 'test-local', config.endpoint, fetcher),
        /Fact is not present/
      )
    assert.equal(calls, 2)
  }
})

test('configured taxonomy uses one language profile without default-folder instructions', async () => {
  const { systemFor } = await import('../../companion/ollama.mjs'),
    i = input()
  i.rules = defaultFilingRules()
  const prompt = systemFor(i)
  assert.equal(prompt.split('"dateFormats"').length - 1, 1)
  assert.equal(
    prompt.includes('Prefer the most specific supported Utilities category over generic Finance'),
    false
  )
  assert.match(prompt, /kind is a printed document title/)
})
test('one bounded correction can replace a tax-year-only date with an actual full printed date, but cannot invent missing components', async () => {
  const i = input()
  i.pages[0] += 'Tax year: 2026\n'
  const wrong = structuredClone(samples()[0].proposal)
  wrong.date = { value: '2026', evidence: [{ page: 1, quote: 'Tax year: 2026' }] }
  for (const recover of [true, false]) {
    let calls = 0
    const fetcher = async (url, options) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test-local' }] })
      calls++
      if (calls === 2)
        assert.match(JSON.parse(options.body).messages[3].content, /do not invent a month or day/)
      return Response.json({
        done: true,
        message: { content: JSON.stringify(calls === 2 && recover ? samples()[0].proposal : wrong) }
      })
    }
    if (recover)
      assert.equal(
        (await generateProposal(i, 'test-local', config.endpoint, fetcher)).state,
        'needs_review'
      )
    else
      await assert.rejects(
        generateProposal(i, 'test-local', config.endpoint, fetcher),
        /Unsupported printed date/
      )
    assert.equal(calls, 2)
  }
})
test('production fallback prepares a manual review for unsupported facts, dates and capacity without accepting the failed proposal', async () => {
  for (const [code, message] of [
    ['FACT_NOT_LITERAL', 'Fact is not present in its evidence'],
    ['DATE_UNSUPPORTED', 'Unsupported printed date format; add an explicit language/date rule'],
    [
      'WORKFLOW_CONTEXT_CAPACITY',
      'Document exceeds configured model context capacity; increase it in Processing settings or select a model with a larger context'
    ]
  ]) {
    const s = setup()
    let calls = 0
    try {
      const options = {
          manualFallback: true,
          planner: async () => {
            calls++
            throw new WorkflowError(code, message)
          }
        },
        r = await s.j.prepare(input(), config, options)
      assert.equal(r.review.state, 'needs_details')
      assert.equal(r.review.proposal, null)
      assert.equal(JSON.parse(s.j.get(r.id).result).proposal, null)
      assert.equal(s.j.get(r.id).state, 'needs_details')
      assert.equal((await s.j.prepare(input(), config, options)).cached, true)
      assert.equal(calls, 1)
    } finally {
      s.j.close()
      rmSync(s.dir, { recursive: true })
    }
  }
})
test('manual fallback does not hide transient service errors or a provider changing source identity', async () => {
  const s = setup()
  try {
    for (const message of [
      'fetch failed',
      'Provider result changed source identity or extracted pages'
    ])
      await assert.rejects(
        s.j.prepare(
          input(),
          { ...config, model: message },
          {
            manualFallback: true,
            planner: async () => {
              throw Error(message)
            }
          }
        ),
        new RegExp(message)
      )
    assert.equal(
      s.j.db.prepare("select count(*) n from proposals where state='needs_details'").get().n,
      0
    )
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
test('pages still unreadable after an OCR attempt reach manual review without calling AI; OCR-off inputs remain held', async () => {
  for (const ocrAttempted of [false, true]) {
    const s = setup()
    try {
      const { proposal, ...i } = samples()[2],
        r = await s.j.prepare(i, config, {
          manualFallback: true,
          ocrAttempted,
          planner: () => assert.fail('Unreadable text must never call AI')
        })
      assert.equal(r.review.state, ocrAttempted ? 'needs_details' : 'needs_ocr')
      assert.equal(r.review.proposal, null)
      if (ocrAttempted) assert.equal(r.review.bundle.manualReview.reason, 'text')
    } finally {
      s.j.close()
      rmSync(s.dir, { recursive: true })
    }
  }
})
test('model requests retain all source pages but offer only categories and tags with supportable source terms', async () => {
  const { classificationOptions, schemaFor, systemFor } =
      await import('../../companion/ollama.mjs'),
    { defaultFilingRules } = await import('../../src/domain/filing.ts'),
    i = input()
  i.rules = defaultFilingRules()
  i.rules.folders = [
    { value: 'Vehicles', terms: ['自動車検査証'], match: 'substring' },
    { value: 'Unrelated', terms: ['Absent keyword'], match: 'word' },
    { value: 'Other', terms: [], match: 'word' }
  ]
  i.rules.tags = [
    { value: 'Car', terms: ['自動車検査証'], match: 'substring' },
    { value: 'Absent tag', terms: ['Absent keyword'], match: 'word' }
  ]
  i.pages[0] += '\n自 動 車 検 査 証 記 録 事 項'
  const before = JSON.stringify(i),
    options = classificationOptions(i)
  assert.deepEqual(
    options.folders.map((r) => r.value),
    ['Vehicles', 'Other']
  )
  assert.deepEqual(schemaFor(i).properties.folder.properties.value.enum, ['Vehicles', 'Other'])
  assert.deepEqual(schemaFor(i).properties.tags.items.properties.value.enum, ['Car'])
  assert.equal(systemFor(i).includes('Absent keyword'), false)
  assert.equal(JSON.stringify(i), before)
})

test('asks for independent evidenced topic and type tags without manufacturing extra tags', async () => {
  const { systemFor } = await import('../../companion/ollama.mjs'),
    i = input()
  i.rules = defaultFilingRules()
  for (const prompt of [systemFor(i), systemFor(input())]) {
    assert.match(prompt, /Consider every supplied tag independently/)
    assert.match(prompt, /folder choice does not replace a subject tag/)
    assert.match(prompt, /Do not stop after one tag or add tags merely to reach a count/)
    assert.match(prompt, /Include only tags supported by the quoted text/)
  }
})

test('semantic tag schema reuses the complete authenticated directory or permits bounded new names only in create mode', async () => {
  const { schemaFor, systemFor } = await import('../../companion/ollama.mjs'),
    i = input()
  i.tagDiscovery = { mode: 'existing', catalog: ['Vehicles', 'Registration'] }
  let schema = schemaFor(i)
  assert.deepEqual(schema.properties.tags.items.properties.value.enum, ['Vehicles', 'Registration'])
  assert.match(systemFor(i), /same or a closely related concept/)
  assert.match(systemFor(i), /Never propose a new name/)
  i.tagDiscovery.mode = 'create'
  schema = schemaFor(i)
  assert.equal(schema.properties.tags.items.properties.value.enum, undefined)
  assert.equal(schema.properties.tags.items.properties.value.maxLength, 80)
  assert.match(systemFor(i), /Do not create synonyms/)
  assert.match(systemFor(i), /exact source quotation/)
  i.tagDiscovery = { mode: 'existing', catalog: [] }
  assert.equal(schemaFor(i).properties.tags.maxItems, 0)
})

test('invalid explicit planner never falls through to a network provider', async () => {
  const s = setup(),
    originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    throw new Error('unexpected network call')
  }
  try {
    await assert.rejects(s.j.prepare(input(), config, { planner: false }), /not a function/)
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})

test('non-Error provider failures persist a failed attempt and release ownership', async () => {
  const s = setup()
  try {
    for (const value of [null, undefined, 'synthetic failure']) {
      await assert.rejects(
        s.j.prepare(input(), config, {
          retry: true,
          manualFallback: true,
          planner: async () => {
            throw value
          }
        }),
        (error) => error === value
      )
      const row = s.j.db.prepare('SELECT state,owner,result FROM proposals').get()
      assert.equal(row.state, 'failed')
      assert.equal(row.owner, null)
      assert.equal(row.result, null)
      assert.equal(s.j.runtime.proposals.size, 0)
    }
  } finally {
    s.j.close()
    rmSync(s.dir, { recursive: true })
  }
})
