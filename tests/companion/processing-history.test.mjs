// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { Intake } from '../../companion/intake.mjs'
import { Operations } from '../../companion/operations.mjs'
import { processingHistory } from '../../companion/processing-history.mjs'
test('recorded attempts and filing events are read-only and scoped to the authenticated processing record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-history-')),
    j = new ProposalJournal(join(dir, 'db')),
    w = new Workflow(j),
    actor = { server: 'https://fixture.test', account: 'fixture', space: 'space' },
    scope = w.scope(actor)
  new Intake(w, {})
  new Operations(w, {})
  try {
    j.db
      .prepare(
        "insert into intake_queue(id,scope,resource,path,etag,state,first_seen,attempts,next_attempt) values(?,?,?,?,?,'prepared',?,2,0)"
      )
      .run('queue', scope, 'resource', 'Inbox/one.pdf', 'v1', Date.now())
    const input = { source: { resourceId: 'resource' } },
      result = { manualReview: { reason: 'rules' } }
    j.db
      .prepare(
        'insert into proposals(id,scope,input,configuration,state,result,raw,updated) values(?,?,?,?,?,?,?,?)'
      )
      .run(
        'review',
        scope,
        JSON.stringify(input),
        '{}',
        'needs_details',
        JSON.stringify(result),
        'PRIVATE RAW MODEL RESPONSE',
        '2026-11-04'
      )
    w.event(actor, 'review', 'approved', { target: 'Docs/one.pdf' })
    const value = processingHistory(w, actor, 'queue')
    assert.equal(value.attempts.length, 1)
    assert.deepEqual(value.attempts[0].result, result)
    assert.equal(value.events[0].kind, 'approved')
    assert.equal(JSON.stringify(value).includes('PRIVATE RAW'), false)
    assert.throws(() => processingHistory(w, { ...actor, account: 'other' }, 'queue'), /not found/)
    assert.equal(j.db.prepare('select count(*) n from decisions').get().n, 0)
  } finally {
    j.close()
    rmSync(dir, { recursive: true })
  }
})
