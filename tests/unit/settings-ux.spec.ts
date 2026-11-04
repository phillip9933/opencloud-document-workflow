// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import Settings from '../../src/views/Settings.vue'
import ReliabilityStatus from '../../src/components/ReliabilityStatus.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
import { defaultFilingRules } from '../../src/domain/filing'
async function setup(path = '/document-workflow/settings/processing') {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'opaque-account-id',
    username: 'person',
    space: 'source',
    mode: 'live',
    name: 'Tester'
  }
  store.spaces.value = [
    { id: 'source', name: 'Inbox Space', type: 'project' },
    { id: 'destination', name: 'Archive Space', type: 'project' }
  ]
  vi.spyOn(store, 'loadSpaces').mockResolvedValue(store.spaces.value)
  const request = vi.spyOn(store, 'request').mockImplementation(async (op) =>
    op === 'ocr-languages'
      ? { installed: ['eng', 'jpn'], selected: ['eng'] }
      : op === 'filing-settings'
        ? {
            rules: defaultFilingRules(),
            destinationSpace: 'destination',
            limits: {
              maxMiB: 100,
              maxPages: 1000,
              maxCharacters: 1000000,
              documentsPerCycle: 20,
              contextTokens: 32768
            }
          }
        : op === 'intake'
          ? {
              configuration: {
                folder: 'Inbox',
                enabled: false,
                recursive: true,
                intervalSeconds: 30,
                settleSeconds: 10,
                cloudConsent: false
              },
              duplicateAction: 'keep',
              destinationSpace: 'destination',
              destinationRoot: 'Filed'
            }
          : op === 'reliability'
            ? {
                backgroundSession: { available: true, configured: false, method: 'app_token' },
                backups: { configured: true, state: 'ready' }
              }
            : {}
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/settings/:section?', component: Settings }]
  })
  await router.push(path)
  const w = mount(Settings, {
    global: { plugins: [router], provide: { [workspaceKey as symbol]: store } }
  })
  await flushPromises()
  return { store, request, router, w }
}
it('offers only review and fully automatic modes, with truthful review choices and automated states', async () => {
  const s = await setup()
  try {
    expect(s.w.get('.settings-tabs').text()).toBe('GeneralFoldersProcessingFields & tagsSystem')
    expect(
      s.w
        .get('#processing-mode')
        .findAll('option')
        .map((o) => o.attributes('value'))
    ).toEqual(['review', 'automatic'])
    expect(s.w.get('#processing-mode').element).toHaveProperty('value', 'review')
    expect(
      s.w
        .get('#rename')
        .findAll('option')
        .map((o) => o.attributes('value'))
    ).toEqual(['off', 'suggest'])
    await s.w.get('#rename').setValue('off')
    expect(s.request.mock.calls.some((c) => c[0] === 'preferences')).toBe(false)
    await s.w.get('#processing-mode').setValue('automatic')
    expect(s.w.find('#rename').exists()).toBe(false)
    expect(s.w.findAll('.processing-state').map((e) => e.text())).toEqual([
      'On',
      'Automated',
      'Automated',
      'Automated'
    ])
    expect(s.w.text()).toContain('Uncertain results stay in the inbox')
    await s.w.get('#processing-mode').setValue('review')
    expect(s.w.get('#rename').element).toHaveProperty('value', 'suggest')
  } finally {
    s.w.unmount()
  }
})
it('keeps Inbox and destination Space selectors beside their folder settings', async () => {
  const s = await setup('/document-workflow/settings/folders')
  try {
    expect(s.w.get('#workspace-space').element).toHaveProperty('value', 'source')
    const destination = s.w
      .findAll('select')
      .find(
        (select) =>
          select.findAll('option').some((o) => o.text() === 'Archive Space') &&
          select.attributes('id') !== 'workspace-space'
      )!
    expect(destination.element).toHaveProperty('value', 'destination')
    expect(s.w.text()).toContain('Filed documents')
    expect(s.w.find('#processing-mode').exists()).toBe(false)
  } finally {
    s.w.unmount()
  }
})
it('preserves selected OCR languages while installing another pack and requires a separate explicit selection save', async () => {
  const s = await setup()
  let installed = false
  try {
    s.request.mockImplementation(async (op) =>
      op === 'ocr-languages'
        ? { installed: installed ? ['eng', 'jpn', 'fra'] : ['eng', 'jpn'], selected: ['eng'] }
        : op === 'ocr-pack-install'
          ? ((installed = true),
            {
              canManage: true,
              enabled: true,
              packs: [],
              installation: { state: 'installed', code: 'fra' }
            })
          : op === 'ocr-packs'
            ? {
                canManage: true,
                enabled: true,
                packs: [{ code: 'fra', bytes: 1000, installed }],
                installation: { state: installed ? 'installed' : 'idle', code: 'fra' }
              }
            : {}
    )
    await s.w
      .findAll('button')
      .find((b) => b.attributes('aria-controls') === 'ocr-language-manager')!
      .trigger('click')
    await flushPromises()
    expect(s.w.get('.manage-languages').attributes('aria-expanded')).toBe('true')
    expect(s.w.get('.manage-languages').element.parentElement).toBe(
      s.w.findAll('button').find((b) => b.text() === 'Save languages')!.element.parentElement
    )
    await s.w.get('[aria-label="Install French"]').trigger('click')
    await flushPromises()
    expect(s.w.get('input[value="eng"]').element).toHaveProperty('checked', true)
    expect(s.w.get('input[value="fra"]').element).toHaveProperty('checked', false)
    expect(s.request.mock.calls.some((c) => c[0] === 'ocr-settings')).toBe(false)
    await s.w.get('.manage-languages').trigger('click')
    expect(s.w.find('#ocr-language-manager').exists()).toBe(false)
  } finally {
    s.w.unmount()
  }
})
it('explains browser-free app-token access and clears the transient secret after connecting without using browser storage', async () => {
  localStorage.clear()
  const s = await setup('/document-workflow/settings/system')
  try {
    s.request.mockImplementation(async (op) =>
      op === 'background-connect'
        ? { configured: true, available: true, state: 'connected', method: 'app_token' }
        : {}
    )
    await s.w
      .findAll('button')
      .find((b) => b.text() === 'Connect app token')!
      .trigger('click')
    await s.w.get('#background-token').setValue('synthetic-only')
    expect(s.w.get('#background-token').attributes('type')).toBe('password')
    await s.w.get('form').trigger('submit')
    await flushPromises()
    expect(s.w.text()).toContain('Connected with an OpenCloud app token')
    expect(s.w.find('#background-token').exists()).toBe(false)
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-only')
    expect(s.request.mock.calls.find((c) => c[0] === 'background-connect')?.[1]).toEqual({
      username: 'person',
      appToken: 'synthetic-only'
    })
  } finally {
    s.w.unmount()
  }
})

it('shows clear field and tag descriptions without an extraction disclosure', async () => {
  const s = await setup('/document-workflow/settings/metadata')
  try {
    expect(s.w.text()).toContain('Add details such as invoice number')
    expect(s.w.text()).toContain(
      'Reusable tags for manual selection or keyword matching, without AI.'
    )
    expect(s.w.text()).not.toContain('Suggested tags')
    expect(s.w.text()).not.toContain('Extraction rules')
  } finally {
    s.w.unmount()
  }
})
it('saves backup controls only on request and keeps the OpenCloud destination in the payload', async () => {
  const { default: BackupSettings } = await import('../../src/components/BackupSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'personal',
    mode: 'live',
    name: 'Tester'
  }
  store.spaces.value = [{ id: 'personal', name: 'Personal', type: 'personal' }]
  const current = {
      configured: true,
      canManage: true,
      state: 'ready',
      storage: { count: 2, bytes: 1024 },
      settings: { enabled: true, intervalMinutes: 360, maxSnapshots: 28, maxMiB: 1024 }
    },
    request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (op, body: any) =>
        op === 'reliability'
          ? { backups: current }
          : op === 'backup-settings-save'
            ? { ...current, settings: body.settings }
            : {}
      ),
    w = mount(BackupSettings, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await w.get('#backup-frequency').setValue(2)
    await w.get('#backup-amount').setValue(50)
    await w.get('#backup-storage').setValue(2048)
    await w.get('#backup-folder').setValue('Backups/Document Workflow')
    expect(request.mock.calls.some((c) => c[0] === 'backup-settings-save')).toBe(false)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('backup-settings-save', {
      settings: {
        enabled: true,
        intervalMinutes: 120,
        maxSnapshots: 50,
        maxMiB: 2048,
        destination: { space: 'personal', folder: 'Backups/Document Workflow' }
      }
    })
    await w.get('input[type=checkbox]').setValue(false)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect((request.mock.calls.at(-1)?.[1] as any)?.settings.enabled).toBe(false)
  } finally {
    w.unmount()
  }
})

it('saves manual-only timing as zero and restores the chosen interval when automatic checking returns', async () => {
  const s = await setup('/document-workflow/settings/folders')
  try {
    vi.spyOn(s.store, 'connect').mockResolvedValue(undefined)
    const timing = s.w.findAll('details').find((d) => d.get('summary').text() === 'Timing')!
    const automatic = timing.get('input[type=checkbox]')
    await timing.get('input[type=number]').setValue(45)
    await automatic.setValue(false)
    expect(timing.text()).toContain('Use Check now in the Inbox')
    expect(timing.text()).toContain('uploads and scans time to finish')
    await s.w.get('.intake-settings form').trigger('submit')
    await flushPromises()
    expect(s.request).toHaveBeenCalledWith(
      'intake-settings',
      expect.objectContaining({
        configuration: expect.objectContaining({ intervalSeconds: 0, settleSeconds: 10 })
      })
    )
    await automatic.setValue(true)
    expect(timing.get('input[type=number]').element).toHaveProperty('value', '45')
  } finally {
    s.w.unmount()
  }
})
it('refreshes backup status without overwriting an unsaved backup destination', async () => {
  vi.useFakeTimers()
  const { default: BackupSettings } = await import('../../src/components/BackupSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'personal',
    mode: 'live',
    name: 'Tester'
  }
  const request = vi.spyOn(store, 'request').mockResolvedValue({
      backups: {
        configured: true,
        canManage: true,
        state: 'ready',
        settings: {
          enabled: true,
          intervalMinutes: 360,
          maxSnapshots: 28,
          maxMiB: 1024,
          destination: { space: 'personal', folder: 'Backups/Document Workflow' }
        }
      }
    }),
    w = mount(BackupSettings, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(30000)
    expect(request).toHaveBeenCalledTimes(2)
    await w.get('#backup-folder').setValue('Keep my draft')
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(w.get('#backup-folder').element).toHaveProperty('value', 'Keep my draft')
    expect(request.mock.calls.some((c) => c[0] === 'backup-settings-save')).toBe(false)
  } finally {
    w.unmount()
    vi.useRealTimers()
  }
})
it('checks the Inbox with the scoped ingestion action and shows upload settling without filing documents', async () => {
  const { default: Inbox } = await import('../../src/views/Inbox.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'source',
    mode: 'live',
    name: 'Tester'
  }
  store.intakeConfigured.value = true
  store.intakeEnabled.value = true
  const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(),
    request = vi.spyOn(store, 'request').mockResolvedValue({ state: 'scheduled' }),
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:rest(.*)', component: { template: '<p />' } }]
    })
  await router.push('/document-workflow/inbox')
  const w = mount(Inbox, {
    global: { plugins: [router], provide: { [workspaceKey as symbol]: store } }
  })
  try {
    await flushPromises()
    await w
      .findAll('button')
      .find((b) => b.text() === 'Check now')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('intake-scan')
    expect(refresh).toHaveBeenCalledTimes(2)
    store.intakeHealth.value = {
      manualCheck: 'settling',
      manualOnly: true,
      state: 'ready',
      lastAttempt: null,
      lastSuccess: null,
      nextScanAt: null,
      reason: null,
      message: null
    }
    await flushPromises()
    expect(w.text()).toContain('Waiting for uploads to finish…')
    expect(
      w
        .findAll('button')
        .find((b) => b.text() === 'Checking…')!
        .attributes('disabled')
    ).toBeDefined()
    expect(request.mock.calls.some((c) => ['prepare', 'approve', 'apply'].includes(c[0]))).toBe(
      false
    )
  } finally {
    w.unmount()
  }
})

it('saves a named manual tag with optional matching terms left blank only after Save', async () => {
  const { default: MetadataSettings } = await import('../../src/views/MetadataSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  const request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (op, body: any) =>
        op === 'metadata-schema'
          ? { fields: [], tags: [] }
          : op === 'metadata-usage'
            ? { fields: {}, tags: {} }
            : body.schema
      ),
    wrapper = mount(MetadataSettings, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await wrapper.get('#metadata-tags-tab').trigger('click')
    expect(wrapper.get('#metadata-tags-panel').isVisible()).toBe(true)
    expect(wrapper.text()).toContain('Leave terms blank for manual use.')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Add tag')!
      .trigger('click')
    await wrapper.get('input').setValue('Person: Sora')
    expect(wrapper.findAll('input')[1]!.element).toHaveProperty('value', '')
    expect(request.mock.calls.map((call) => call[0])).toEqual(['metadata-schema', 'metadata-usage'])
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('metadata-schema-save', {
      schema: { fields: [], tags: [{ tag: 'Person: Sora', terms: [] }] }
    })
    expect(wrapper.text()).toContain('Saved')
  } finally {
    wrapper.unmount()
  }
})

it('saves explicit name-alias matching and removes the option when returning to legacy text matching', async () => {
  const { default: MetadataSettings } = await import('../../src/views/MetadataSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  const request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (op, body: any) =>
        op === 'metadata-schema'
          ? { fields: [], tags: [{ tag: 'Person: Example', terms: ['Example', 'エグザンプル'] }] }
          : op === 'metadata-usage'
            ? { fields: {}, tags: {} }
            : body.schema
      ),
    wrapper = mount(MetadataSettings, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await wrapper.get('#metadata-tags-tab').trigger('click')
    await wrapper.get('summary').trigger('click')
    const matching = wrapper.get('select')
    expect(matching.element).toHaveProperty('value', 'substring')
    await matching.setValue('name')
    expect(wrapper.text()).toContain('Name aliases ignore letter case and character width.')
    expect(request.mock.calls.map((call) => call[0])).toEqual(['metadata-schema', 'metadata-usage'])
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('metadata-schema-save', {
      schema: {
        fields: [],
        tags: [{ tag: 'Person: Example', terms: ['Example', 'エグザンプル'], match: 'name' }]
      }
    })
    await matching.setValue('substring')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save')!
      .trigger('click')
    await flushPromises()
    expect(
      (request.mock.calls.filter((c) => c[0] === 'metadata-schema-save').at(-1)![1] as any).schema
        .tags[0]
    ).toEqual({ tag: 'Person: Example', terms: ['Example', 'エグザンプル'] })
  } finally {
    wrapper.unmount()
  }
})

it('defaults background login to the server-reported username, never the opaque account ID or display name', async () => {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'opaque-id',
    space: 'source',
    mode: 'live',
    name: 'Display Person',
    username: 'login.person'
  }
  vi.spyOn(store, 'request').mockResolvedValue({
    backgroundSession: { available: true, configured: false, method: 'app_token' }
  })
  const w = mount(ReliabilityStatus, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await w.get('button').trigger('click')
    expect(w.get('#background-username').element).toHaveProperty('value', 'login.person')
    await w.get('#background-username').setValue('manual.override')
    await w.get('#background-token').setValue('synthetic-secret')
    store.connection.value = {
      ...store.connection.value,
      account: 'different-id',
      username: 'other.login'
    }
    await flushPromises()
    expect(w.find('#background-token').exists()).toBe(false)
    await w.get('button').trigger('click')
    expect(w.get('#background-username').element).toHaveProperty('value', 'other.login')
    expect(w.get('#background-token').element).toHaveProperty('value', '')
  } finally {
    w.unmount()
  }
})
it('leaves the login empty when OpenCloud does not report one rather than guessing from the ID', async () => {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'opaque-id',
    space: 'source',
    mode: 'live',
    name: 'Display Person'
  }
  vi.spyOn(store, 'request').mockResolvedValue({
    backgroundSession: { available: true, configured: false, method: 'app_token' }
  })
  const w = mount(ReliabilityStatus, { global: { provide: { [workspaceKey as symbol]: store } } })
  try {
    await flushPromises()
    await w.get('button').trigger('click')
    expect(w.get('#background-username').element).toHaveProperty('value', '')
  } finally {
    w.unmount()
  }
})

it('leaves AI tag discovery off until explicitly saved and preserves provider and review policy', async () => {
  const s = await setup()
  try {
    expect(s.w.get('#tag-discovery').element).toHaveProperty('value', 'off')
    const ai = {
      ...s.store.ai.value,
      local: { endpoint: 'http://127.0.0.1:11434', model: 'synthetic' },
      tasks: { facts: 'local', filing: 'local', tags: 'local' } as const
    }
    s.store.ai.value = ai
    await flushPromises()
    const save = vi.spyOn(s.store, 'savePreferences').mockResolvedValue({ paused: false })
    await s.w.get('#tag-discovery').setValue('create')
    expect(save).not.toHaveBeenCalled()
    await s.w.get('[aria-label="Save processing"]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith({
      policy: expect.objectContaining({ aiInput: 'suggest', aiOutput: 'suggest', tags: 'suggest' }),
      ai: { ...ai, tagDiscovery: 'create' }
    })
    expect(
      s.request.mock.calls.some((c) => ['metadata-save', 'approve', 'apply'].includes(c[0]))
    ).toBe(false)
  } finally {
    s.w.unmount()
  }
})
it('keeps field and tag edits across keyboard tab switches, shows saved usage counts, and saves only explicitly', async () => {
  const { default: MetadataSettings } = await import('../../src/views/MetadataSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  const schema = {
      fields: [
        {
          id: 'amount',
          label: 'Amount',
          type: 'number',
          aliases: ['Amount'],
          choices: [] as string[]
        }
      ],
      tags: [
        { tag: 'Vehicles', terms: ['Vehicle'] },
        { tag: 'Warranty', terms: [] }
      ]
    },
    request = vi
      .spyOn(store, 'request')
      .mockImplementation(async (op, body: any) =>
        op === 'metadata-schema'
          ? structuredClone(schema)
          : op === 'metadata-usage'
            ? { fields: { amount: 1 }, tags: { Vehicles: 2 } }
            : body.schema
      ),
    wrapper = mount(MetadataSettings, {
      attachTo: document.body,
      global: { provide: { [workspaceKey as symbol]: store } }
    })
  try {
    await flushPromises()
    expect(wrapper.get('#metadata-fields-tab').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#metadata-tags-panel').isVisible()).toBe(false)
    expect(wrapper.get('#metadata-fields-panel details').attributes('open')).toBeUndefined()
    expect(wrapper.get('#metadata-fields-panel .usage-count').text()).toBe('1')
    await wrapper.get('#metadata-fields-panel summary').trigger('click')
    await wrapper.findAll('#metadata-fields-panel input')[1]!.setValue('Total')
    await wrapper.get('#metadata-fields-tab').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('#metadata-tags-tab').attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('#metadata-tags-panel .usage-count').map((c) => c.text())).toEqual([
      '2',
      '0'
    ])
    await wrapper.findAll('#metadata-tags-panel summary')[1]!.trigger('click')
    await wrapper.findAll('#metadata-tags-panel input')[2]!.setValue('Guarantee')
    await wrapper.get('#metadata-tags-tab').trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.findAll('#metadata-fields-panel input')[1]!.element).toHaveProperty(
      'value',
      'Total'
    )
    expect(request.mock.calls.some((c) => c[0] === 'metadata-schema-save')).toBe(false)
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .trigger('click')
    await flushPromises()
    const saved = request.mock.calls.find((c) => c[0] === 'metadata-schema-save')![1] as any
    expect(saved.schema.fields[0].label).toBe('Total')
    expect(saved.schema.tags[1].tag).toBe('Guarantee')
  } finally {
    wrapper.unmount()
  }
})
it('shows unavailable usage instead of zero when the complete document library cannot be read', async () => {
  const { default: MetadataSettings } = await import('../../src/views/MetadataSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  vi.spyOn(store, 'request').mockImplementation(async (op) => {
    if (op === 'metadata-schema')
      return {
        fields: [
          { id: 'amount', label: 'Amount', type: 'number', aliases: [], choices: [] as string[] }
        ],
        tags: []
      }
    throw Error('Permission denied')
  })
  const wrapper = mount(MetadataSettings, {
    global: { provide: { [workspaceKey as symbol]: store } }
  })
  try {
    await flushPromises()
    expect(wrapper.get('.usage-count').text()).toBe('—')
    expect(wrapper.text()).toContain('Counts unavailable')
    expect(wrapper.get('.usage-count').attributes('aria-label')).toBe('Counts unavailable')
  } finally {
    wrapper.unmount()
  }
})
it('confirms removal of in-use fields and tags, cancels safely, and removes unused definitions without a popup', async () => {
  const { default: MetadataSettings } = await import('../../src/views/MetadataSettings.vue'),
    store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.example',
    account: 'person',
    space: 'space',
    mode: 'demo',
    name: 'Tester'
  }
  let unavailable = false
  const request = vi.spyOn(store, 'request').mockImplementation(async (op) => {
    if (op === 'metadata-schema')
      return {
        fields: [
          { id: 'amount', label: 'Amount', type: 'number', aliases: [], choices: [] as string[] }
        ],
        tags: [
          { tag: 'Used', terms: [] },
          { tag: 'Unused', terms: [] }
        ]
      }
    if (unavailable) throw Error('No access')
    return { fields: { amount: 3 }, tags: { Used: 2 } }
  })
  const wrapper = mount(MetadataSettings, {
    attachTo: document.body,
    global: { provide: { [workspaceKey as symbol]: store } }
  })
  try {
    await flushPromises()
    await wrapper.get('#metadata-fields-panel summary').trigger('click')
    await wrapper.get('[aria-label="Remove field"]').trigger('click')
    await flushPromises()
    expect((wrapper.get('dialog').element as HTMLDialogElement).open).toBe(true)
    expect(wrapper.get('dialog').text()).toContain('Used by 3 documents.')
    await wrapper
      .get('dialog')
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click')
    expect(wrapper.findAll('#metadata-fields-panel details')).toHaveLength(1)
    await wrapper.get('#metadata-tags-tab').trigger('click')
    await wrapper.findAll('#metadata-tags-panel summary')[1]!.trigger('click')
    await wrapper.findAll('[aria-label="Remove tag"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('#metadata-tags-panel details')).toHaveLength(1)
    expect((wrapper.get('dialog').element as HTMLDialogElement).open).toBe(false)
    await wrapper.get('#metadata-tags-panel summary').trigger('click')
    await wrapper.get('[aria-label="Remove tag"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('dialog').text()).toContain('Used by 2 documents.')
    await wrapper
      .get('dialog')
      .findAll('button')
      .find((b) => b.text() === 'Remove')!
      .trigger('click')
    expect(wrapper.findAll('#metadata-tags-panel details')).toHaveLength(0)
    unavailable = true
    await wrapper.get('#metadata-fields-tab').trigger('click')
    await wrapper.get('[aria-label="Remove field"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('dialog').text()).toContain('Usage could not be checked')
    expect(request.mock.calls.some((c) => c[0] === 'metadata-schema-save')).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

it('combines tag enablement and source selection and saves only on explicit Save', async () => {
  const s = await setup()
  try {
    expect(s.w.find('#aiInput').exists()).toBe(false)
    expect(s.w.find('#aiOutput').exists()).toBe(false)
    for (const id of ['#ai-processing', '#ocr'])
      expect(
        s.w
          .get(id)
          .findAll('option')
          .map((option) => option.text())
      ).toEqual(['Off', 'On'])
    expect(s.w.get('#rename').text()).toContain('Keep current name')
    expect(s.w.get('#move').text()).toContain('Suggest folder')
    expect(s.w.get('#fields').text()).not.toContain('automatically')
    expect(s.w.get('.tag-discovery-setting').findAll('select')).toHaveLength(1)
    const save = vi.spyOn(s.store, 'savePreferences').mockResolvedValue({ paused: false })
    await s.w.get('#tag-discovery').setValue('disabled')
    await s.w.get('#ai-processing').setValue('off')
    expect(save).not.toHaveBeenCalled()
    await s.w.get('[aria-label="Save processing"]').trigger('click')
    await flushPromises()
    expect(save.mock.calls[0]![0].policy).toMatchObject({
      aiInput: 'off',
      aiOutput: 'off',
      tags: 'off',
      rename: 'suggest',
      move: 'suggest'
    })
  } finally {
    s.w.unmount()
  }
})
it('disables only AI suggestions while OCR, fields and matching tags remain usable', async () => {
  const s = await setup()
  try {
    await s.w.get('#rename').setValue('off')
    await s.w.get('#tag-discovery').setValue('create')
    await s.w.get('#ai-processing').setValue('off')
    for (const id of ['#rename', '#move']) expect(s.w.get(id).attributes('disabled')).toBeDefined()
    for (const id of ['#ocr', '#fields', '#tag-discovery'])
      expect(s.w.get(id).attributes('disabled')).toBeUndefined()
    expect(s.w.findAll('.processing-inactive')).toHaveLength(2)
    expect(s.w.get('#tag-discovery').element).toHaveProperty('value', 'off')
    expect(s.w.text()).toContain('OCR and extraction rules remain active. AI suggestions are off.')
    await s.w.get('#ai-processing').setValue('on')
    for (const id of ['#ocr', '#fields', '#rename', '#move', '#tag-discovery'])
      expect(s.w.get(id).attributes('disabled')).toBeUndefined()
    expect(s.w.get('#rename').element).toHaveProperty('value', 'off')
    expect(s.w.get('#tag-discovery').element).toHaveProperty('value', 'create')
    expect(s.request.mock.calls.some((c) => c[0] === 'preferences')).toBe(false)
  } finally {
    s.w.unmount()
  }
})
