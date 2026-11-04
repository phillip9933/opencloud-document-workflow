// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProposalJournal } from '../../companion/journal.mjs'
import { Workflow } from '../../companion/workflow.mjs'
import { DemoAdapter } from '../../companion/demo.mjs'
import { extractPDFBytes } from '../../companion/extract.mjs'
import { defaultAIConfig } from '../../src/domain/ai.ts'
import { samples } from '../../src/domain/samples.ts'
import { defaultPolicy, validateBundle, reviewDigest } from '../../src/domain/review.ts'
const config = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'fixture-model',
  policy: defaultPolicy()
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-service-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    api = new DemoAdapter(j.db)
  api.seed()
  const actor = await api.identity(),
    s = await api.stat('Inbox/english.pdf'),
    input = await extractPDFBytes(await api.get(s.path), {
      server: actor.server,
      account: actor.account,
      space: actor.space,
      path: s.path,
      resourceId: s.resourceId,
      etag: s.etag,
      sha256: 'a'.repeat(64)
    })
  const proposal = structuredClone(samples()[0].proposal)
  proposal.tags = proposal.tags.filter((t) => t.value !== 'Synthetic')
  const result = await j.prepare(input, config, {
    planner: async (i) => validateBundle({ ...i, proposal })
  })
  return {
    dir,
    path,
    j,
    w,
    api,
    actor,
    result,
    close() {
      this.j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
async function approve(s, policy = defaultPolicy()) {
  return s.w.approve(
    s.actor,
    s.api,
    s.result.id,
    policy,
    await reviewDigest(s.result.review, policy)
  )
}
test('approved filing preserves bytes, resource identity and existing tags; repeated applies do not write', async () => {
  const s = await setup()
  try {
    let moves = 0,
      tags = 0
    const move = s.api.move.bind(s.api),
      add = s.api.addTags.bind(s.api)
    s.api.move = async (...a) => {
      moves++
      return move(...a)
    }
    s.api.addTags = async (...a) => {
      tags++
      return add(...a)
    }
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /approval/)
    assert.equal(moves, 0)
    await approve(s)
    const result = await s.w.apply(s.actor, s.api, s.result.id)
    assert.equal(result.state, 'done')
    const final = await s.api.stat(result.target)
    assert.equal(final.resourceId, 'demo-english')
    assert.ok(final.tags.includes('Keep existing'))
    assert.ok(final.tags.includes('Electricity'))
    assert.equal(
      createHash('sha256')
        .update(await s.api.get(result.target))
        .digest('hex'),
      s.result.review.bundle.source.sha256
    )
    assert.equal(await s.api.stat('Inbox/english.pdf'), null)
    const verified = await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })
    assert.equal(verified.verification.resourceId, 'demo-english')
    assert.equal(verified.verification.sha256, s.result.review.bundle.source.sha256)
    assert.ok(Date.parse(verified.verification.checkedAt))
    assert.equal(moves, 1)
    assert.equal(tags, 1)
    s.j.close()
    s.j = new ProposalJournal(s.path)
    s.w = new Workflow(s.j)
    s.api = new DemoAdapter(s.j.db)
    s.api.move = async () => {
      moves++
      throw new Error('unexpected replay')
    }
    s.api.addTags = async () => {
      tags++
      throw new Error('unexpected replay')
    }
    await s.w.apply(s.actor, s.api, s.result.id)
    assert.equal(moves, 1)
    assert.equal(tags, 1)
  } finally {
    s.close()
  }
})
test('lost MOVE response reconciles its committed outcome without replay', async () => {
  const s = await setup()
  try {
    let moves = 0
    const move = s.api.move.bind(s.api)
    s.api.move = async (...a) => {
      moves++
      await move(...a)
      throw new Error('lost response')
    }
    await approve(s)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /lost/)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'move_intent')
    const recheck = await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })
    assert.equal(recheck.state, 'move_done')
    const done = await s.w.apply(s.actor, s.api, s.result.id)
    assert.equal(done.state, 'done')
    assert.equal(moves, 1)
  } finally {
    s.close()
  }
})
test('unconfirmed MOVE and tag requests are not blindly resent', async () => {
  const s = await setup()
  try {
    let moves = 0
    s.api.move = async () => {
      moves++
      throw new Error('request outcome unknown')
    }
    await approve(s)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id))
    const result = await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })
    assert.equal(result.uncertain, true)
    assert.equal(moves, 1)
  } finally {
    s.close()
  }
})
test('a lost committed tag response reconciles without another tag request', async () => {
  const s = await setup()
  try {
    let tags = 0
    const add = s.api.addTags.bind(s.api)
    s.api.addTags = async (...a) => {
      tags++
      await add(...a)
      throw new Error('lost tag response')
    }
    await approve(s)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id))
    assert.equal(
      (await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })).state,
      'done'
    )
    assert.equal(tags, 1)
  } finally {
    s.close()
  }
})
test('stale source, stale digest and other-account decisions cannot authorize a mutation', async () => {
  const s = await setup()
  try {
    await assert.rejects(
      s.w.approve(s.actor, s.api, s.result.id, defaultPolicy(), 'wrong'),
      /changed/
    )
    assert.throws(() => s.w.job({ ...s.actor, account: 'someone-else' }, s.result.id), /not found/)
    s.j.db
      .prepare('update demo_files set etag=? where path=?')
      .run('"changed"', 'Inbox/english.pdf')
    await assert.rejects(approve(s), /Source changed/)
    assert.equal(s.w.decision(s.actor, s.result.id), undefined)
  } finally {
    s.close()
  }
})
test('destination collisions are held and never overwritten', async () => {
  const s = await setup()
  try {
    await approve(s)
    const target = JSON.parse(s.w.decision(s.actor, s.result.id).record).actions.target
    await s.api.mkdir(target)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /conflicts/)
    assert.equal((await s.api.stat(target)).folder, true)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})
test('manual tag removal after completion is held without silently reapplying', async () => {
  const s = await setup()
  try {
    await approve(s)
    const done = await s.w.apply(s.actor, s.api, s.result.id)
    s.j.db.prepare('update demo_files set tags=? where path=?').run('[]', done.target)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /conflicts/)
    assert.deepEqual((await s.api.stat(done.target)).tags, [])
  } finally {
    s.close()
  }
})
test('a conflicted filed document is located by resource identity before a fresh review, without changing the old decision', async () => {
  const s = await setup()
  try {
    await approve(s)
    const done = await s.w.apply(s.actor, s.api, s.result.id)
    s.j.db.prepare('update demo_files set tags=? where path=?').run('[]', done.target)
    await assert.rejects(
      s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true }),
      /conflicts/
    )
    const current = await s.w.location(s.actor, s.api, s.result.id)
    assert.equal(current.path, done.target)
    assert.equal(current.resourceId, s.result.review.bundle.source.resourceId)
    const input = JSON.parse(s.w.job(s.actor, s.result.id).input)
    for (let n = 0; n < 205; n++)
      s.j.db
        .prepare(
          'insert into proposals(id,scope,input,configuration,state,updated) values(?,?,?,?,?,?)'
        )
        .run(
          createHash('sha256')
            .update('later-' + n)
            .digest('hex'),
          s.w.scope(s.actor),
          JSON.stringify({ ...input, source: { ...input.source, resourceId: 'later-' + n } }),
          '{}',
          'pending',
          '2099-01-01T00:00:00.000Z'
        )
    assert.equal(
      s.w.jobs(s.actor).some((job) => job.id === s.result.id),
      false
    )
    const original = s.j.prepare.bind(s.j)
    s.j.prepare = (input, configuration, options) =>
      original(input, configuration, {
        ...options,
        planner: async (value) =>
          validateBundle({ ...value, proposal: s.result.review.bundle.proposal })
      })
    const fresh = await s.w.prepare(s.actor, s.api, current.path, config, { newReview: true })
    assert.notEqual(fresh.id, s.result.id)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'conflict')
    assert.equal(s.w.decision(s.actor, fresh.id), undefined)
    await assert.rejects(
      s.w.location({ ...s.actor, account: 'other' }, s.api, s.result.id),
      /not found/
    )
    s.j.db
      .prepare('update demo_files set resourceId=? where path=?')
      .run('different-file', done.target)
    await assert.rejects(s.w.location(s.actor, s.api, s.result.id), /could not be located/)
  } finally {
    s.close()
  }
})
test('decisions and activity survive reopen and remain account scoped and append-only', async () => {
  const s = await setup()
  try {
    await approve(s)
    s.w.savePreference(s.actor, { policy: defaultPolicy(), ai: defaultAIConfig() })
    assert.equal(s.w.history({ ...s.actor, account: 'other' }).length, 0)
    assert.throws(() => s.j.db.exec('delete from activity'), /append-only/)
    s.j.close()
    s.j = new ProposalJournal(s.path)
    s.w = new Workflow(s.j)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'approved')
    assert.equal(s.w.history(s.actor).length, 2)
  } finally {
    s.close()
  }
})
test('concurrent decisions cannot replace an approval already recorded by another request', async () => {
  const s = await setup()
  try {
    const results = await Promise.allSettled([
      approve(s),
      approve(s, { ...defaultPolicy(), rename: 'off' })
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'approved')
  } finally {
    s.close()
  }
})
test('an explicit new review after rejection preserves the old decision and requires a new approval', async () => {
  const s = await setup()
  try {
    s.w.reject(s.actor, s.result.id)
    const original = s.j.prepare.bind(s.j)
    s.j.prepare = (i, c, o) =>
      original(i, c, {
        ...o,
        planner: async (value) =>
          validateBundle({ ...value, proposal: s.result.review.bundle.proposal })
      })
    const fresh = await s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, {
      newReview: true
    })
    assert.notEqual(fresh.id, s.result.id)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'rejected')
    await assert.rejects(s.w.apply(s.actor, s.api, fresh.id), /approval/)
  } finally {
    s.close()
  }
})
test('a human-adjusted filename, folder and additional tags are bound to approval and survive restart', async () => {
  const s = await setup()
  try {
    const manual = {
        target: 'Archive/Household/2026-10-29 TEST-42.pdf',
        addTags: ['Household', 'Paid']
      },
      policy = defaultPolicy()
    await assert.rejects(
      s.w.approve(
        s.actor,
        s.api,
        s.result.id,
        policy,
        await reviewDigest(s.result.review, policy),
        manual
      ),
      /changed/
    )
    await s.w.approve(
      s.actor,
      s.api,
      s.result.id,
      policy,
      await reviewDigest(s.result.review, policy, manual),
      manual
    )
    const result = await s.w.apply(s.actor, s.api, s.result.id)
    assert.equal(result.target, manual.target)
    assert.ok(result.tags.includes('Household'))
    assert.ok(result.tags.includes('Keep existing'))
    s.j.close()
    s.j = new ProposalJournal(s.path)
    s.w = new Workflow(s.j)
    s.api = new DemoAdapter(s.j.db)
    assert.equal((await s.w.apply(s.actor, s.api, s.result.id)).state, 'done')
  } finally {
    s.close()
  }
})
test('tampering stored actions cannot reuse an otherwise matching approval digest', async () => {
  const s = await setup()
  try {
    await approve(s)
    const record = JSON.parse(s.w.decision(s.actor, s.result.id).record)
    record.actions.target = 'Filed/unapproved.pdf'
    s.j.db
      .prepare('update decisions set record=? where job=?')
      .run(JSON.stringify(record), s.result.id)
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /no longer matches/)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})
test('unconfirmed metadata holds filing before any folder, MOVE or tag write and can be read-only reconciled', async () => {
  const s = await setup()
  try {
    const { Metadata } = await import('../../companion/metadata.mjs'),
      metadata = new Metadata(s.w)
    metadata.saveSchema(s.actor, {
      fields: [{ id: 'invoice', label: 'Invoice', type: 'text', aliases: [], choices: [] }],
      tags: []
    })
    const view = await metadata.get(s.actor, s.api, 'Inbox/english.pdf'),
      reconcile = metadata.reconcile.bind(metadata)
    metadata.reconcile = async () => {
      throw new Error('Simulated interruption before field-save verification')
    }
    await assert.rejects(
      metadata.save(s.actor, s.api, {
        path: view.source.path,
        resourceId: view.source.resourceId,
        etag: view.source.etag,
        sha256: view.source.sha256,
        version: 0,
        fields: { invoice: 'TEST-42' },
        addTags: []
      }),
      /interruption/
    )
    metadata.reconcile = reconcile
    await approve(s)
    let moves = 0,
      tags = 0,
      folders = 0
    const move = s.api.move.bind(s.api),
      add = s.api.addTags.bind(s.api),
      mkdir = s.api.mkdir.bind(s.api)
    s.api.move = async (...a) => {
      moves++
      return move(...a)
    }
    s.api.addTags = async (...a) => {
      tags++
      return add(...a)
    }
    s.api.mkdir = async (...a) => {
      folders++
      return mkdir(...a)
    }
    await assert.rejects(s.w.apply(s.actor, s.api, s.result.id), /metadata save needs verification/)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'approved')
    assert.equal(moves + tags + folders, 0)
    assert.equal(
      (await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })).state,
      'approved'
    )
    const pending = (await metadata.get(s.actor, s.api, 'Inbox/english.pdf')).pending
    assert.equal(pending.length, 1)
    assert.equal((await metadata.reconcile(s.actor, s.api, pending[0].id)).state, 'done')
    assert.equal(metadata.read(s.actor, view.source.resourceId).fields.invoice, 'TEST-42')
    assert.equal((await s.w.apply(s.actor, s.api, s.result.id)).state, 'done')
    assert.equal(moves, 1)
    assert.equal(tags, 1)
  } finally {
    s.close()
  }
})
test('manual review cannot be automatically authorized and files only after explicit destination-bound approval', async () => {
  const s = await setup()
  try {
    const original = JSON.parse(s.j.get(s.result.id).input),
      r = await s.j.prepare(
        original,
        { ...config, model: 'manual-fixture' },
        {
          manualFallback: true,
          planner: async () => {
            throw Error('Fact is not present in its evidence')
          }
        }
      ),
      policy = defaultPolicy(),
      manual = { target: 'Filed/Checked/english.pdf', addTags: ['Checked'] },
      digest = await reviewDigest(r.review, policy, manual)
    await assert.rejects(
      s.w.approve(s.actor, s.api, r.id, policy, digest, manual, {
        automaticAuthorization: { kind: 'automatic' }
      }),
      /human review/
    )
    assert.equal(s.w.decision(s.actor, r.id), undefined)
    await assert.rejects(s.w.apply(s.actor, s.api, r.id), /approval/)
    await assert.rejects(
      s.w.approve(s.actor, s.api, r.id, policy, digest, {
        ...manual,
        target: 'Filed/Changed/english.pdf'
      }),
      /changed/
    )
    await s.w.approve(s.actor, s.api, r.id, policy, digest, manual)
    const result = await s.w.apply(s.actor, s.api, r.id)
    assert.equal(result.target, manual.target)
    assert.ok(result.tags.includes('Checked'))
    assert.equal(await s.api.stat('Inbox/english.pdf'), null)
  } finally {
    s.close()
  }
})
test('a manual review can explicitly prepare fresh suggestions without rejecting, filing or replacing the earlier review', async () => {
  const s = await setup()
  try {
    const input = JSON.parse(s.j.get(s.result.id).input),
      manual = await s.j.prepare(
        input,
        { ...config, model: 'manual-fixture' },
        {
          manualFallback: true,
          planner: async () => {
            throw Error('Fact is not present in its evidence')
          }
        }
      )
    s.j.db
      .prepare('update proposals set updated=? where id=?')
      .run('2020-01-01T00:00:00Z', s.result.id)
    const before = await s.api.stat('Inbox/english.pdf'),
      original = s.j.prepare.bind(s.j)
    s.j.prepare = (i, c, o) =>
      original(i, c, {
        ...o,
        planner: async (value) =>
          validateBundle({ ...value, proposal: s.result.review.bundle.proposal })
      })
    const fresh = await s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, {
      newReview: true
    })
    assert.notEqual(fresh.id, manual.id)
    assert.equal(s.j.get(fresh.id).state, 'needs_review')
    assert.equal(s.j.get(manual.id).state, 'needs_details')
    assert.equal(s.w.decision(s.actor, manual.id), undefined)
    assert.equal(s.w.decision(s.actor, fresh.id), undefined)
    assert.deepEqual(await s.api.stat('Inbox/english.pdf'), before)
    await assert.rejects(s.w.apply(s.actor, s.api, fresh.id), /approval/)
    const policy = defaultPolicy(),
      actions = { target: 'Filed/Manual/english.pdf', addTags: [] }
    await s.w.approve(
      s.actor,
      s.api,
      manual.id,
      policy,
      await reviewDigest(manual.review, policy, actions),
      actions
    )
    s.j.db
      .prepare('update proposals set updated=? where id=?')
      .run('2030-01-01T00:00:00Z', manual.id)
    await assert.rejects(
      s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, { newReview: true }),
      /Finish or verify/
    )
    assert.equal(s.w.decision(s.actor, manual.id).state, 'approved')
  } finally {
    s.close()
  }
})
test('a failed fresh manual preparation can be retried without filing or discarding either earlier record', async () => {
  const s = await setup()
  try {
    const original = s.j.get(s.result.id),
      bundle = JSON.parse(original.input)
    s.j.db
      .prepare(
        "update proposals set state='needs_details',result=?,updated='2000-01-01T00:00:00Z' where id=?"
      )
      .run(
        JSON.stringify({ ...bundle, proposal: null, manualReview: { reason: 'evidence' } }),
        s.result.id
      )
    const prepare = s.j.prepare.bind(s.j)
    let calls = 0
    s.j.prepare = (input, configuration, options) =>
      prepare(input, configuration, {
        ...options,
        planner: async (value) => {
          calls++
          if (calls === 1) throw Error('Ollama HTTP 503')
          return validateBundle({ ...value, proposal: samples()[0].proposal })
        }
      })
    s.api.move = async () => {
      throw Error('Unexpected MOVE')
    }
    s.api.addTags = async () => {
      throw Error('Unexpected tag write')
    }
    await assert.rejects(
      s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, { newReview: true }),
      /503/
    )
    const result = await s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, {
      newReview: true,
      retry: true
    })
    assert.equal(result.bundle.proposal.issuer.value, 'Example Electricity Company')
    assert.equal(calls, 2)
    assert.equal(s.j.db.prepare('select count(*) n from proposals').get().n, 3)
    assert.equal(s.j.db.prepare('select count(*) n from decisions').get().n, 0)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})

test('semantic discovery snapshots authenticated tags without writes and still needs exact approval to create a new tag', async () => {
  const s = await setup()
  try {
    let writes = 0
    const add = s.api.addTags.bind(s.api)
    s.api.addTags = async (...args) => {
      writes++
      return add(...args)
    }
    s.api.listTags = async () => ['Energy', 'Invoices']
    let captured
    const original = s.j.prepare.bind(s.j)
    s.j.prepare = (i, c, o) => {
      captured = i
      return original(i, c, {
        ...o,
        planner: async (input) =>
          validateBundle({
            ...input,
            proposal: {
              ...s.result.review.bundle.proposal,
              tags: [
                { value: 'Home utilities', evidence: s.result.review.bundle.proposal.kind.evidence }
              ]
            }
          })
      })
    }
    const prepared = await s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', {
      ...config,
      tagDiscovery: 'create'
    })
    assert.equal(writes, 0)
    assert.deepEqual(captured.tagDiscovery, {
      mode: 'create',
      catalog: ['Energy', 'Invoices', 'Keep existing']
    })
    assert.equal(prepared.bundle.proposal.tags[0].value, 'Home utilities')
    await assert.rejects(s.w.apply(s.actor, s.api, prepared.id), /approval/)
    assert.equal(writes, 0)
    const review = validateBundle(prepared.bundle)
    await s.w.approve(
      s.actor,
      s.api,
      prepared.id,
      defaultPolicy(),
      await reviewDigest(review, defaultPolicy())
    )
    await s.w.apply(s.actor, s.api, prepared.id)
    assert.equal(writes, 1)
  } finally {
    s.close()
  }
})
test('unavailable authenticated tag directory holds discovery before model work or tag writes', async () => {
  const s = await setup()
  try {
    let called = false
    s.j.prepare = async () => {
      called = true
      throw Error('must not reach model')
    }
    s.api.listTags = async () => {
      throw Error('Tag directory unavailable')
    }
    await assert.rejects(
      s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', { ...config, tagDiscovery: 'create' }),
      /Tag directory unavailable/
    )
    assert.equal(called, false)
    assert.equal(s.w.decision(s.actor, s.result.id), undefined)
  } finally {
    s.close()
  }
})

test('explicit reprocessing bypasses the successful cache and preserves every earlier review and decision', async () => {
  const s = await setup()
  try {
    const prepare = s.j.prepare.bind(s.j)
    let calls = 0
    s.j.prepare = (input, config, options) =>
      prepare(input, config, {
        ...options,
        planner: async (value) => {
          calls++
          return validateBundle({ ...value, proposal: s.result.review.bundle.proposal })
        }
      })
    const original = s.j.get(s.result.id).result,
      current = await s.api.stat('Inbox/english.pdf'),
      options = {
        newReview: true,
        retry: true,
        expectedResourceId: current.resourceId,
        expectedEtag: current.etag
      }
    const one = await s.w.prepare(s.actor, s.api, current.path, config, options),
      two = await s.w.prepare(s.actor, s.api, current.path, config, options)
    assert.notEqual(one.id, two.id)
    assert.notEqual(one.id, s.result.id)
    assert.equal(calls, 2)
    assert.equal(s.j.get(s.result.id).result, original)
    for (const id of [s.result.id, one.id, two.id])
      assert.equal(s.w.decision(s.actor, id), undefined)
    assert.ok(await s.api.stat(current.path))
    await assert.rejects(
      s.w.prepare(s.actor, s.api, current.path, config, {
        ...options,
        expectedResourceId: 'replaced'
      }),
      /changed before preparation/
    )
    assert.equal(calls, 2)
  } finally {
    s.close()
  }
})
test('reprocessing cannot bypass an approved filing operation', async () => {
  const s = await setup()
  try {
    await approve(s)
    await assert.rejects(
      s.w.prepare(s.actor, s.api, 'Inbox/english.pdf', config, { newReview: true }),
      /Finish or verify/
    )
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'approved')
  } finally {
    s.close()
  }
})

test('a filed resource reprocesses at its current location without changing its completed filing or bytes', async () => {
  const s = await setup()
  try {
    await approve(s)
    const filed = await s.w.apply(s.actor, s.api, s.result.id),
      location = await s.w.location(s.actor, s.api, s.result.id),
      bytes = await s.api.get(location.path),
      before = await s.api.stat(location.path),
      prepare = s.j.prepare.bind(s.j)
    s.j.prepare = (input, configuration, options) =>
      prepare(input, configuration, {
        ...options,
        planner: async (value) =>
          validateBundle({ ...value, proposal: s.result.review.bundle.proposal })
      })
    const fresh = await s.w.prepare(s.actor, s.api, location.path, config, {
      newReview: true,
      expectedResourceId: location.resourceId,
      expectedEtag: location.etag
    })
    assert.notEqual(fresh.id, s.result.id)
    assert.equal(fresh.bundle.source.path, filed.target)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'done')
    assert.equal(s.w.decision(s.actor, fresh.id), undefined)
    assert.deepEqual(await s.api.stat(location.path), before)
    assert.deepEqual(await s.api.get(location.path), bytes)
  } finally {
    s.close()
  }
})
test('uncertain metadata writes must be reconciled before explicit reprocessing', async () => {
  const s = await setup()
  try {
    const { Metadata } = await import('../../companion/metadata.mjs'),
      metadata = new Metadata(s.w),
      source = await metadata.inspect(s.actor, s.api, 'Inbox/english.pdf')
    s.api.addTags = async () => {
      throw Error('Lost tag response')
    }
    await assert.rejects(
      metadata.save(s.actor, s.api, {
        path: source.path,
        resourceId: source.resourceId,
        etag: source.etag,
        sha256: source.sha256,
        version: 0,
        fields: {},
        addTags: ['Check']
      }),
      /Lost tag response/
    )
    await assert.rejects(
      s.w.prepare(s.actor, s.api, source.path, config, { newReview: true }),
      /pending metadata/
    )
    assert.equal(metadata.read(s.actor, source.resourceId).version, 0)
  } finally {
    s.close()
  }
})

test('a completed document moved externally retains fields, history and read-only verification across restart; changed bytes stay held', async () => {
  const s = await setup()
  try {
    const { Configuration } = await import('../../companion/configuration.mjs'),
      { Transfers } = await import('../../companion/transfers.mjs'),
      { Metadata } = await import('../../companion/metadata.mjs'),
      { DocumentLibrary } = await import('../../companion/documents.mjs')
    const attach = () => {
      new Configuration(s.w)
      new Transfers(s.w)
      new Metadata(s.w)
      return new DocumentLibrary(s.w)
    }
    let library = attach()
    await approve(s)
    const done = await s.w.apply(s.actor, s.api, s.result.id),
      file = await s.api.stat(done.target),
      record = s.w.decision(s.actor, s.result.id).record
    s.w.db
      .prepare('insert into metadata values(?,?,?,?,?)')
      .run(
        s.w.scope(s.actor),
        file.resourceId,
        1,
        JSON.stringify({ reference: 'PRESERVED' }),
        new Date().toISOString()
      )
    const root = s.w.configuration.settings(s.actor).rules.root,
      target = root + '/Renamed parent/renamed.pdf'
    await s.api.mkdir(root + '/Renamed parent')
    await s.api.move(done.target, target, file.etag)
    // A new unrelated file occupies the old path; identical bytes are insufficient.
    await s.api.put(done.target, await s.api.get(target))
    const current = await library.currentList(s.actor, s.api)
    assert.equal(current.documents[0].path, target)
    assert.equal(current.documents[0].fields.reference, 'PRESERVED')
    s.j.close()
    s.j = new ProposalJournal(s.path)
    s.w = new Workflow(s.j)
    s.api = new DemoAdapter(s.j.db)
    library = attach()
    for (const method of ['move', 'put', 'addTags', 'trash', 'mkdir'])
      s.api[method] = async () => assert.fail('Read-only tracking must not write files')
    const verified = await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })
    assert.equal(verified.target, target)
    assert.equal(verified.verification.resourceId, file.resourceId)
    assert.equal(s.w.decision(s.actor, s.result.id).record, record)
    assert.equal(
      (await library.currentList(s.actor, s.api)).documents[0].fields.reference,
      'PRESERVED'
    )
    s.w.db
      .prepare('update demo_files set data=?,etag=? where path=?')
      .run(Buffer.from('changed bytes'), '"changed"', target)
    await assert.rejects(
      s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true }),
      /document changed/
    )
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'done')
    assert.equal(s.w.decision(s.actor, s.result.id).record, record)
  } finally {
    s.close()
  }
})

test('an explicitly unassigned tag updates current verification without altering the original filing approval', async () => {
  const s = await setup()
  try {
    const { Configuration } = await import('../../companion/configuration.mjs'),
      { Transfers } = await import('../../companion/transfers.mjs'),
      { Metadata } = await import('../../companion/metadata.mjs'),
      { DocumentLibrary } = await import('../../companion/documents.mjs')
    new Configuration(s.w)
    new Transfers(s.w)
    const metadata = new Metadata(s.w)
    new DocumentLibrary(s.w)
    await approve(s)
    const filed = await s.w.apply(s.actor, s.api, s.result.id),
      record = s.w.decision(s.actor, s.result.id).record,
      d = await metadata.get(s.actor, s.api, filed.target)
    await metadata.removeTag(s.actor, s.api, {
      ...d.source,
      version: d.record.version,
      tag: 'Electricity'
    })
    const result = await s.w.apply(s.actor, s.api, s.result.id, { reconcileOnly: true })
    assert.equal(result.state, 'done')
    assert.ok(!result.tags.includes('Electricity'))
    assert.ok(result.tags.includes('Keep existing'))
    assert.equal(s.w.decision(s.actor, s.result.id).record, record)
    assert.equal(s.w.decision(s.actor, s.result.id).state, 'done')
  } finally {
    s.close()
  }
})
