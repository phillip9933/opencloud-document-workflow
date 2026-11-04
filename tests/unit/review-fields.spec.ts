import { mount, flushPromises } from '@vue/test-utils'
import ReviewFields from '../../src/components/ReviewFields.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
const resourceId = 'fixture-resource',
  sha256 = 'a'.repeat(64),
  path = 'Inbox/invoice.pdf'
function metadata() {
  return {
    source: { path, resourceId, sha256, etag: 'v1', tags: ['Keep'] },
    schema: {
      fields: [
        {
          id: 'invoice',
          label: 'Invoice number',
          type: 'text',
          aliases: ['Invoice number'],
          choices: [] as string[]
        }
      ],
      tags: [] as { tag: string; terms: string[] }[]
    },
    record: { version: 0, fields: {} as Record<string, string | number> },
    suggestions: {
      fields: {
        invoice: { value: 'TEST-42', evidence: [{ page: 1, quote: 'Invoice number: TEST-42' }] }
      },
      tags: [{ value: 'Household', evidence: [{ page: 1, quote: 'Electricity invoice' }] }]
    },
    pending: [] as { id: string; state: string }[]
  }
}
function editor(store: ReturnType<typeof createWorkspace>) {
  return mount(ReviewFields, {
    props: { path, resourceId, sha256, editableTags: true },
    global: {
      provide: { [workspaceKey as symbol]: store },
      stubs: { RouterLink: { template: '<a><slot /></a>' } }
    }
  })
}
it('only saves chosen field values on explicit save and never writes OpenCloud tags', async () => {
  const store = createWorkspace(),
    data = metadata(),
    calls: { operation: string; body: any }[] = []
  vi.spyOn(store, 'request').mockImplementation(async (operation, body: any) => {
    calls.push({ operation, body })
    if (operation === 'metadata-save') {
      data.record = { version: 1, fields: body.fields }
      return { state: 'done' }
    }
    return JSON.parse(JSON.stringify(data))
  })
  const w = editor(store)
  await flushPromises()
  expect(calls.map((c) => c.operation)).toEqual(['metadata'])
  await w
    .findAll('button')
    .find((b) => b.text() === 'TEST-42')!
    .trigger('click')
  await flushPromises()
  expect(calls.map((c) => c.operation)).toEqual(['metadata'])
  await w
    .findAll('button')
    .find((b) => b.text() === 'Household')!
    .trigger('click')
  expect(w.emitted('tag')?.[0]).toEqual(['Household'])
  expect(w.get('[aria-label="Add tag Household"]').classes()).toContain('tag-choice')
  expect(
    w
      .findAll('button')
      .find((b) => b.text() === 'Save fields')!
      .classes()
  ).toContain('primary')
  expect(calls.some((c) => c.operation === 'metadata-save')).toBe(false)
  await w
    .findAll('button')
    .find((b) => b.text() === 'Save fields')!
    .trigger('click')
  await flushPromises()
  expect(calls.find((c) => c.operation === 'metadata-save')?.body).toMatchObject({
    path,
    resourceId,
    sha256,
    version: 0,
    fields: { invoice: 'TEST-42' },
    addTags: []
  })
  expect(w.text()).toContain('Saved')
  expect(store.fieldDrafts.value).toEqual({})
  w.unmount()
})
it('retains unsaved field values across leaving and returning without saving them', async () => {
  const store = createWorkspace(),
    request = vi.spyOn(store, 'request').mockResolvedValue(metadata())
  let w = editor(store)
  await flushPromises()
  await w.get('#review-field-invoice').setValue('UNSAVED')
  w.unmount()
  w = editor(store)
  await flushPromises()
  expect((w.get('#review-field-invoice').element as HTMLInputElement).value).toBe('UNSAVED')
  expect(request.mock.calls.every((c) => c[0] === 'metadata')).toBe(true)
  w.unmount()
})
it('holds an older draft when another client has saved newer field values', async () => {
  const store = createWorkspace(),
    data = metadata()
  data.record = { version: 2, fields: { invoice: 'NEWER' } }
  store.fieldDrafts.value[JSON.stringify([resourceId, sha256])] = {
    version: 1,
    values: { invoice: 'MY DRAFT' }
  }
  vi.spyOn(store, 'request').mockResolvedValue(data)
  const w = editor(store)
  await flushPromises()
  expect(w.text()).toContain('Fields changed elsewhere')
  expect(
    w
      .findAll('button')
      .find((b) => b.text() === 'Save fields')!
      .attributes('disabled')
  ).toBeDefined()
  await w
    .findAll('button')
    .find((b) => b.text() === 'Restore saved values')!
    .trigger('click')
  expect((w.get('#review-field-invoice').element as HTMLInputElement).value).toBe('NEWER')
  expect(store.fieldDrafts.value).toEqual({})
  w.unmount()
})
it('refuses field editing when the current PDF differs from the reviewed source', async () => {
  const store = createWorkspace(),
    data = metadata()
  data.source.sha256 = 'b'.repeat(64)
  const request = vi.spyOn(store, 'request').mockResolvedValue(data)
  const w = editor(store)
  await flushPromises()
  expect(w.text()).toContain('The source document changed')
  expect(w.find('#review-field-invoice').exists()).toBe(false)
  expect(request.mock.calls.map((c) => c[0])).toEqual(['metadata'])
  w.unmount()
})

it('offers saved manual tags as explicit choices without inventing evidence or writing metadata', async () => {
  const store = createWorkspace(),
    data = metadata()
  data.schema.tags = [
    { tag: 'Person: Sora', terms: [] },
    { tag: 'Warranty', terms: [] },
    { tag: 'Keep', terms: [] },
    { tag: 'Household', terms: ['Electricity'] }
  ]
  const request = vi.spyOn(store, 'request').mockResolvedValue(data),
    wrapper = editor(store)
  try {
    await flushPromises()
    wrapper.get('.manual-tag-input').element.setAttribute('open', '')
    await wrapper.get('#manual-tags').trigger('focus')
    const library = wrapper.get('[role="group"][aria-label="Available tags"]')
    expect(library.text()).toContain('Person: Sora')
    expect(library.text()).toContain('Warranty')
    expect(library.text()).not.toContain('Keep')
    expect(library.text()).not.toContain('Household')
    expect(library.find('blockquote').exists()).toBe(false)
    expect(
      wrapper.findAll('button').filter((button) => button.text() === 'Household')
    ).toHaveLength(1)
    await wrapper.get('[aria-label="Add tag Person: Sora"]').trigger('click')
    expect(wrapper.emitted('tags')).toEqual([['Person: Sora']])
    expect(request.mock.calls.map((call) => call[0])).toEqual(['metadata'])
    await wrapper.setProps({ locked: true })
    expect(wrapper.get('[aria-label="Add tag Warranty"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ editableTags: false })
    expect(wrapper.find('.manual-tag-input').exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})
