// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import { ref, defineComponent } from 'vue'
import { useDocumentProcessing } from '../../src/state/document-processing'
import DocumentProcessingStatus from '../../src/components/DocumentProcessingStatus.vue'
afterEach(() => vi.useRealTimers())
function fixture() {
  const source = ref({ path: 'Inbox/a.pdf', resourceId: 'a', etag: 'v1' }),
    scope = ref('one'),
    request = vi.fn()
  let monitor!: ReturnType<typeof useDocumentProcessing>
  const w = mount(
    defineComponent({
      setup() {
        monitor = useDocumentProcessing({ source, scope, request })
        return (): null => null
      }
    })
  )
  return {
    source,
    scope,
    request,
    w,
    get monitor() {
      return monitor
    }
  }
}
it('follows external queued, running and failed attempts without initiating processing', async () => {
  vi.useFakeTimers()
  const s = fixture(),
    base = { source: s.source.value, processingIssue: null as null }
  s.request
    .mockResolvedValueOnce({ ...base, state: 'queued' })
    .mockResolvedValueOnce({ ...base, state: 'running', stage: 'tagging' })
    .mockResolvedValueOnce({
      ...base,
      state: 'failed',
      processingIssue: { message: 'Processing timed out.', nextStep: 'Retry.', retryable: false }
    })
  try {
    s.monitor.refresh()
    await flushPromises()
    expect(s.monitor.active.value).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.monitor.status.value?.stage).toBe('tagging')
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.monitor.active.value).toBe(false)
    expect(s.monitor.status.value?.processingIssue?.message).toBe('Processing timed out.')
  } finally {
    s.w.unmount()
  }
})
it('discards late status from another document/account and stops on unmount', async () => {
  vi.useFakeTimers()
  const s = fixture()
  let finish!: (v: any) => void
  s.request.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
  s.monitor.refresh()
  s.scope.value = 'two'
  const late = finish
  s.source.value = { path: 'Inbox/b.pdf', resourceId: 'b', etag: 'v2' }
  late({ source: { resourceId: 'a', etag: 'v1' }, state: 'running', processingIssue: null })
  await flushPromises()
  expect(s.monitor.status.value).toBeNull()
  s.w.unmount()
  const calls = s.request.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(s.request).toHaveBeenCalledTimes(calls)
})
it('reports lost live status rather than pretending an old running stage is current', async () => {
  vi.useFakeTimers()
  const s = fixture()
  try {
    s.request
      .mockResolvedValueOnce({ source: s.source.value, state: 'running', processingIssue: null })
      .mockRejectedValueOnce(Error('offline'))
    s.monitor.refresh()
    await flushPromises()
    expect(s.monitor.active.value).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.monitor.unavailable.value).toBe(true)
    expect(s.monitor.active.value).toBe(false)
  } finally {
    s.w.unmount()
  }
})
it('shows a live stage, a paused queue and a ready review as different states', () => {
  const w = mount(DocumentProcessingStatus, {
    props: {
      status: {
        source: { resourceId: 'a', etag: 'v1' },
        state: 'running',
        stage: 'tagging',
        processingIssue: null
      }
    },
    global: { stubs: { RouterLink: true } }
  })
  expect(w.text()).toContain('Processing document')
  expect(w.text()).toContain('3 / 5')
  expect(w.text()).toContain('Reviewing tags with AI')
  w.unmount()
  const paused = mount(DocumentProcessingStatus, {
    props: {
      status: {
        source: { resourceId: 'a', etag: 'v1' },
        state: 'queued',
        paused: true,
        processingIssue: null
      }
    },
    global: { stubs: { RouterLink: true } }
  })
  expect(paused.text()).toContain('Processing paused')
  paused.unmount()
})
it('shows Filed on reopening a completed job, while a fresh preparation can still be reviewed', async () => {
  const status = {
    source: { resourceId: 'invoice', etag: 'v1' },
    state: 'prepared',
    job: 'original-attempt',
    processingIssue: null as null
  }
  const w = mount(DocumentProcessingStatus, {
    props: { status, filedJob: status.job },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  expect(w.get('h2').text()).toBe('Filed')
  expect(w.find('a').exists()).toBe(false)
  await w.setProps({ status: { ...status, state: 'idle', job: null } })
  expect(w.get('h2').text()).toBe('Filed')
  await w.setProps({ status: { ...status, job: 'fresh-attempt' } })
  expect(w.get('h2').text()).toBe('Ready to review')
  expect(w.get('a').text()).toBe('Open review')
  w.unmount()
})
it('keeps a document field draft while external processing changes stage and stops', async () => {
  vi.useFakeTimers()
  const { createRouter, createMemoryHistory } = await import('vue-router'),
    { createWorkspace, workspaceKey } = await import('../../src/state/workspace'),
    { default: DocumentDetails } = await import('../../src/views/DocumentDetails.vue'),
    store = createWorkspace()
  store.connection.value = { server: 'test', account: 'a', space: 's', mode: 'demo', name: 'Test' }
  let stage = 'reading',
    state = 'running'
  const source = {
    path: 'Inbox/a.pdf',
    resourceId: 'a',
    etag: 'v1',
    sha256: 'a'.repeat(64),
    tags: [] as string[]
  }
  const request = vi.spyOn(store, 'request').mockImplementation(async (op) =>
    op === 'document-processing'
      ? {
          source,
          state,
          stage,
          processingIssue:
            state === 'failed'
              ? { message: 'Processing timed out.', nextStep: 'Retry.', retryable: false }
              : null
        }
      : op === 'metadata'
        ? {
            source,
            schema: {
              fields: [{ id: 'note', label: 'Note', type: 'text', aliases: [], choices: [] }],
              tags: []
            },
            record: { version: 0, fields: {} },
            suggestions: { fields: {}, tags: [] },
            pending: []
          }
        : op === 'preview'
          ? new Blob(['synthetic'])
          : {}
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/details', component: DocumentDetails }]
  })
  await router.push('/document-workflow/details?path=Inbox/a.pdf')
  const w = mount(DocumentDetails, {
    global: {
      plugins: [router],
      provide: { [workspaceKey as symbol]: store },
      stubs: { PdfPreview: true }
    }
  })
  try {
    await flushPromises()
    expect(w.get('[aria-label="Document processing"]').text()).toContain('Reading PDF text')
    await w.get('[aria-label="Edit details"]').trigger('click')
    await w.get('#field-note').setValue('Keep this draft')
    stage = 'tagging'
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    expect(w.get('[aria-label="Document processing"]').text()).toContain('Reviewing tags with AI')
    expect(w.get('#field-note').element).toHaveProperty('value', 'Keep this draft')
    state = 'failed'
    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    expect(w.get('[aria-label="Needs attention"]').text()).toContain('Processing timed out.')
    expect(w.get('#field-note').element).toHaveProperty('value', 'Keep this draft')
    expect(request.mock.calls.filter((c) => c[0] === 'metadata')).toHaveLength(1)
    expect(
      request.mock.calls.some((c) =>
        ['prepare', 'approve', 'apply', 'metadata-save'].includes(c[0])
      )
    ).toBe(false)
  } finally {
    w.unmount()
  }
})
