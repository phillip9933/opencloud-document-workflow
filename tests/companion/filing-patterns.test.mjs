// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { Automation } from '../../companion/automation.mjs'
import { Intake, defaultIntake } from '../../companion/intake.mjs'
import { Configuration, defaultLimits } from '../../companion/configuration.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultAIConfig } from '../../src/domain/ai.ts'
import { defaultFilingRules } from '../../src/domain/filing.ts'
import { defaultPolicy, validateBundle, reviewDigest } from '../../src/domain/review.ts'

// Real, complete one-page ASCII PDFs exercise extraction and source hashes;
// only the model planner is replaced with deterministic quoted fixture facts.
function textPDF(lines) {
  const literal = (value) =>
    value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const stream =
    'BT /F1 12 Tf 50 750 Td 16 TL\n' +
    lines.map((line) => '(' + literal(line) + ') Tj T*').join('\n') +
    '\nET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += index + 1 + ' 0 obj\n' + object + '\nendobj\n'
  }
  const xref = Buffer.byteLength(output)
  output +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF\n'
  return Buffer.from(output)
}
async function setup({ receipt = false, yearLines = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-filing-pattern-')),
    path = join(dir, 'db.sqlite3'),
    journal = new ProposalJournal(path),
    workflow = new Workflow(journal),
    metadata = new Metadata(workflow),
    api = new DemoAdapter(journal.db)
  api.seed()
  journal.db.prepare('delete from demo_files where folder=0').run()
  const actor = await api.identity(),
    policy = Object.fromEntries(Object.keys(defaultPolicy()).map((key) => [key, 'automatic'])),
    kind = receipt ? 'Purchase receipt' : 'Tax return',
    issuer = receipt ? 'Example Shop' : 'Example Tax Agency'
  const bytes = textPDF([
    'SYNTHETIC DOCUMENT',
    'Issuer: ' + issuer,
    'Document type: ' + kind,
    'Issue date: 2026-10-29',
    ...yearLines
  ])
  const uploaded = await api.put('Inbox/fixture.pdf', bytes),
    configuration = new Configuration(workflow),
    rules = defaultFilingRules()
  rules.root = 'Archive'
  rules.folders = [
    {
      value: receipt ? 'Receipts' : 'Taxes/United States',
      terms: [kind],
      match: 'word',
      folderTemplate: receipt ? '{category}/{year}' : '{category}/{taxYear}',
      ...(!receipt ? { taxYearLabels: ['Tax year'] } : {})
    },
    { value: 'Other', terms: [], match: 'word' }
  ]
  rules.tags = [{ value: 'Synthetic', terms: ['SYNTHETIC DOCUMENT'], match: 'word' }]
  workflow.savePreference(actor, { policy, ai: defaultAIConfig() })
  metadata.saveSchema(actor, { fields: [], tags: [] })
  let now = 1000000,
    plannerCalls = 0,
    automation
  const intake = new Intake(workflow, {
    now: () => now,
    prepare: (actor, api, path) =>
      workflow.prepare(actor, api, path, {
        endpoint: 'http://127.0.0.1:11434',
        model: 'fixture-model',
        policy
      }),
    processPrepared: (...args) => automation.run(...args),
    resume: (...args) => automation.resume(...args)
  })
  configuration.save(actor, { rules, limits: defaultLimits() })
  automation = new Automation(workflow, metadata, intake)
  const prepare = journal.prepare.bind(journal)
  journal.prepare = (input, settings, options) =>
    prepare(input, settings, {
      ...options,
      planner: async (checked) => {
        plannerCalls++
        const claim = (value, quote = value) => ({ value, evidence: [{ page: 1, quote }] })
        return validateBundle({
          ...checked,
          proposal: {
            issuer: claim(issuer),
            date: claim('2026-10-29'),
            kind: claim(kind),
            folder: claim(rules.folders[0].value, kind),
            tags: [claim('Synthetic', 'SYNTHETIC DOCUMENT')]
          }
        })
      }
    })
  const writes = { mkdir: 0, move: 0, tags: 0 }
  for (const [method, key] of [
    ['mkdir', 'mkdir'],
    ['move', 'move'],
    ['addTags', 'tags']
  ]) {
    const original = api[method].bind(api)
    api[method] = async (...args) => {
      writes[key]++
      return original(...args)
    }
  }
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  return {
    journal,
    workflow,
    metadata,
    configuration,
    api,
    actor,
    policy,
    intake,
    automation,
    bytes,
    writes,
    resourceId: uploaded.resourceId,
    get plannerCalls() {
      return plannerCalls
    },
    get id() {
      return intake.status(actor).queue.find((row) => row.resource === uploaded.resourceId)?.job
    },
    async arrivals() {
      await intake.tick({ force: true })
      now += 3000
      await intake.tick({ force: true })
    },
    close() {
      intake.stop()
      journal.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('category-specific receipt pattern survives real PDF preparation and files by document year automatically', async () => {
  const s = await setup({ receipt: true })
  try {
    await s.arrivals()
    assert.equal(s.plannerCalls, 1)
    const decision = s.workflow.decision(s.actor, s.id),
      approval = JSON.parse(decision.record),
      target = 'Archive/Receipts/2026/2026-10-29 Example Shop Purchase receipt.pdf'
    assert.equal(decision.state, 'done')
    assert.equal(approval.actions.target, target)
    assert.equal(approval.automaticAuthorization.kind, 'automatic')
    assert.equal(s.writes.move, 1)
    assert.equal(s.writes.tags, 1)
    assert.equal(await s.api.stat('Inbox/fixture.pdf'), null)
    assert.deepEqual(await s.api.get(target), s.bytes)
    assert.deepEqual((await s.api.stat(target)).tags, ['Synthetic'])
    await s.intake.tick({ force: true })
    assert.equal(s.writes.move, 1)
  } finally {
    s.close()
  }
})
test('tax-year pattern uses explicit prior tax year through preparation and automatic filing', async () => {
  const s = await setup({ yearLines: ['Tax year: 2025'] })
  try {
    await s.arrivals()
    const decision = s.workflow.decision(s.actor, s.id),
      approval = JSON.parse(decision.record)
    assert.equal(decision.state, 'done')
    assert.equal(
      approval.actions.target,
      'Archive/Taxes/United States/2025/2026-10-29 Example Tax Agency Tax return.pdf'
    )
    assert.equal(s.writes.move, 1)
    assert.equal(s.writes.tags, 1)
    assert.deepEqual(await s.api.get(approval.actions.target), s.bytes)
  } finally {
    s.close()
  }
})
for (const [name, yearLines] of [
  ['missing', []],
  ['conflicting', ['Tax year: 2025', 'Tax year: 2024']]
])
  test(
    name +
      ' tax year holds before folder/file/tag writes and an explicit manual destination recovers',
    async () => {
      const s = await setup({ yearLines })
      try {
        await s.arrivals()
        assert.equal(s.plannerCalls, 1)
        assert.equal(s.automation.statusFor(s.actor, s.id).state, 'held')
        assert.match(s.automation.statusFor(s.actor, s.id).detail, /tax year/)
        assert.equal(s.workflow.decision(s.actor, s.id), undefined)
        assert.deepEqual(s.writes, { mkdir: 0, move: 0, tags: 0 })
        assert.deepEqual(await s.api.get('Inbox/fixture.pdf'), s.bytes)
        assert.equal((await s.automation.takeOver(s.actor, s.api, s.id)).state, 'review')
        const review = validateBundle(JSON.parse(s.workflow.job(s.actor, s.id).result)),
          manual = {
            target: 'Archive/Taxes/United States/2025/Reviewed tax return.pdf',
            addTags: ['Synthetic']
          }
        await s.workflow.approve(
          s.actor,
          s.api,
          s.id,
          s.policy,
          await reviewDigest(review, s.policy, manual),
          manual
        )
        assert.equal((await s.workflow.apply(s.actor, s.api, s.id)).state, 'done')
        assert.equal(s.writes.move, 1)
        assert.equal(s.writes.tags, 1)
        const record = JSON.parse(s.workflow.decision(s.actor, s.id).record)
        assert.equal(record.automaticAuthorization, undefined)
        assert.ok(record.reviewedAt)
        assert.deepEqual(await s.api.get(manual.target), s.bytes)
      } finally {
        s.close()
      }
    }
  )
