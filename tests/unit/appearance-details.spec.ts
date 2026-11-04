import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createHash } from 'node:crypto'
import { createTheme } from '../../src/state/theme'
import WorkspaceShell from '../../src/components/WorkspaceShell.vue'
import DocumentDetails from '../../src/views/DocumentDetails.vue'
import Settings from '../../src/views/Settings.vue'
import { workspaceChildren } from '../../src/routes'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
function media(initial = false) {
  const listeners = new Set<(event: any) => void>()
  return {
    query: {
      matches: initial,
      addEventListener: (_kind: string, fn: any) => listeners.add(fn),
      removeEventListener: (_kind: string, fn: any) => listeners.delete(fn)
    } as unknown as MediaQueryList,
    change(value: boolean) {
      for (const fn of listeners) fn({ matches: value })
    },
    listeners
  }
}
afterEach(() => vi.unstubAllGlobals())
it('system appearance follows device changes while an explicit selection persists across controllers', () => {
  const values = new Map<string, string>(),
    storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v)
      }
    },
    m = media(),
    theme = createTheme(storage, m.query)
  theme.start()
  expect(theme.effective.value).toBe('light')
  m.change(true)
  expect(theme.effective.value).toBe('dark')
  theme.set('light')
  m.change(true)
  expect(theme.effective.value).toBe('light')
  expect(createTheme(storage, m.query).preference.value).toBe('light')
  theme.set('system')
  expect(theme.effective.value).toBe('dark')
  theme.stop()
  expect(m.listeners.size).toBe(0)
  expect([...values.keys()]).toEqual(['document-workflow:appearance'])
})
it('invalid or unavailable browser storage never blocks theme selection', () => {
  const theme = createTheme(
    {
      getItem: () => '<invalid>',
      setItem: () => {
        throw new Error('blocked')
      }
    },
    media(true).query
  )
  expect(theme.preference.value).toBe('system')
  expect(theme.effective.value).toBe('dark')
  theme.set('light')
  expect(theme.effective.value).toBe('light')
  theme.set('invalid')
  expect(theme.preference.value).toBe('light')
})
it('appearance controls update the scoped shell without contacting a document or model provider', async () => {
  const values = new Map<string, string>(),
    m = media(true),
    fetch = vi.fn()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v)
  })
  vi.stubGlobal('matchMedia', () => m.query)
  vi.stubGlobal('fetch', fetch)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow', component: WorkspaceShell, children: workspaceChildren }]
  })
  await router.push('/document-workflow/settings/appearance')
  const w = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
  await flushPromises()
  expect(w.get('.dw-shell').attributes('data-theme')).toBe('dark')
  await w.get('#appearance-mode').setValue('light')
  expect(w.get('.dw-shell').attributes('data-theme')).toBe('light')
  await w.get('#appearance-mode').setValue('system')
  m.change(false)
  await flushPromises()
  expect(w.get('.dw-shell').attributes('data-theme')).toBe('light')
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).endsWith('/spaces'))
  ).toHaveLength(0)
  w.unmount()
  expect(m.listeners.size).toBe(0)
})
function detail(path = 'Inbox/one.pdf') {
  return {
    source: {
      path,
      resourceId: path,
      etag: 'v1',
      sha256: createHash('sha256').update('pdf').digest('hex'),
      tags: ['Keep']
    },
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
    record: { version: 3, fields: { invoice: 'SAVED-42' } },
    suggestions: {
      fields: {
        invoice: {
          value: 'EXTRACTED-99',
          evidence: [{ page: 1, quote: 'Invoice number EXTRACTED-99' }]
        }
      },
      tags: [{ value: 'Household', evidence: [{ page: 1, quote: 'Electricity' }] }]
    },
    pending: [] as { id: string; state: string }[]
  }
}
async function setup(request: any, path = '/document-workflow/details?path=Inbox%2Fone.pdf') {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'fixture',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  vi.spyOn(store, 'request').mockImplementation((operation, body) =>
    operation === 'preview' ? Promise.resolve(new Blob(['pdf'])) : request(operation, body)
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/:rest(.*)', component: DocumentDetails }]
  })
  await router.push(path)
  const w = mount(DocumentDetails, {
    global: {
      plugins: [router],
      provide: { [workspaceKey as symbol]: store },
      stubs: { PdfPreview: true }
    }
  })
  await flushPromises()
  return { w, router, store }
}
it('shows saved details without an editing form or extracted quotes until Edit details is chosen', async () => {
  const request = vi.fn(async (_op: string) => detail()),
    { w } = await setup(request)
  expect(w.text()).toContain('SAVED-42')
  expect(w.find('form').exists()).toBe(false)
  expect(w.text()).not.toContain('Invoice number EXTRACTED-99')
  expect(
    request.mock.calls.filter((c) => !['tag-options', 'document-processing'].includes(c[0]))
  ).toHaveLength(1)
  await w
    .findAll('button')
    .find((b) => b.attributes('aria-label') === 'Edit details')!
    .trigger('click')
  expect(w.get('#field-invoice').element).toHaveProperty('value', 'SAVED-42')
  expect(w.get('details.metadata-suggestion').attributes('open')).toBeUndefined()
  await w
    .findAll('button')
    .find((b) => b.text() === 'Cancel')!
    .trigger('click')
  expect(w.find('form').exists()).toBe(false)
  expect(
    request.mock.calls.filter((c) => !['tag-options', 'document-processing'].includes(c[0]))
  ).toHaveLength(1)
  w.unmount()
})
it('saves an exact resource/version-bound edit and only additional tags after an explicit submit', async () => {
  let saved = detail()
  const calls: any[] = []
  const { w } = await setup(async (op: string, body: any) => {
    calls.push({ op, body })
    if (op === 'metadata-save') {
      saved = {
        ...saved,
        record: { version: 4, fields: body.fields },
        source: { ...saved.source, tags: ['Keep', ...body.addTags] }
      }
      return { state: 'done' }
    }
    return saved
  })
  await w
    .findAll('button')
    .find((b) => b.attributes('aria-label') === 'Edit details')!
    .trigger('click')
  await w.get('#field-invoice').setValue('EDITED-42')
  await w.get('#extra-tags').setValue('Reviewed')
  await w.get('#extra-tags').trigger('keydown', { key: 'Enter' })
  expect(calls.some((c) => c.op === 'metadata-save')).toBe(false)
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(calls.find((c) => c.op === 'metadata-save').body).toMatchObject({
    resourceId: 'Inbox/one.pdf',
    etag: 'v1',
    version: 3,
    fields: { invoice: 'EDITED-42' },
    addTags: ['Reviewed']
  })
  expect(w.find('form').exists()).toBe(false)
  expect(w.text()).toContain('EDITED-42')
  expect(w.text()).toContain('Keep')
  expect(w.text()).toContain('Reviewed')
  w.unmount()
})
it('retains a failed save draft and requires a saved-state check rather than repeating the write', async () => {
  let writes = 0
  const { w } = await setup(async (op: string) => {
    if (op === 'metadata-save') {
      writes++
      throw new Error('Connection lost during save')
    }
    return detail()
  })
  await w
    .findAll('button')
    .find((b) => b.attributes('aria-label') === 'Edit details')!
    .trigger('click')
  await w.get('#field-invoice').setValue('DO-NOT-LOSE')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.get('#field-invoice').element).toHaveProperty('value', 'DO-NOT-LOSE')
  expect(w.text()).toContain('Verify the last save before continuing')
  expect(
    w
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .attributes('disabled')
  ).toBeDefined()
  await w.get('form').trigger('submit')
  expect(writes).toBe(1)
  w.unmount()
})
it('discards a stale document load after navigation selects a different document', async () => {
  let finish!: (value: any) => void
  const { w, router } = await setup(async (_op: string, body: any) =>
    body.path === 'Inbox/one.pdf'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : detail(body.path)
  )
  await router.push('/document-workflow/details?path=Inbox%2Ftwo.pdf')
  await flushPromises()
  expect(w.get('h1').text()).toBe('two.pdf')
  finish(detail())
  await flushPromises()
  expect(w.get('h1').text()).toBe('two.pdf')
  w.unmount()
})
it('pending metadata is verified without an additional save or tag request', async () => {
  let pending = true
  const calls: string[] = []
  const { w } = await setup(async (op: string) => {
    calls.push(op)
    if (op === 'metadata-reconcile') {
      pending = false
      return { state: 'done' }
    }
    return { ...detail(), pending: pending ? [{ id: 'pending-fixture', state: 'intent' }] : [] }
  })
  expect(
    w
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'Edit details')!
      .attributes('disabled')
  ).toBeDefined()
  await w
    .findAll('button')
    .find((b) => b.text() === 'Verify')!
    .trigger('click')
  await flushPromises()
  expect(calls.filter((op) => op !== 'document-processing')).toEqual([
    'metadata',
    'metadata-reconcile',
    'metadata'
  ])
  expect(w.text()).toContain('Verified')
  w.unmount()
})

it('lets the operator prioritize any discovered OCR language without hardcoded language choices', async () => {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'fixture',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  const request = vi
    .spyOn(store, 'request')
    .mockImplementation(async (op: string) =>
      op === 'ocr-languages'
        ? { installed: ['eng', 'jpn', 'fra'], selected: ['eng', 'jpn'] }
        : ({} as any)
    )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/settings/:section?', component: Settings }]
  })
  await router.push('/document-workflow/settings/automation')
  const w = mount(Settings, {
    global: {
      plugins: [router],
      provide: { [workspaceKey as symbol]: store },
      stubs: { ReliabilityStatus: true }
    }
  })
  await flushPromises()
  await w.get('select[aria-label="Primary OCR language"]').setValue('jpn')
  await w
    .findAll('button')
    .find((b) => b.text() === 'Save languages')!
    .trigger('click')
  await flushPromises()
  expect(request).toHaveBeenCalledWith('ocr-settings', { languages: ['jpn', 'eng'] })
  expect(w.text()).toContain('Saved')
  w.unmount()
})
it('an old tag verification cannot replace details after navigation', async () => {
  let finish!: (value: any) => void
  const { w, router } = await setup(async (op: string, body: any) =>
    op === 'metadata-reconcile'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : {
          ...detail(body.path),
          pending: body.path === 'Inbox/one.pdf' ? [{ id: 'first', state: 'intent' }] : []
        }
  )
  await w
    .findAll('button')
    .find((b) => b.text() === 'Verify')!
    .trigger('click')
  await router.push('/document-workflow/details?path=Inbox%2Ftwo.pdf')
  await flushPromises()
  finish({ state: 'done' })
  await flushPromises()
  expect(w.get('h1').text()).toBe('two.pdf')
  expect(w.text()).not.toContain('Verified')
  w.unmount()
})

it('loads background access and backup status separately on direct Settings reload', async () => {
  const store = createWorkspace()
  vi.spyOn(store, 'connect').mockImplementation(async () => {
    store.connection.value = {
      server: 'https://fixture.example',
      account: 'fixture',
      space: 'space',
      mode: 'demo',
      name: 'Tester'
    }
  })
  const request = vi.spyOn(store, 'request').mockResolvedValue({
    backgroundSession: { configured: false, state: 'not_configured' },
    backups: { configured: true, state: 'ready', lastSuccess: 1 }
  })
  const { default: Reliability } = await import('../../src/components/ReliabilityStatus.vue')
  const w = mount(Reliability, { global: { provide: { [workspaceKey as symbol]: store } } })
  await flushPromises()
  expect(
    request.mock.calls.filter((c) => !['tag-options', 'document-processing'].includes(c[0]))
  ).toHaveLength(1)
  expect(w.text()).toContain('Local simulated worker')
  w.unmount()
  const { default: Backups } = await import('../../src/components/BackupSettings.vue')
  const b = mount(Backups, { global: { provide: { [workspaceKey as symbol]: store } } })
  await flushPromises()
  expect(b.text()).toContain('Verified backups available')
  b.unmount()
})

it('adds selected saved tags to the draft and preserves existing tags until an explicit save', async () => {
  let saved = detail()
  saved.schema.tags = [
    { tag: 'Person: Sora', terms: [] },
    { tag: 'Warranty', terms: [] },
    { tag: 'Keep', terms: [] },
    { tag: 'Household', terms: ['Electricity'] }
  ]
  const calls: { op: string; body: any }[] = []
  const { w } = await setup(async (op: string, body: any) => {
    calls.push({ op, body })
    if (op === 'metadata-save') {
      saved = {
        ...saved,
        record: { ...saved.record, version: 4 },
        source: { ...saved.source, tags: [...saved.source.tags, ...body.addTags] }
      }
      return { state: 'done' }
    }
    return saved
  })
  try {
    expect(w.find('[aria-label="Saved tags"]').exists()).toBe(false)
    await w
      .findAll('button')
      .find((button) => button.attributes('aria-label') === 'Edit details')!
      .trigger('click')
    await w.get('#extra-tags').trigger('focus')
    const library = w.get('[aria-label="Available tags"]')
    expect(library.text()).not.toContain('Keep')
    expect(library.text()).not.toContain('Household')
    await w.get('[aria-label="Add tag Person: Sora"]').trigger('click')
    await w.get('[aria-label="Add tag Warranty"]').trigger('click')
    expect(w.get('.selected-tags').text()).toContain('Person: Sora')
    expect(w.get('.selected-tags').text()).toContain('Warranty')
    expect(w.find('[aria-label="Add tag Person: Sora"]').exists()).toBe(false)
    expect(calls.some((call) => call.op === 'metadata-save')).toBe(false)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(calls.find((call) => call.op === 'metadata-save')?.body).toMatchObject({
      fields: { invoice: 'SAVED-42' },
      addTags: ['Person: Sora', 'Warranty']
    })
    expect(w.text()).toContain('Keep')
    expect(w.text()).toContain('Person: Sora')
    expect(w.text()).toContain('Warranty')
  } finally {
    w.unmount()
  }
})
it('uses verified tag-removal details without reloading metadata or the preview', async () => {
  const before = detail(),
    calls: string[] = []
  const { w } = await setup(async (op: string) => {
    calls.push(op)
    return op === 'metadata-tag-remove'
      ? {
          state: 'done',
          source: { ...before.source, tags: [] as string[] },
          record: { ...before.record, version: 4 }
        }
      : before
  })
  try {
    const n = calls.filter((op) => op === 'metadata').length
    await w.get('[aria-label="Remove tag Keep"]').trigger('click')
    await flushPromises()
    expect(calls.filter((op) => op === 'metadata')).toHaveLength(n)
    expect(w.find('[aria-label="Remove tag Keep"]').exists()).toBe(false)
    expect(w.text()).toContain('SAVED-42')
    expect(w.emitted('changed')?.at(-1)).toEqual([
      expect.objectContaining({
        resourceId: before.source.resourceId,
        tags: [],
        fields: before.record.fields
      })
    ])
  } finally {
    w.unmount()
  }
})
