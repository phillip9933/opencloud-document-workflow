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
import { DemoAdapter } from '../../companion/demo.mjs'
import { defaultAIConfig } from '../../src/domain/ai.ts'
import { defaultPolicy, validateBundle } from '../../src/domain/review.ts'
import { samples } from '../../src/domain/samples.ts'
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-automatic-')),
    path = join(dir, 'db.sqlite3'),
    j = new ProposalJournal(path),
    w = new Workflow(j),
    metadata = new Metadata(w),
    api = new DemoAdapter(j.db)
  api.seed()
  j.db.prepare("delete from demo_files where folder=0 and resourceId<>'demo-english'").run()
  const actor = await api.identity(),
    policy = Object.fromEntries(Object.keys(defaultPolicy()).map((k) => [k, 'automatic']))
  w.savePreference(actor, { policy, ai: defaultAIConfig() })
  metadata.saveSchema(actor, {
    fields: [{ id: 'issuer', label: 'Issuer', type: 'text', aliases: ['Issuer'], choices: [] }],
    tags: [{ tag: 'Household', terms: ['Electricity'] }]
  })
  let now = 1000000,
    calls = 0,
    automation
  const prepare = j.prepare.bind(j)
  j.prepare = (input, configuration, options) =>
    prepare(input, configuration, {
      ...options,
      planner: async (value) => {
        calls++
        const proposal = structuredClone(samples()[0].proposal)
        proposal.tags = proposal.tags.filter((t) => ['Electricity', 'Invoice'].includes(t.value))
        return validateBundle({ ...value, proposal })
      }
    })
  const intake = new Intake(w, {
    now: () => now,
    prepare: (actor, api, path) =>
      w.prepare(actor, api, path, {
        endpoint: 'http://127.0.0.1:11434',
        model: 'fixture-model',
        policy
      }),
    processPrepared: (...args) => automation.run(...args),
    resume: (...args) => automation.resume(...args)
  })
  automation = new Automation(w, metadata, intake)
  intake.save(actor, { ...defaultIntake(), enabled: true, settleSeconds: 2 }, api)
  return {
    dir,
    path,
    j,
    w,
    metadata,
    api,
    actor,
    policy,
    intake,
    automation,
    get calls() {
      return calls
    },
    get id() {
      return intake.status(actor).queue.find((q) => q.resource === 'demo-english')?.job
    },
    async arrivals() {
      await intake.tick({ force: true })
      now += 3000
      await intake.tick({ force: true })
    },
    close() {
      j.close()
      rmSync(dir, { recursive: true })
    }
  }
}
test('full automatic ingestion fills grounded fields, applies rule tags, files once and survives restart', async () => {
  const s = await setup()
  try {
    let moves = 0
    const move = s.api.move.bind(s.api)
    s.api.move = async (...args) => {
      moves++
      return move(...args)
    }
    await s.arrivals()
    assert.equal(s.calls, 1)
    assert.equal(moves, 1)
    const d = s.w.decision(s.actor, s.id),
      record = JSON.parse(d.record)
    assert.equal(d.state, 'done')
    assert.equal(record.automaticAuthorization.kind, 'automatic')
    assert.equal(record.reviewedAt, undefined)
    assert.equal(
      s.metadata.read(s.actor, 'demo-english').fields.issuer,
      'Example Electricity Company'
    )
    const filed = await s.api.stat(record.actions.target)
    assert.ok(filed.tags.includes('Household'))
    assert.ok(filed.tags.includes('Keep existing'))
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'done')
    await s.intake.tick({ force: true })
    assert.equal(s.calls, 1)
    assert.equal(moves, 1)
    const second = new ProposalJournal(s.path)
    try {
      const w = new Workflow(second),
        m = new Metadata(w),
        i = new Intake(w),
        a = new Automation(w, m, i)
      assert.equal(a.statusFor(s.actor, s.id).state, 'done')
      assert.equal(i.sessions.size, 0)
      const api = new DemoAdapter(second.db)
      api.move = async () => assert.fail('No replay after restart')
      api.addTags = async () => assert.fail('No tag replay')
      assert.equal((await a.run(s.actor, api, s.id)).state, 'done')
      assert.equal((await w.apply(s.actor, api, s.id, { reconcileOnly: true })).state, 'done')
    } finally {
      second.close()
    }
  } finally {
    s.close()
  }
})
test('cancel during automatic verification blocks writes and cannot be overwritten by an in-flight worker', async () => {
  const s = await setup()
  try {
    s.intake.processPrepared = undefined
    s.intake.resume = undefined
    await s.arrivals()
    let entered, finish
    const ready = new Promise((r) => {
        entered = r
      }),
      gate = new Promise((r) => {
        finish = r
      }),
      identity = s.api.identity.bind(s.api)
    s.api.identity = async () => {
      entered()
      await gate
      return identity()
    }
    let writes = 0
    s.api.move = s.api.addTags = async () => {
      writes++
      assert.fail('Cancelled jobs must not write')
    }
    const run = s.automation.run(s.actor, s.api, s.id)
    await ready
    s.intake.manage(s.actor, 'cancel')
    finish()
    assert.equal((await run).state, 'cancelled')
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'cancelled')
    assert.equal(writes, 0)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})
test('bulk retry preserves completed files and leaves uncertain filing decisions for individual verification', async () => {
  const s = await setup()
  try {
    s.api.move = async () => {
      throw Error('Lost MOVE response')
    }
    await s.arrivals()
    assert.equal(s.w.decision(s.actor, s.id).state, 'move_intent')
    assert.equal(s.intake.manage(s.actor, 'retry').affected, 0)
    assert.equal(s.intake.summary(s.actor).attention, 1)
    s.intake.manage(s.actor, 'cancel')
    assert.equal(s.intake.summary(s.actor).attention, 1)
    assert.equal(s.intake.manage(s.actor, 'retry').affected, 0)
  } finally {
    s.close()
  }
})
test('Suggest policy and arrivals outside the inbox cannot acquire automatic authority', async () => {
  const s = await setup()
  try {
    s.w.savePreference(s.actor, { policy: { ...s.policy, move: 'suggest' }, ai: defaultAIConfig() })
    await s.arrivals()
    assert.equal(s.w.decision(s.actor, s.id), undefined)
    assert.equal((await s.automation.run(s.actor, s.api, s.id)).state, 'review')
    assert.throws(() => s.w.job({ ...s.actor, space: 'another' }, s.id), /not found/)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})
test('pausing after MOVE blocks tags and allows an explicit manual takeover of the exact plan', async () => {
  const s = await setup()
  try {
    let tagWrites = 0
    const move = s.api.move.bind(s.api),
      tags = s.api.addTags.bind(s.api)
    s.api.move = async (...args) => {
      await move(...args)
      s.intake.save(s.actor, { ...s.intake.configuration(s.actor), enabled: false }, s.api)
    }
    s.api.addTags = async (...args) => {
      tagWrites++
      return tags(...args)
    }
    await s.arrivals()
    assert.equal(s.w.decision(s.actor, s.id).state, 'move_done')
    assert.equal(tagWrites, 0)
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'held')
    const record = JSON.parse(s.w.decision(s.actor, s.id).record)
    await assert.rejects(s.automation.takeOver(s.actor, s.api, s.id, 'wrong'), /Reload/)
    assert.equal(
      (await s.automation.takeOver(s.actor, s.api, s.id, record.reviewDigest)).state,
      'move_done'
    )
    assert.equal(tagWrites, 0)
    const taken = JSON.parse(s.w.decision(s.actor, s.id).record)
    assert.ok(taken.manualTakeover.previousAuthorization)
    assert.equal(taken.automaticAuthorization, undefined)
    assert.equal((await s.w.apply(s.actor, s.api, s.id)).state, 'done')
    assert.equal(tagWrites, 1)
  } finally {
    s.close()
  }
})
test('an unknown MOVE outcome remains held through restart and cannot be taken over or replayed', async () => {
  const s = await setup()
  try {
    let moves = 0
    s.api.move = async () => {
      moves++
      throw new Error('Simulated lost response')
    }
    await s.arrivals()
    assert.equal(s.w.decision(s.actor, s.id).state, 'move_intent')
    const record = JSON.parse(s.w.decision(s.actor, s.id).record)
    await assert.rejects(
      s.automation.takeOver(s.actor, s.api, s.id, record.reviewDigest),
      /uncertain/
    )
    await s.automation.resume(s.actor, s.api)
    await s.automation.run(s.actor, s.api, s.id)
    assert.equal(moves, 1)
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'held')
  } finally {
    s.close()
  }
})
test('concurrent automatic requests are serialized and existing manual fields are preserved', async () => {
  const s = await setup()
  try {
    s.intake.processPrepared = undefined
    s.intake.resume = undefined
    await s.arrivals()
    const view = await s.metadata.get(s.actor, s.api, 'Inbox/english.pdf')
    await s.metadata.save(s.actor, s.api, {
      path: view.source.path,
      resourceId: view.source.resourceId,
      etag: view.source.etag,
      sha256: view.source.sha256,
      version: 0,
      fields: { issuer: 'User chosen issuer' },
      addTags: []
    })
    let moves = 0
    const move = s.api.move.bind(s.api)
    s.api.move = async (...args) => {
      moves++
      return move(...args)
    }
    await Promise.all([
      s.automation.run(s.actor, s.api, s.id),
      s.automation.run(s.actor, s.api, s.id)
    ])
    assert.equal(moves, 1)
    assert.equal(s.metadata.read(s.actor, 'demo-english').fields.issuer, 'User chosen issuer')
  } finally {
    s.close()
  }
})
test('field-only automatic work is marked processed and remains discoverable without a false file mutation', async () => {
  const s = await setup()
  try {
    const { DocumentLibrary } = await import('../../companion/documents.mjs'),
      library = new DocumentLibrary(s.w)
    s.w.savePreference(s.actor, {
      policy: { ...s.policy, move: 'off', rename: 'off', tags: 'off' },
      ai: defaultAIConfig()
    })
    let writes = 0
    s.api.move = s.api.addTags = async () => {
      writes++
      assert.fail('No file or tag change enabled')
    }
    await s.arrivals()
    assert.equal(writes, 0)
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'done')
    assert.equal(s.w.decision(s.actor, s.id), undefined)
    assert.equal(s.w.jobPage(s.actor, { activeOnly: true }).jobs.length, 0)
    const records = library.list(s.actor).documents
    assert.equal(records.length, 1)
    assert.equal(records[0].path, 'Inbox/english.pdf')
    assert.equal(records[0].fields.issuer, 'Example Electricity Company')
  } finally {
    s.close()
  }
})
test('unparseable printed numeric fields are held until an explicit correction and automatic retry', async () => {
  const s = await setup()
  try {
    s.metadata.saveSchema(s.actor, {
      fields: [{ id: 'amount', label: 'Total', type: 'number', aliases: ['Total'], choices: [] }],
      tags: []
    })
    await s.arrivals()
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'held')
    assert.equal(s.w.decision(s.actor, s.id), undefined)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
    const before = await s.metadata.get(s.actor, s.api, 'Inbox/english.pdf')
    await s.metadata.save(s.actor, s.api, {
      path: before.source.path,
      resourceId: before.source.resourceId,
      etag: before.source.etag,
      sha256: before.source.sha256,
      version: 0,
      fields: { amount: 12345 },
      addTags: []
    })
    assert.equal((await s.automation.run(s.actor, s.api, s.id, { retry: true })).state, 'done')
    assert.equal(s.metadata.read(s.actor, 'demo-english').fields.amount, 12345)
    assert.ok(s.w.history(s.actor).some((e) => e.kind === 'automatic_reauthorized'))
  } finally {
    s.close()
  }
})
test('automatic ingestion never overwrites an occupied destination or auto-processes an identical alias', async () => {
  const s = await setup()
  try {
    const original = s.j.db
      .prepare("select * from demo_files where resourceId='demo-english'")
      .get()
    s.j.db
      .prepare('insert into demo_files values(?,?,?,?,?,?)')
      .run('Inbox/zduplicate.pdf', 'duplicate', '"v1"', '[]', 0, original.data)
    const target =
      'Filed/Utilities/Electricity/2026-10-29 Example Electricity Company Electricity invoice.pdf'
    await s.api.mkdir(target)
    await s.arrivals()
    assert.equal(s.w.decision(s.actor, s.id).state, 'conflict')
    assert.equal(s.calls, 1)
    assert.equal((await s.api.stat(target)).folder, true)
    assert.ok(await s.api.stat('Inbox/english.pdf'))
    const duplicate = s.intake.status(s.actor).queue.find((q) => q.resource === 'duplicate')
    assert.equal(duplicate.state, 'duplicate')
    assert.equal(s.intake.summary(s.actor).duplicates, 1)
    assert.equal(s.intake.manage(s.actor, 'cancel', [duplicate.id]).affected, 0)
    assert.equal(s.automation.statusFor(s.actor, s.id).state, 'held')
  } finally {
    s.close()
  }
})
test('automatic mode leaves unverified details for a human without filling fields, adding tags or filing', async () => {
  const s = await setup()
  try {
    s.j.prepare = (input, configuration, options) =>
      ProposalJournal.prototype.prepare.call(s.j, input, configuration, {
        ...options,
        planner: async () => {
          throw Error('Fact is not present in its evidence')
        }
      })
    await s.arrivals()
    assert.equal(s.j.get(s.id).state, 'needs_details')
    assert.equal(s.intake.summary(s.actor).ready, 1)
    assert.equal(s.w.decision(s.actor, s.id), undefined)
    assert.equal(s.automation.statusFor(s.actor, s.id), null)
    assert.equal(s.metadata.read(s.actor, 'demo-english').fields.issuer, undefined)
    const f = await s.api.stat('Inbox/english.pdf')
    assert.deepEqual(f.tags, ['Keep existing'])
    assert.equal((await s.automation.run(s.actor, s.api, s.id)).state, 'review')
  } finally {
    s.close()
  }
})
test('potential scan duplicates require review before any automatic field, MOVE or tag write', async () => {
  const s = await setup()
  try {
    let writes = 0
    s.w.similarities = { forJob: async () => [{ id: 'other-copy', path: 'Inbox/other.pdf' }] }
    s.api.move = async () => {
      writes++
      throw Error('Unexpected filing')
    }
    s.api.addTags = async () => {
      writes++
      throw Error('Unexpected tags')
    }
    await s.arrivals()
    assert.equal(writes, 0)
    assert.equal(s.w.decision(s.actor, s.id), undefined)
    assert.deepEqual(s.metadata.read(s.actor, 'demo-english').fields, {})
    assert.ok(await s.api.stat('Inbox/english.pdf'))
  } finally {
    s.close()
  }
})

test('explicit automatic Tags policy can apply new semantic candidates, while Review Tags waits without creating them', async () => {
  for (const mode of ['automatic', 'suggest', 'disabled']) {
    const s = await setup()
    try {
      const base = ProposalJournal.prototype.prepare.bind(s.j)
      s.j.prepare = (input, configuration, options) =>
        base(
          { ...input, tagDiscovery: { mode: 'create', catalog: ['Keep existing'] } },
          configuration,
          {
            ...options,
            planner: async (value) =>
              validateBundle({
                ...value,
                proposal: {
                  ...samples()[0].proposal,
                  tags: [{ value: 'Home utilities', evidence: samples()[0].proposal.kind.evidence }]
                }
              })
          }
        )
      s.w.savePreference(s.actor, {
        policy: { ...s.policy, tags: mode === 'disabled' ? 'automatic' : mode },
        ai: {
          ...defaultAIConfig(),
          local: { endpoint: 'http://127.0.0.1:11434', model: 'fixture-model' },
          tasks: { facts: 'local', filing: 'local', tags: 'local' },
          tagDiscovery: mode === 'disabled' ? 'off' : 'create'
        }
      })
      await s.arrivals()
      const decision = s.w.decision(s.actor, s.id)
      if (mode === 'automatic') {
        assert.equal(decision.state, 'done')
        const record = JSON.parse(decision.record)
        assert.equal(record.automaticAuthorization.kind, 'automatic')
        assert.ok((await s.api.stat(record.actions.target)).tags.includes('Home utilities'))
      } else {
        assert.equal(decision, undefined)
        assert.equal((await s.api.stat('Inbox/english.pdf')).tags.includes('Home utilities'), false)
      }
    } finally {
      s.close()
    }
  }
})
