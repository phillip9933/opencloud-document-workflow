import { mount, flushPromises } from '@vue/test-utils'
import type { DraftJob } from '../../src/state/workspace'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
import FilingSettings from '../../src/components/FilingSettings.vue'
import BatchReview from '../../src/components/BatchReview.vue'
import { defaultFilingRules } from '../../src/domain/filing'
import { samples } from '../../src/domain/samples'
import { validateBundle, reviewDigest } from '../../src/domain/review'
function workspace() {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://opencloud.example',
    account: 'person',
    space: 'work',
    mode: 'demo',
    name: 'Tester'
  }
  return store
}
it('saves edited filing/capacity settings only on explicit submit and does not call a provider', async () => {
  const store = workspace(),
    request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (operation) =>
        operation === 'filing-settings'
          ? {
              rules: defaultFilingRules(),
              limits: {
                maxMiB: 100,
                maxPages: 1000,
                maxCharacters: 1000000,
                contextTokens: 32768,
                documentsPerCycle: 20
              }
            }
          : {}
      )
  const wrapper = mount(FilingSettings, {
    global: { provide: { [workspaceKey as symbol]: store } }
  })
  await flushPromises()
  await wrapper.find('summary').trigger('click')
  await wrapper.get('input').setValue('Archive')
  expect(request.mock.calls.map((call) => call[0])).toEqual(['filing-settings'])
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(request.mock.calls[1]).toMatchObject([
    'filing-settings-save',
    { rules: { root: 'Archive' }, limits: { maxPages: 1000 } }
  ])
  expect(wrapper.text()).toContain('Saved. New documents use these rules.')
  wrapper.unmount()
})
it('shows exact batch plans and sends document-bound digests only after approve-and-file is clicked', async () => {
  const store = workspace(),
    reviews = samples()
      .slice(0, 2)
      .map((b) => validateBundle(b))
  store.reviews.value = reviews
  store.jobs.value = reviews.map((review, index): DraftJob => ({
    id: 'job-' + index,
    source: review.bundle.source,
    bundle: review.bundle,
    state: 'needs_review',
    decision: null,
    updated: '2026-10-31T00:00:00.000Z',
    error: null
  }))
  vi.spyOn(store, 'jobFor').mockImplementation((review) =>
    store.jobs.value.find((job) => job.source.resourceId === review.bundle.source.resourceId)
  )
  vi.spyOn(store, 'connect').mockResolvedValue({})
  const request = vi
      .spyOn(store, 'request')
      .mockImplementation(async () => ({ id: 'operation', state: 'completed', items: [] })),
    wrapper = mount(BatchReview, { global: { provide: { [workspaceKey as symbol]: store } } })
  expect(wrapper.text()).toContain('Filed/Utilities/Electricity/')
  expect(request).not.toHaveBeenCalled()
  await wrapper
    .findAll('button')
    .find((b) => b.text() === 'Select all shown plans')!
    .trigger('click')
  expect(request).not.toHaveBeenCalled()
  await wrapper
    .findAll('button')
    .find((b) => b.text() === 'Approve and file 2 selected documents')!
    .trigger('click')
  await vi.waitFor(() =>
    expect(request.mock.calls.some((call) => call[0] === 'operation-start')).toBe(true)
  )
  const body: any = request.mock.calls.find((call) => call[0] === 'operation-start')![1]
  expect(body.kind).toBe('file')
  expect(body.items).toHaveLength(2)
  expect(body.items[0].reviewDigest).toBe(await reviewDigest(reviews[0]!, store.policy.value))
  wrapper.unmount()
})
it('navigates to the registered filing and background settings pages without losing the app shell', async () => {
  const { createRouter, createMemoryHistory } = await import('vue-router'),
    { workspaceChildren } = await import('../../src/routes'),
    store = workspace()
  vi.spyOn(store, 'request').mockImplementation(async (op) =>
    op === 'filing-settings'
      ? {
          rules: defaultFilingRules(),
          limits: {
            maxMiB: 100,
            maxPages: 1000,
            maxCharacters: 1000000,
            contextTokens: 32768,
            documentsPerCycle: 20
          }
        }
      : op === 'reliability'
        ? { backgroundSession: { configured: false }, backups: { configured: false } }
        : {}
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/document-workflow',
        component: { template: '<RouterView />' },
        children: workspaceChildren
      }
    ]
  })
  await router.push('/document-workflow/settings')
  const wrapper = mount(
    { template: '<RouterView />' },
    { global: { plugins: [router], provide: { [workspaceKey as symbol]: store } } }
  )
  await flushPromises()
  await wrapper
    .findAll('a')
    .find((a) => a.text() === 'Folders')!
    .trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Destination folder')
  expect(router.currentRoute.value.params.section).toBe('folders')
  await wrapper
    .findAll('a')
    .find((a) => a.text() === 'System')!
    .trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Backups not configured')
  expect(router.currentRoute.value.params.section).toBe('system')
  expect(wrapper.find('h1').exists()).toBe(true)
  wrapper.unmount()
})

it('saves category-specific year patterns and removes empty overrides without changing inherited rules', async () => {
  const store = workspace(),
    original = defaultFilingRules(),
    request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (operation) =>
        operation === 'filing-settings'
          ? {
              rules: structuredClone(original),
              limits: {
                maxMiB: 100,
                maxPages: 1000,
                maxCharacters: 1000000,
                contextTokens: 32768,
                documentsPerCycle: 20
              }
            }
          : {}
      )
  const wrapper = mount(FilingSettings, {
    global: { provide: { [workspaceKey as symbol]: store } }
  })
  try {
    await flushPromises()
    expect(wrapper.findAll('.category-pattern')).toHaveLength(original.folders.length)
    await wrapper.get('[aria-label="Rule 1: subfolder pattern"]').setValue('{category}/{taxYear}')
    await wrapper.get('[aria-label="Rule 1: tax-year labels"]').setValue('Tax year, 対象年')
    expect(request.mock.calls.some((call) => call[0] === 'filing-settings-save')).toBe(false)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const saved: any = request.mock.calls
      .filter((call) => call[0] === 'filing-settings-save')
      .at(-1)![1]
    expect(saved.rules.folders[0]).toMatchObject({
      folderTemplate: '{category}/{taxYear}',
      taxYearLabels: ['Tax year', '対象年']
    })
    expect(saved.rules.folders[1]).toEqual(original.folders[1])
    expect(saved.rules.tags).toEqual(original.tags)
    await wrapper.get('[aria-label="Rule 1: subfolder pattern"]').setValue('')
    expect(wrapper.find('[aria-label="Rule 1: tax-year labels"]').exists()).toBe(false)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(
      (request.mock.calls.filter((call) => call[0] === 'filing-settings-save').at(-1)![1] as any)
        .rules
    ).toEqual(original)
  } finally {
    wrapper.unmount()
  }
})
