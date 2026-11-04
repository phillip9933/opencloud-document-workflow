// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from './helpers/workflow.mjs'
import { Metadata } from '../../companion/metadata.mjs'
import { Transfers } from '../../companion/transfers.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultFilingRules } from '../../src/domain/filing.ts'
import {
  defaultPolicy,
  validateBundle,
  validateDocumentInput,
  reviewDigest,
  createApproval
} from '../../src/domain/review.ts'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-original-')),
    j = new ProposalJournal(join(dir, 'state.sqlite3')),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  w.metadata = new Metadata(w)
  w.transfers = new Transfers(w)
  const actor = await api.identity(),
    bytes = Buffer.from('SYNTHETIC CAD ORIGINAL: never a PDF')
  j.db
    .prepare('insert into demo_files values(?,?,?,?,?,?)')
    .run('Inbox/design.dwg', 'cad-fixture', '"original-v1"', '["Keep"]', 0, bytes)
  w.configuration = {
    settings: () => ({ rules: { ...defaultFilingRules(), root: 'Docs' }, limits: { maxMiB: 100 } }),
    destinationSpace: () => actor.space
  }
  return {
    dir,
    j,
    w,
    api,
    actor,
    bytes,
    input: { path: 'Inbox/design.dwg', resourceId: 'cad-fixture', etag: '"original-v1"' },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('manual original-format filing uses no extraction or AI, requires exact approval, and preserves bytes and format', async () => {
  const s = await setup()
  try {
    const result = await s.w.prepareOriginal(s.actor, s.api, s.input),
      review = validateBundle(result.bundle),
      policy = defaultPolicy(),
      manual = { target: 'Docs/House/Plans/design.dwg', addTags: ['House'] }
    assert.equal(review.state, 'needs_details')
    assert.deepEqual(review.bundle.pages, [])
    assert.equal(review.proposal, null)
    assert.ok(await s.api.stat(s.input.path))
    await assert.rejects(s.w.apply(s.actor, s.api, result.id), /approval|decision/i)
    await assert.rejects(
      createApproval(review, policy, { ...manual, target: 'Docs/design.pdf' }),
      /original file format/
    )
    await s.w.approve(
      s.actor,
      s.api,
      result.id,
      policy,
      await reviewDigest(review, policy, manual),
      manual
    )
    assert.equal((await s.w.apply(s.actor, s.api, result.id)).state, 'done')
    assert.deepEqual(await s.api.get(manual.target), s.bytes)
    assert.equal(await s.api.stat(s.input.path), null)
    assert.ok((await s.api.stat(manual.target)).tags.includes('Keep'))
    assert.ok((await s.api.stat(manual.target)).tags.includes('House'))
    assert.equal(s.w.history(s.actor).filter((e) => e.kind === 'manual_filing_prepared').length, 1)
  } finally {
    s.close()
  }
})
test('native manual filing can use the existing verified cross-Space transfer without conversion', async () => {
  const s = await setup()
  try {
    s.w.configuration.destinationSpace = () => 'local-archive'
    const result = await s.w.prepareOriginal(s.actor, s.api, s.input),
      review = validateBundle(result.bundle),
      policy = defaultPolicy(),
      manual = { target: 'Docs/design.dwg', addTags: [] }
    await s.w.approve(
      s.actor,
      s.api,
      result.id,
      policy,
      await reviewDigest(review, policy, manual),
      manual
    )
    const done = await s.w.apply(s.actor, s.api, result.id)
    assert.equal(done.state, 'done')
    assert.deepEqual(await s.api.forSpace('local-archive').get(manual.target), s.bytes)
    assert.equal((await s.api.listTrash()).length, 1)
  } finally {
    s.close()
  }
})
test('manual original reviews cannot bypass PDF evidence requirements, stale identity or an existing approval', async () => {
  const s = await setup()
  try {
    await assert.rejects(
      s.w.prepareOriginal(s.actor, s.api, { ...s.input, etag: 'stale' }),
      /changed/
    )
    const result = await s.w.prepareOriginal(s.actor, s.api, s.input)
    assert.throws(
      () =>
        validateDocumentInput({ ...result.bundle, manualReview: undefined, proposal: undefined }),
      /Unexpected|fields/i
    )
    assert.throws(
      () =>
        validateBundle({
          ...result.bundle,
          source: { ...result.bundle.source, path: 'Inbox/fake.pdf' }
        }),
      /manual review/
    )
    assert.throws(
      () => validateBundle({ ...result.bundle, pages: ['invented text'] }),
      /manual review/
    )
    const policy = defaultPolicy(),
      manual = { target: 'Docs/design.dwg', addTags: [] }
    await s.w.approve(
      s.actor,
      s.api,
      result.id,
      policy,
      await reviewDigest(validateBundle(result.bundle), policy, manual),
      manual
    )
    await assert.rejects(s.w.prepareOriginal(s.actor, s.api, s.input), /existing operation/)
  } finally {
    s.close()
  }
})
