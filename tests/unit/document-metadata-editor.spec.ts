// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils'
import DocumentMetadataEditor from '../../src/components/DocumentMetadataEditor.vue'
import TagPicker from '../../src/components/TagPicker.vue'
import type { DocumentDetail } from '../../src/domain/document-details'

function fixture(): DocumentDetail {
  return {
    source: {
      path: 'Filed/example.pdf',
      resourceId: 'fixture',
      etag: 'v1',
      sha256: 'a'.repeat(64),
      tags: ['Keep']
    },
    schema: {
      fields: [
        { id: 'amount', label: 'Amount', type: 'number', aliases: [], choices: [] },
        { id: 'date', label: 'Date', type: 'date', aliases: [], choices: [] },
        { id: 'kind', label: 'Kind', type: 'choice', aliases: [], choices: ['Invoice', 'Receipt'] },
        { id: 'reference', label: 'Reference', type: 'text', aliases: [], choices: [] }
      ],
      tags: ['Keep', 'Invoice', 'Tax', 'Vehicle'].map((tag) => ({ tag, terms: [] as string[] }))
    },
    record: { version: 2, fields: { amount: 0, kind: 'Invoice' } },
    suggestions: {
      fields: { amount: { value: 12.5, evidence: [{ page: 1, quote: 'Total 12.50' }] } },
      tags: [
        { value: 'Invoice', evidence: [{ page: 1, quote: 'Invoice' }] },
        { value: 'Keep', evidence: [{ page: 1, quote: 'Keep' }] }
      ]
    },
    pending: []
  }
}
function setup(overrides = {}) {
  return mount(DocumentMetadataEditor, {
    props: {
      data: fixture(),
      values: { amount: 0, date: '', kind: 'Invoice', reference: '' },
      tags: 'Tax',
      busy: false,
      blocked: false,
      loading: false,
      dirty: true,
      saveNeedsCheck: false,
      ...overrides
    }
  })
}

it('edits each field type without mutating saved metadata or the supplied draft', async () => {
  const wrapper = setup(),
    before = fixture(),
    draft = { ...wrapper.props('values') }
  expect(wrapper.findAll('#field-kind')).toHaveLength(1)
  expect(wrapper.get('#field-kind').element.tagName).toBe('SELECT')
  for (const [id, value, expected] of [
    ['amount', '9.75', 9.75],
    ['amount', '', ''],
    ['date', '2026-11-04', '2026-11-04'],
    ['kind', 'Receipt', 'Receipt'],
    ['reference', 'AB-123', 'AB-123']
  ] as const) {
    await wrapper.get(`#field-${id}`).setValue(value)
    expect(wrapper.emitted('update:values')?.at(-1)).toEqual([{ ...draft, [id]: expected }])
  }
  expect(wrapper.props('data')).toEqual(before)
  expect(wrapper.props('values')).toEqual(draft)
  wrapper.unmount()
})

it('keeps evidence with suggestions and excludes already saved or selected tags', async () => {
  const wrapper = setup()
  expect(wrapper.text()).toContain('Total 12.50')
  expect(wrapper.text()).toContain('Page 1')
  expect(wrapper.getComponent(TagPicker).props('options')).toEqual(['Vehicle'])
  expect(wrapper.find('[aria-label="Add tag Keep"]').exists()).toBe(false)
  await wrapper.get('.metadata-field .metadata-suggestion button').trigger('click')
  expect(wrapper.emitted('update:values')?.at(-1)?.[0]).toMatchObject({ amount: 12.5 })
  await wrapper.get('[aria-label="Add tag Invoice"]').trigger('click')
  expect(wrapper.emitted('update:tags')?.at(-1)).toEqual(['Tax, Invoice'])
  await wrapper.setProps({ tags: 'Tax, Invoice' })
  expect(wrapper.find('[aria-label="Add tag Invoice"]').exists()).toBe(false)
  expect(wrapper.props('data').source.tags).toEqual(['Keep'])
  wrapper.unmount()
})

it.each(['busy', 'blocked', 'saveNeedsCheck', 'pending', 'clean'])(
  'prevents form submission while %s',
  async (state) => {
    const data = fixture()
    if (state === 'pending') data.pending = [{ id: 'uncertain-write', state: 'pending' }]
    const wrapper = setup({
      data,
      busy: state === 'busy',
      blocked: state === 'blocked',
      saveNeedsCheck: state === 'saveNeedsCheck',
      dirty: state !== 'clean'
    })
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.unmount()
  }
)

it('allows an eligible save and keeps verification and cancel events separate', async () => {
  const wrapper = setup()
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('save')).toHaveLength(1)
  await wrapper.setProps({ saveNeedsCheck: true })
  expect(wrapper.text()).toContain('Verify the last save before continuing')
  const button = (label: string) => wrapper.findAll('button').find((row) => row.text() === label)!
  await button('Reload').trigger('click')
  expect(wrapper.emitted('reload')).toHaveLength(1)
  await button('Cancel').trigger('click')
  expect(wrapper.emitted('cancel')).toHaveLength(1)
  expect(wrapper.emitted('save')).toHaveLength(1)
  wrapper.unmount()
})

it('blocks suggestion changes during a pending Trash outcome', async () => {
  const wrapper = setup({ blocked: true })
  await wrapper.get('.metadata-field .metadata-suggestion button').trigger('click')
  await wrapper.get('[aria-label="Add tag Invoice"]').trigger('click')
  await wrapper.get('#field-reference').setValue('changed')
  expect(wrapper.emitted('update:values')).toBeUndefined()
  expect(wrapper.emitted('update:tags')).toBeUndefined()
  wrapper.unmount()
})
