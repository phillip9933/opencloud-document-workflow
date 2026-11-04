// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindWorkflowServices } from '../../companion/services.mjs'
test('production composition rejects absent services and replacement before changing the workflow', () => {
  const w = {},
    full = {
      configuration: { settings() {}, destinationSpace() {} },
      metadata: { inspect() {}, read() {}, save() {}, reconcile() {} },
      intake: { configuration() {}, paused() {}, attach() {}, detach() {} },
      automation: { run() {}, guard() {}, statusFor() {} },
      transfers: { adapter() {}, canonical() {}, apply() {} },
      documentTrash: { pending() {}, assertAvailable() {}, process() {} },
      conversions: { convert() {}, association() {} },
      locations: { refresh() {}, locate() {} },
      similarities: { forJob() {} }
    }
  assert.throws(
    () => bindWorkflowServices(w, { ...full, transfers: {} }),
    /Missing workflow service: transfers/
  )
  assert.deepEqual(w, {})
  assert.throws(
    () => bindWorkflowServices({ metadata: {} }, full),
    /Conflicting workflow service: metadata/
  )
  bindWorkflowServices(w, full)
  assert.equal(w.metadata, full.metadata)
  assert.throws(() => {
    w.metadata = {}
  }, TypeError)
})

test('constructors do not register dependencies and unbound workflows fail closed', async () => {
  const { Workflow } = await import('../../companion/workflow.mjs')
  const { ProposalJournal } = await import('../../companion/journal.mjs')
  const { Configuration } = await import('../../companion/configuration.mjs')
  const { Metadata } = await import('../../companion/metadata.mjs')
  const { Transfers } = await import('../../companion/transfers.mjs')
  const { DocumentLibrary } = await import('../../companion/documents.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'service-composition-'))
  const journal = new ProposalJournal(join(directory, 'journal.sqlite3'))
  try {
    const workflow = new Workflow(journal)
    new Configuration(workflow)
    new Metadata(workflow)
    new Transfers(workflow)
    new DocumentLibrary(workflow)
    for (const name of ['configuration', 'metadata', 'transfers', 'locations']) {
      assert.equal(Object.hasOwn(workflow, name), false)
      assert.throws(
        () => workflow[name],
        (error) => error.code === 'INTERNAL_ERROR'
      )
    }
  } finally {
    journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
