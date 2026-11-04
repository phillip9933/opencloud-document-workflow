import { mount, flushPromises } from '@vue/test-utils'
import { ref, defineComponent } from 'vue'
import { useRetryMonitor } from '../../src/state/retry-monitor'
afterEach(() => vi.useRealTimers())
function fixture() {
  const key = ref('document-a'),
    blocked = ref(false),
    source = { resourceId: 'a', etag: '1' },
    request = vi.fn(),
    issue = vi.fn(),
    ready = vi.fn().mockResolvedValue(undefined)
  let monitor!: ReturnType<typeof useRetryMonitor>
  const w = mount(
    defineComponent({
      setup() {
        monitor = useRetryMonitor({ key, blocked: () => blocked.value, request, issue, ready })
        return (): null => null
      }
    })
  )
  return {
    w,
    key,
    blocked,
    source,
    request,
    issue,
    ready,
    get monitor() {
      return monitor
    }
  }
}
it('waits through queued and running states, then opens the new successful review', async () => {
  vi.useFakeTimers()
  const s = fixture()
  s.request
    .mockResolvedValueOnce({ state: 'queued', job: 'old', source: s.source, processingIssue: null })
    .mockResolvedValueOnce({
      state: 'running',
      job: 'old',
      source: s.source,
      processingIssue: null
    })
    .mockResolvedValueOnce({
      state: 'prepared',
      job: 'new',
      source: s.source,
      processingIssue: null
    })
  try {
    s.monitor.start('q', s.source)
    for (let n = 0; n < 3; n++) {
      await vi.advanceTimersByTimeAsync(2500)
      await flushPromises()
    }
    expect(s.request).toHaveBeenCalledTimes(3)
    expect(s.issue.mock.calls.every((c) => c[0] === null)).toBe(true)
    expect(s.ready).toHaveBeenCalledExactlyOnceWith('new')
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.request).toHaveBeenCalledTimes(3)
  } finally {
    s.w.unmount()
  }
})
it('shows only the new failure and never navigates when retry fails', async () => {
  vi.useFakeTimers()
  const s = fixture(),
    error = { message: 'Processing timed out.', nextStep: 'Retry.' }
  s.request.mockResolvedValue({
    state: 'failed',
    job: 'old',
    source: s.source,
    processingIssue: error
  })
  try {
    s.monitor.start('q', s.source)
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.issue).toHaveBeenCalledExactlyOnceWith(error)
    expect(s.ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.request).toHaveBeenCalledTimes(1)
  } finally {
    s.w.unmount()
  }
})
it('ignores late responses after document navigation, mismatched sources and unmount', async () => {
  vi.useFakeTimers()
  const s = fixture()
  let finish!: (v: unknown) => void
  s.request.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
  s.monitor.start('q', s.source)
  await vi.advanceTimersByTimeAsync(2500)
  s.key.value = 'document-b'
  await flushPromises()
  finish({ state: 'failed', source: s.source, processingIssue: { message: 'Old error' } })
  await flushPromises()
  expect(s.issue).not.toHaveBeenCalled()
  s.request.mockResolvedValue({
    state: 'prepared',
    job: 'wrong',
    source: { resourceId: 'other', etag: '1' },
    processingIssue: null
  })
  s.monitor.start('q', s.source)
  await vi.advanceTimersByTimeAsync(2500)
  expect(s.ready).not.toHaveBeenCalled()
  s.monitor.start('q', s.source)
  s.w.unmount()
  await vi.advanceTimersByTimeAsync(5000)
  expect(s.request).toHaveBeenCalledTimes(2)
})
it('does not interrupt an edit and resumes monitoring afterward', async () => {
  vi.useFakeTimers()
  const s = fixture()
  try {
    s.blocked.value = true
    s.request.mockResolvedValue({
      state: 'running',
      job: 'old',
      source: s.source,
      processingIssue: null
    })
    s.monitor.start('q', s.source)
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.request).not.toHaveBeenCalled()
    s.blocked.value = false
    await vi.advanceTimersByTimeAsync(2500)
    expect(s.request).toHaveBeenCalledExactlyOnceWith('q')
  } finally {
    s.w.unmount()
  }
})
