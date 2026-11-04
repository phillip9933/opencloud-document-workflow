import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
import IngestionHistory from '../../src/components/IngestionHistory.vue'
const summary = {
  total: 211,
  waiting: 180,
  running: 1,
  attention: 20,
  ready: 10,
  completed: 0,
  cancelled: 0,
  duplicates: 0,
  superseded: 0,
  retryable: 20,
  cancellable: 201
}
function setup(override?: Record<string, unknown>, response: Record<string, unknown> = {}) {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://opencloud.example',
    account: 'demo',
    space: 'demo',
    name: 'Demo',
    mode: 'demo'
  }
  let changed = false
  const row = (id: string) =>
    override ?? {
      id,
      resource: id,
      path: `Inbox/${id}/same-name.pdf`,
      state: changed ? 'prepared' : 'failed',
      attempts: 3,
      job: null as string | null
    }
  const request = vi
    .spyOn(store, 'request')
    .mockImplementation(async (op, body: any) =>
      op === 'intake'
        ? {
            queue: body.cursor ? [row('second')] : [row('first')],
            nextCursor: body.cursor ? 'third-page' : 'next-page',
            configuration: { enabled: true },
            paused: false,
            summary,
            health: { state: 'ready' },
            sessionAttached: true,
            ...response
          }
        : op === 'intake-control'
          ? { affected: 20 }
          : {}
    )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: IngestionHistory }]
  })
  const wrapper = mount(IngestionHistory, {
    global: { plugins: [router], provide: { [workspaceKey as symbol]: store } }
  })
  return {
    store,
    request,
    wrapper,
    change() {
      changed = true
    }
  }
}
afterEach(() => vi.useRealTimers())
it('uses full-queue totals for Retry all rather than sending just the loaded page IDs', async () => {
  const { wrapper, request } = setup()
  try {
    await flushPromises()
    expect(wrapper.emitted('summary')?.[0]).toEqual([summary])
    expect(wrapper.get('[aria-label="Processing totals"]').text()).toContain('180')
    expect(wrapper.text()).toContain('Inbox/first')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Retry all (20)')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('intake-control', { action: 'retry', currentInbox: true })
  } finally {
    wrapper.unmount()
  }
})
it('sends exact selected queue IDs for cancellation and does not confuse identical filenames in different folders', async () => {
  const { wrapper, request } = setup()
  try {
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Load more')!
      .trigger('click')
    await flushPromises()
    await wrapper.get('input[aria-label="Select Inbox/second/same-name.pdf"]').setValue(true)
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel selected')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('intake-control', {
      action: 'cancel',
      ids: ['second'],
      currentInbox: true
    })
    expect(wrapper.text()).toContain('Uploaded files are kept.')
  } finally {
    wrapper.unmount()
  }
})
it('keeps polling and updates already loaded pages while further pages are available', async () => {
  vi.useFakeTimers()
  const { wrapper, request, change } = setup()
  try {
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Load more')!
      .trigger('click')
    await flushPromises()
    change()
    request.mockClear()
    await vi.advanceTimersByTimeAsync(11000)
    await flushPromises()
    expect(request.mock.calls.some(([op]) => op === 'intake')).toBe(true)
    expect(
      request.mock.calls.some(([op, body]: any) => op === 'intake' && body?.cursor === 'next-page')
    ).toBe(true)
    expect(wrapper.text()).toContain('Ready to review')
    expect(wrapper.text()).toContain('Inbox/second')
  } finally {
    wrapper.unmount()
  }
})

it('offers OCR retry rather than automatic filing for a scan and separates status from stage', async () => {
  const { wrapper, request } = setup({
    id: 'scan',
    path: 'Inbox/scan.pdf',
    state: 'prepared',
    proposalState: 'needs_ocr',
    retryable: true,
    attempts: 1,
    job: 'old-ocr'
  })
  try {
    await flushPromises()
    const row = wrapper.get('tbody tr')
    expect(wrapper.findAll('th').map((c) => c.text())).toContain('Stage')
    expect(row.findAll('td')[2]!.text()).toBe('Needs attention')
    expect(row.findAll('td')[3]!.text()).toContain('Needs text extraction')
    expect(row.findAll('td')[3]!.text()).not.toContain('Needs attention')
    expect(wrapper.text()).not.toContain('Run automatic rules')
    await row
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('intake-retry', { id: 'scan' })
  } finally {
    wrapper.unmount()
  }
})

it('enables global controls for a paused preparation batch even with automatic intake disabled', async () => {
  const { wrapper, request } = setup(undefined, {
    configuration: { enabled: false },
    paused: true,
    summary: { ...summary, retryable: 0, cancellable: 0 },
    bulkPreparation: { waiting: 8, running: 0, retryable: 2, cancellable: 8 }
  })
  try {
    await flushPromises()
    expect(wrapper.text()).toContain('Batch preparation: 8 waiting · 0 processing')
    for (const label of ['Resume', 'Retry all (2)', 'Cancel all'])
      expect(
        wrapper
          .findAll('button')
          .find((b) => b.text() === label)!
          .attributes('disabled')
      ).toBeUndefined()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Resume')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('intake-control', { action: 'resume', currentInbox: true })
  } finally {
    wrapper.unmount()
  }
})

it('defaults to current inbox work and exposes old results only as inspectable past imports without allowing stale queue retries', async () => {
  const zero = {
      ...summary,
      total: 0,
      waiting: 0,
      running: 0,
      attention: 0,
      ready: 0,
      retryable: 0,
      cancellable: 0
    },
    s = setup(
      {
        id: 'past',
        resource: 'past',
        path: 'Inbox/past.pdf',
        state: 'prepared',
        historical: true,
        retryable: false,
        attempts: 1,
        job: 'old'
      },
      { summary: zero, historicalTotal: 66 }
    )
  try {
    await flushPromises()
    expect(s.request).toHaveBeenCalledWith('intake', { currentInbox: true, includeHistory: false })
    const toggle = s.wrapper.get('input[type=checkbox]')
    await toggle.setValue(true)
    await flushPromises()
    expect(s.request).toHaveBeenCalledWith('intake', { currentInbox: true, includeHistory: true })
    expect(s.wrapper.text()).toContain('Past import')
    expect(s.wrapper.findAll('tbody .row-actions button').map((b) => b.text())).toEqual([
      'Reprocess'
    ])
    expect(s.wrapper.get('tbody input[type=checkbox]').attributes('disabled')).toBeUndefined()
    expect(s.wrapper.emitted('summary')?.at(-1)).toEqual([{ ...zero, total: 66 }])
  } finally {
    s.wrapper.unmount()
  }
})
it('keeps selected historical records selected across polling but never retries or cancels stale queue IDs', async () => {
  vi.useFakeTimers()
  const s = setup({
    id: 'past',
    resource: 'past',
    path: 'Inbox/past.pdf',
    state: 'prepared',
    historical: true,
    retryable: false,
    attempts: 1,
    job: 'old',
    decision: 'done'
  })
  try {
    await flushPromises()
    await s.wrapper.get('tbody input[type=checkbox]').setValue(true)
    expect(s.wrapper.text()).toContain('1 selected')
    for (const label of ['Retry selected', 'Cancel selected'])
      expect(
        s.wrapper
          .findAll('button')
          .find((b) => b.text() === label)!
          .attributes('disabled')
      ).toBeDefined()
    expect(
      s.wrapper
        .findAll('button')
        .find((b) => b.text() === 'Reprocess selected')!
        .attributes('disabled')
    ).toBeUndefined()
    await vi.advanceTimersByTimeAsync(11000)
    await flushPromises()
    expect(s.wrapper.get('tbody input[type=checkbox]').element).toHaveProperty('checked', true)
    expect(s.request.mock.calls.some((c) => c[0] === 'intake-control')).toBe(false)
  } finally {
    s.wrapper.unmount()
    vi.useRealTimers()
  }
})
