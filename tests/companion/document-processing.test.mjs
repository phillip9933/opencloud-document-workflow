// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import {
  preparationState,
  processingIssue,
  preparationIssue
} from '../../companion/processing-issues.mjs'
import { defaultPolicy } from '../../src/domain/review.ts'
test('direct preparation exposes pinned stages and persists safe timeout diagnostics without approving or writing files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-progress-')),
    j = new ProposalJournal(join(dir, 'journal')),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity(),
    source = await api.stat('Inbox/english.pdf')
  let finish, started
  const ready = new Promise((resolve) => (started = resolve))
  j.prepare = async (input, configuration, options) => {
    options.onProgress('tagging')
    started()
    await new Promise((resolve) => (finish = resolve))
    throw Object.assign(new Error('provider body must stay private'), { name: 'TimeoutError' })
  }
  try {
    const pending = w.prepare(actor, api, source.path, {
      policy: defaultPolicy(),
      model: 'synthetic',
      endpoint: 'http://127.0.0.1:11434'
    })
    await ready
    const live = preparationState(w, actor, source)
    assert.equal(live.state, 'running')
    assert.equal(live.stage, 'tagging')
    assert.equal(processingIssue(w, actor, source), null)
    assert.equal(preparationState(w, { ...actor, account: 'other' }, source).state, 'idle')
    assert.equal(preparationState(w, actor, { ...source, etag: 'other' }).state, 'idle')
    finish()
    await assert.rejects(pending, /provider body/)
    const held = preparationState(w, actor, source)
    assert.equal(held.state, 'failed')
    assert.equal(held.processingIssue.message, 'Processing timed out.')
    assert.ok(!JSON.stringify(held).includes('provider body'))
    assert.equal(w.db.prepare('select count(*) n from decisions').get().n, 0)
    assert.equal((await api.stat(source.path)).etag, source.etag)
    const reopened = new Workflow(j)
    assert.equal(preparationState(reopened, actor, source).state, 'failed')
  } finally {
    j.close()
    rmSync(dir, { recursive: true })
  }
})
test('an abandoned attempt is interrupted rather than displayed as indefinitely running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-interrupted-')),
    j = new ProposalJournal(join(dir, 'journal')),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity(),
    source = await api.stat('Inbox/english.pdf')
  try {
    j.db
      .prepare('insert into preparation_attempts values(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        w.scope(actor),
        actor.space,
        source.resourceId,
        source.etag,
        'running',
        'ocr',
        null,
        null,
        '2026-01-01',
        '2026-01-01',
        'missing-owner'
      )
    const result = preparationState(w, actor, source)
    assert.equal(result.state, 'failed')
    assert.match(result.processingIssue.message, /interrupted/)
    assert.equal(
      preparationIssue({ message: 'The operation was aborted due to timeout' }).message,
      'Processing timed out.'
    )
  } finally {
    j.close()
    rmSync(dir, { recursive: true })
  }
})
