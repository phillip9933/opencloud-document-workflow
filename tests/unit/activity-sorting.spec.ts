// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import IngestionHistory from '../../src/components/IngestionHistory.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
function row(id: string, name: string, attempts: number, state: string, stage: string) {
  return {
    id,
    resource: 'r-' + id,
    etag: 'v1',
    path: 'Inbox/' + name + '.pdf',
    attempts,
    state,
    stage,
    job: state === 'prepared' ? 'job-' + id : null,
    decision: null as string | null,
    proposalState: state === 'prepared' ? 'needs_review' : null
  }
}
async function setup() {
  const store = createWorkspace(),
    rows = [
      row('a', 'zeta', 2, 'prepared', 'review'),
      row('b', 'alpha', 10, 'failed', 'ocr'),
      row('c', 'beta', 1, 'queued', 'reading')
    ],
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: IngestionHistory },
        { path: '/document-workflow/:rest(.*)', component: { template: '<div />' } }
      ]
    })
  await router.push('/')
  const request = vi.spyOn(store, 'request').mockImplementation(async (op, body: any) =>
    op === 'intake'
      ? {
          queue: body?.cursor ? [rows[2]] : rows.slice(0, 2),
          nextCursor: body?.cursor ? null : 'next',
          configuration: { enabled: true },
          paused: false
        }
      : op === 'document-location'
        ? { path: 'Docs/Filed/zeta.pdf', resourceId: 'r-a', etag: 'current', space: 'library' }
        : op === 'operation-start'
          ? { id: 'fresh-operation' }
          : { affected: 1 }
  )
  const w = mount(IngestionHistory, {
    global: { plugins: [router], provide: { [workspaceKey as symbol]: store } }
  })
  await flushPromises()
  return { store, rows, request, router, w }
}
const names = (w: any) =>
  w.findAll('tbody tr').map((tr: any) => tr.findAll('td')[1].get('.document-link').text())
afterEach(() => vi.useRealTimers())
it('sorts every loaded and remaining activity page with numeric attempts, toggles direction and retains selected identities', async () => {
  const s = await setup()
  try {
    await s.w.get('[aria-label="Select Inbox/zeta.pdf"]').setValue(true)
    await s.w.get('thead button').trigger('click')
    await flushPromises()
    expect(names(s.w)).toEqual(['alpha.pdf', 'beta.pdf', 'zeta.pdf'])
    expect(s.request).toHaveBeenCalledWith('intake', {
      cursor: 'next',
      currentInbox: true,
      includeHistory: false
    })
    expect(
      (s.w.get('[aria-label="Select Inbox/zeta.pdf"]').element as HTMLInputElement).checked
    ).toBe(true)
    const attempts = s.w.findAll('thead button').find((b) => b.text() === 'Attempts')!
    await attempts.trigger('click')
    await flushPromises()
    expect(names(s.w)).toEqual(['beta.pdf', 'zeta.pdf', 'alpha.pdf'])
    expect(attempts.element.closest('th')!.getAttribute('aria-sort')).toBe('ascending')
    await attempts.trigger('click')
    await flushPromises()
    expect(names(s.w)).toEqual(['alpha.pdf', 'zeta.pdf', 'beta.pdf'])
    expect(attempts.element.closest('th')!.getAttribute('aria-sort')).toBe('descending')
    expect(s.request.mock.calls.every(([op]) => op === 'intake')).toBe(true)
  } finally {
    s.w.unmount()
  }
})
it('retains stage sorting during polling as the queue advances', async () => {
  vi.useFakeTimers()
  const s = await setup()
  try {
    await s.w
      .findAll('thead button')
      .find((b) => b.text() === 'Stage')!
      .trigger('click')
    await flushPromises()
    expect(names(s.w)).toEqual(['beta.pdf', 'alpha.pdf', 'zeta.pdf'])
    s.rows[2]!.state = 'prepared'
    s.rows[2]!.stage = 'review'
    await vi.advanceTimersByTimeAsync(11000)
    await flushPromises()
    expect(names(s.w)[0]).toBe('alpha.pdf')
    expect(s.w.findAll('th')[3]!.attributes('aria-sort')).toBe('ascending')
  } finally {
    s.w.unmount()
  }
})
it('queues a source-pinned fresh review at the current filed location without approving or applying it', async () => {
  const s = await setup()
  try {
    const reprocess = s.w
      .get('tbody tr')
      .findAll('button')
      .find((b) => b.text() === 'Reprocess')!
    await reprocess.trigger('click')
    await flushPromises()
    expect(s.request).toHaveBeenCalledWith('document-location', { id: 'job-a' })
    expect(s.request).toHaveBeenCalledWith('operation-start', {
      id: expect.any(String),
      kind: 'prepare',
      items: [
        {
          path: 'Docs/Filed/zeta.pdf',
          resourceId: 'r-a',
          etag: 'current',
          documentSpace: 'library',
          newReview: true,
          retry: true,
          cloudConsent: false
        }
      ]
    })
    expect(s.router.currentRoute.value.query).toEqual({ operation: 'fresh-operation' })
    expect(
      s.request.mock.calls.some(([op]) =>
        ['approve', 'apply', 'metadata-save', 'reject'].includes(op)
      )
    ).toBe(false)
  } finally {
    s.w.unmount()
  }
})
