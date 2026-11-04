// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultPolicy, reviewDigest, validateBundle } from '../../src/domain/review.ts'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
test('new scanned arrival → background OCR → review → approved filing → custom metadata → restart, without duplicate mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-full-')),
    database = join(dir, 'db.sqlite3')
  let j = new ProposalJournal(database),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity(),
    m = new Metadata(w),
    file = api.addScannedFixture(),
    original = await api.get(file.path)
  m.saveSchema(actor, {
    fields: [
      {
        id: 'invoice_number',
        label: 'Invoice number',
        type: 'text',
        aliases: ['Invoice number'],
        choices: []
      },
      { id: 'amount', label: 'Amount', type: 'number', aliases: ['Amount'], choices: [] },
      { id: 'due', label: 'Due date', type: 'date', aliases: ['Due date'], choices: [] }
    ],
    tags: [{ tag: 'Household', terms: ['Electricity'] }]
  })
  const config = {
    endpoint: 'http://127.0.0.1:11434',
    model: 'fixture-model',
    policy: { ...defaultPolicy(), ocr: 'suggest' },
    ocrLanguages: ['eng']
  }
  const planner = async (input) => {
    const c = (value, quote = value) => ({ value, evidence: [{ page: 1, quote }] })
    return validateBundle({
      ...input,
      proposal: {
        issuer: c('Example Electricity Company'),
        date: c('2026-10-29'),
        kind: c('Electricity invoice'),
        folder: c('Utilities/Electricity', 'Electricity invoice'),
        tags: [c('Electricity', 'Electricity invoice')]
      }
    })
  }
  const originalPrepare = j.prepare.bind(j)
  j.prepare = (i, c, o) => originalPrepare(i, c, { ...o, planner })
  let now = 1000000
  const intake = new Intake(w, {
    now: () => now,
    prepare: (actor, api, path, options) => w.prepare(actor, api, path, config, options)
  })
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  try {
    await intake.tick({ force: true })
    now += 3000
    await intake.tick({ force: true })
    const queued = intake.status(actor).queue.find((r) => r.resource === file.resourceId)
    assert.equal(queued.state, 'prepared')
    assert.equal(w.decision(actor, queued.job), undefined)
    const job = w.job(actor, queued.job),
      review = validateBundle(JSON.parse(job.result)),
      detail = await m.get(actor, api, file.path)
    assert.equal(detail.suggestions.fields.invoice_number.value, 'TEST-42')
    assert.equal(detail.suggestions.fields.amount.value, 120.5)
    assert.equal(detail.suggestions.fields.due.value, '2026-11-30')
    const fields = Object.fromEntries(
      Object.entries(detail.suggestions.fields).map(([k, c]) => [k, c.value])
    )
    await m.save(actor, api, {
      path: file.path,
      resourceId: file.resourceId,
      etag: detail.source.etag,
      sha256: detail.source.sha256,
      version: 0,
      fields,
      addTags: ['Household', 'Reviewed']
    })
    await w.approve(
      actor,
      api,
      queued.job,
      config.policy,
      await reviewDigest(review, config.policy)
    )
    const done = await w.apply(actor, api, queued.job)
    assert.equal(done.state, 'done')
    assert.equal(sha(await api.get(done.target)), sha(original))
    assert.equal((await m.get(actor, api, done.target)).record.fields.invoice_number, 'TEST-42')
    assert.ok((await api.stat(done.target)).tags.includes('Household'))
    assert.equal(
      intake.status(actor).queue.find((r) => r.resource === file.resourceId).decision,
      'done'
    )
    const copy = api.addScannedFixture()
    now += 10000
    await intake.tick({ force: true })
    now += 3000
    await intake.tick({ force: true })
    assert.equal(
      intake.status(actor).queue.find((r) => r.resource === copy.resourceId).state,
      'duplicate'
    )
    j.close()
    j = new ProposalJournal(database)
    w = new Workflow(j)
    api = new DemoAdapter(j.db)
    let writes = 0
    api.move = api.addTags = async () => {
      writes++
      throw new Error('no replay')
    }
    assert.equal((await w.apply(actor, api, queued.job)).state, 'done')
    assert.equal(writes, 0)
    assert.equal(new Metadata(w).read(actor, file.resourceId).fields.amount, 120.5)
    assert.equal(
      w.history(actor).filter((e) => e.kind === 'done' && e.job === queued.job).length,
      1
    )
  } finally {
    await intake.stop()
    j.close()
    rmSync(dir, { recursive: true })
  }
})
