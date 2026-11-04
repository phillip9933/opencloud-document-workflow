// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils'
import ReviewDecisionActions from '../../src/components/ReviewDecisionActions.vue'
import ReviewFilingPlan from '../../src/components/ReviewFilingPlan.vue'
import type { DraftJob } from '../../src/state/workspace'
import { samples } from '../../src/domain/samples'
import { validateBundle, defaultPolicy } from '../../src/domain/review'
const review = () => validateBundle(samples()[0]!)
function job(decision: string | null = null): DraftJob {
  const active = review()
  return {
    id: 'synthetic',
    source: active.bundle.source,
    bundle: active.bundle,
    state: 'needs_review',
    decision,
    updated: '',
    error: null
  }
}
function decisions(record: DraftJob | undefined = job(), overrides = {}) {
  return mount(ReviewDecisionActions, {
    props: {
      job: record,
      disabled: false,
      acceptDisabled: false,
      fieldsUncertain: false,
      fieldEditsPending: false,
      previewChanged: false,
      busy: false,
      preparingFresh: false,
      exportDisabled: false,
      verification: null,
      ...overrides
    }
  })
}
it.each([
  ['approved', 'Continue filing', 'apply'],
  ['folders_pending', 'Continue filing', 'apply'],
  ['move_done', 'Continue filing', 'apply'],
  ['transfer_ready', 'Continue filing', 'apply'],
  ['move_intent', 'Verify outcome', 'reconcile'],
  ['tags_intent', 'Verify outcome', 'reconcile'],
  ['copy_intent', 'Verify outcome', 'reconcile'],
  ['done', 'Verify file', 'reconcile']
])('shows only the correct next action for %s', async (state, label, event) => {
  const wrapper = decisions(job(state))
  expect(wrapper.findAll('button').map((button) => button.text())).toEqual([label])
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('decide')).toEqual([[event]])
  await wrapper.setProps({ disabled: true })
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('decide')).toHaveLength(1)
  wrapper.unmount()
})
it('holds acceptance for changed bytes or unsaved fields without hiding rejection', async () => {
  const wrapper = decisions(job(), {
    acceptDisabled: true,
    previewChanged: true,
    fieldEditsPending: true
  })
  expect(wrapper.text()).toContain('Document changed')
  expect(wrapper.text()).toContain('Save field changes before filing')
  await wrapper.get('button.primary').trigger('click')
  expect(wrapper.emitted('decide')).toBeUndefined()
  await wrapper.get('button.subtle').trigger('click')
  expect(wrapper.emitted('decide')).toEqual([['reject']])
  wrapper.unmount()
})
it('keeps read-only outcome verification available while metadata is uncertain', () => {
  const pending = decisions(job('tags_intent'), { fieldsUncertain: true })
  expect(pending.get('button').attributes('disabled')).toBeUndefined()
  pending.unmount()
  const continuation = decisions(job('move_done'), { fieldsUncertain: true })
  expect(continuation.get('button').attributes('disabled')).toBeDefined()
  continuation.unmount()
})
it('requires takeover for automatic authorization instead of continuing a human operation', async () => {
  const record = job('approved')
  record.approval = {
    automaticAuthorization: { kind: 'automatic', authorizedAt: '2026-11-04T00:00:00Z' },
    actions: { target: 'Filed/example.pdf', addTags: [] },
    policy: defaultPolicy(),
    reviewDigest: 'fixture'
  }
  const wrapper = decisions(record)
  expect(wrapper.get('button').text()).toBe('Take over')
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('takeOver')).toHaveLength(1)
  expect(wrapper.emitted('decide')).toBeUndefined()
  wrapper.unmount()
})
it('has no filing actions for rejected, conflicted or automatically completed items', () => {
  for (const record of [
    job('rejected'),
    job('conflict'),
    { ...job(), automation: { state: 'done', detail: null } }
  ]) {
    const wrapper = decisions(record)
    expect(wrapper.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  }
})
it('displays current filed location, preserving the original suggestion separately', async () => {
  const active = review(),
    record = job('done'),
    planned = { target: 'Filed/Old/example.pdf', targetSpace: 'archive', addTags: [] as string[] }
  const wrapper = mount(ReviewFilingPlan, {
    props: {
      active,
      job: record,
      planned,
      manual: false,
      manualTarget: '',
      documentPath: 'Docs/New/renamed.pdf',
      documentSpace: 'archive',
      spaces: [{ id: 'archive', name: 'Documents' }],
      disabled: false,
      filingProblem: '',
      destinationBlocked: false
    },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  expect(wrapper.get('.suggested-filename').text()).toBe('renamed.pdf')
  expect(wrapper.get('.target').text()).toContain('Documents')
  expect(wrapper.get('.target').text()).toContain('Docs/New')
  expect(wrapper.find('[aria-label="Edit filing"]').exists()).toBe(false)
  await wrapper.setProps({ job: job() })
  expect(wrapper.get('.suggested-filename').text()).toBe('example.pdf')
  await wrapper.get('[aria-label="Edit filing"]').trigger('click')
  expect(wrapper.emitted('edit')).toHaveLength(1)
  wrapper.unmount()
})
it('keeps manual destination entry available for original files without offering automatic suggestions', () => {
  const active = review()
  active.bundle.manualReview = { reason: 'original' }
  active.bundle.source.path = 'Inbox/drawing.dxf'
  const wrapper = mount(ReviewFilingPlan, {
    props: {
      active,
      job: job(),
      planned: null,
      manual: true,
      manualTarget: 'Docs/drawing.dxf',
      spaces: [],
      disabled: true,
      filingProblem: '',
      destinationBlocked: false
    },
    global: {
      stubs: {
        DestinationPicker: {
          props: ['disabled', 'filename', 'modelValue'],
          template: '<input :disabled="disabled" :value="modelValue" />'
        },
        RouterLink: true
      }
    }
  })
  expect(wrapper.get('input').element.value).toBe('Docs/drawing.dxf')
  expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  expect(wrapper.find('[aria-label="Use suggestions"]').exists()).toBe(false)
  wrapper.unmount()
})
