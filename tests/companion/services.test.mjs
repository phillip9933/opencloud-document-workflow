// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindWorkflowServices } from '../../companion/services.mjs'
test('production composition rejects absent services and replacement before changing the workflow', () => {
  const w = {},
    full = {
      configuration: { settings() {}, destinationSpace() {} },
      metadata: { inspect() {}, read() {}, save() {}, reconcile() {} },
      intake: { configuration() {}, attach() {}, detach() {} },
      automation: { run() {}, guard() {}, statusFor() {} },
      transfers: { adapter() {}, canonical() {}, apply() {} },
      documentTrash: { pending() {}, assertAvailable() {}, process() {} },
      conversions: { convert() {}, association() {} },
      locations: { refresh() {} },
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
