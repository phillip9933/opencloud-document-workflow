// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createWorkflowAPI } from '../../companion/draft-api.mjs'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Configuration, defaultLimits, validateLimits } from '../../companion/configuration.mjs'
import { createDocumentPreview } from '../../companion/document-preview.mjs'
import { conversionServer } from '../../companion/conversion-server.mjs'
import { createPDFWorkerClient } from '../../companion/pdf-worker-client.mjs'
import { OpenCloudAdapter } from '../../companion/opencloud.mjs'
import { localEndpoint } from '../../companion/provider-routing.mjs'
import { retireExtractedText } from '../../companion/text-retention.mjs'
import { validateSpace } from '../../src/domain/review.ts'

const actor = { server: 'https://example.invalid', account: 'fixture', space: 'storage$project' }

test('Space IDs reject dot segments consistently without rejecting OpenCloud IDs', () => {
  for (const space of ['.', '..']) {
    assert.throws(() => validateSpace(space), /Invalid Space/)
    assert.throws(
      () => new OpenCloudAdapter({ origin: actor.server, space, token: 'fixture' }),
      /Invalid configured Space ID/
    )
  }
  assert.equal(validateSpace(actor.space), actor.space)
})

test('legacy capacity is capped on read and new oversized limits cannot be saved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-hardening-'))
  const journal = new ProposalJournal(join(directory, 'journal.db'))
  try {
    const workflow = new Workflow(journal)
    const config = new Configuration(workflow)
    journal.db
      .prepare('insert into processing_settings values(?,?,?)')
      .run(
        workflow.scope(actor),
        JSON.stringify(config.settings(actor).rules),
        JSON.stringify({ ...defaultLimits(), maxMiB: 1024 })
      )
    assert.equal(config.settings(actor).limits.maxMiB, 100)
    assert.throws(() => validateLimits({ ...defaultLimits(), maxMiB: 101 }), /capacity/)
  } finally {
    journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preview streams a pinned response, bounds concurrent requests across Spaces and cancels on disconnect', async () => {
  let upstream
  const opened = Promise.withResolvers()
  let cancelled = false
  const res = new EventEmitter()
  res.setHeader = () => {}
  res.write = (bytes) => {
    assert.equal(Buffer.from(bytes).toString(), '%PDF-')
    return true
  }
  res.end = () => {}
  const documentAPI = {
    async stat() {
      return { etag: '"v1"', size: 5 }
    },
    async get() {
      assert.fail('preview must not buffer the remote file')
    },
    async openDownload(path, etag) {
      assert.equal(path, 'Inbox/test.pdf')
      assert.equal(etag, '"v1"')
      const response = new Response(
        new ReadableStream({
          start(controller) {
            upstream = controller
          },
          cancel() {
            cancelled = true
          }
        })
      )
      opened.resolve()
      return response
    }
  }
  const preview = createDocumentPreview({ settings: () => ({ limits: defaultLimits() }) })
  const input = { actor, documentAPI, res, body: { path: 'Inbox/test.pdf' } }
  const pending = preview(input)
  await opened.promise
  await assert.rejects(preview({ ...input, actor: { ...actor, space: 'another' } }), {
    code: 'WORKFLOW_BUSY'
  })
  upstream.enqueue(Buffer.from('%PDF-'))
  res.destroyed = true
  res.emit('close')
  await pending
  assert.equal(cancelled, true)
})

test('worker parses embedded text and OCRs a synthetic scan through the production client', async () => {
  const server = conversionServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    const parse = createPDFWorkerClient('http://converter:5180', (_url, options, handler) =>
      request('http://127.0.0.1:' + address.port + '/extract', options, handler)
    )
    let progress = 0
    const options = { limits: defaultLimits(), ocr: true, languages: ['eng'] }
    for (const [filename, scanned] of [
      ['english.pdf', false],
      ['scanned-english.pdf', true]
    ]) {
      const result = await parse(
        readFileSync(new URL('../fixtures/' + filename, import.meta.url)),
        options,
        () => progress++
      )
      assert.equal(result.ocrAttempted, scanned)
      assert.match(result.pages.join(' '), /invoice|synthetic/i)
    }
    assert.equal(progress, 1)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('text retention preserves unfinished reviews and uncertain writes, and keeps completed filing history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-hardening-'))
  const journal = new ProposalJournal(join(directory, 'journal.db'))
  try {
    const db = journal.db
    const scope = new Workflow(journal).scope(actor)
    const old = '2025-01-01T00:00:00.000Z'
    const input = { source: { resourceId: 'synthetic' }, pages: ['private extracted pages'] }
    const result = { ...input, proposal: { kind: { value: 'invoice' } } }
    for (const [id, state] of [
      ['filed', 'done'],
      ['uncertain', 'move_intent'],
      ['review', null]
    ]) {
      db.prepare(
        'insert into proposals(id,scope,input,configuration,state,result,raw,updated) values(?,?,?,?,?,?,?,?)'
      ).run(id, scope, JSON.stringify(input), '{}', 'prepared', JSON.stringify(result), '{}', old)
      if (state)
        db.prepare('insert into decisions(job,actor,record,state,updated) values(?,?,?,?,?)').run(
          id,
          actor.account,
          '{}',
          state,
          old
        )
    }
    assert.equal(retireExtractedText(db, 90, Date.parse('2026-01-01')), 1)
    assert.equal(retireExtractedText(db, 90, Date.parse('2026-01-01')), 0)
    const row = journal.get('filed')
    assert.deepEqual(JSON.parse(row.input).pages, [])
    assert.equal(JSON.parse(row.result).pages, undefined)
    assert.deepEqual(JSON.parse(row.result).proposal, result.proposal)
    assert.equal(row.raw, null)
    assert.equal(db.prepare('select state from decisions where job=?').get('filed').state, 'done')
    for (const id of ['review', 'uncertain'])
      assert.deepEqual(JSON.parse(journal.get(id).input).pages, input.pages)
  } finally {
    journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('local endpoint requires a private address or an explicitly allowed hostname', () => {
  assert.throws(() => localEndpoint('http://10.example.invalid:11434'), /private-network/)
  assert.throws(() => localEndpoint('http://ollama:11434'), /private-network/)
  assert.equal(localEndpoint('http://192.168.1.10:11434'), 'http://192.168.1.10:11434')
})

test('an operator allowlist checks verified identities before consuming a request or attaching background processing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-access-'))
  const api = createWorkflowAPI({
    mode: 'live',
    origin: actor.server,
    space: actor.space,
    allowOrigin: actor.server,
    allowedAccounts: ['allowed-fixture'],
    database: join(directory, 'workflow.db'),
    adapterFactory: () => ({
      identity: async () => actor
    }),
    logger: () => {}
  })
  try {
    const req = {
      url: '/_workflow/api/status',
      method: 'POST',
      headers: { host: 'example.invalid', origin: actor.server, authorization: 'Bearer fixture' },
      [Symbol.asyncIterator]() {
        assert.fail('a disallowed account must not consume the request body')
      }
    }
    let status
    await api.handle(req, {
      writeHead: (code) => {
        status = code
      },
      end: () => {}
    })
    assert.equal(status, 403)
    await assert.rejects(api.attach({ identity: async () => actor }), { code: 'ACCESS_DENIED' })
  } finally {
    api.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('OCR caps total elapsed work and holds the entire selection before rasterizing', async () => {
  const { ocrTimeout, ocrPages } = await import('../../companion/ocr.mjs')
  assert.throws(() => ocrTimeout(performance.now() - 1, 30000), /time limit/)
  assert.ok(ocrTimeout(performance.now() + 500, 30000) <= 500)
  await assert.rejects(ocrPages(Buffer.alloc(0), Array(65).fill(''), ['eng']), /64 pages/)
})
