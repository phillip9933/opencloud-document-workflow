// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import ProcessingAttempts from '../../src/components/ProcessingAttempts.vue'
import Activity from '../../src/views/Activity.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
import { createRouter, createMemoryHistory } from 'vue-router'
it('loads recorded results on expansion without replaying processing actions', async () => {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.test',
    account: 'fixture',
    space: 'space',
    mode: 'demo',
    name: 'Fixture'
  }
  const request = vi.spyOn(store, 'request').mockResolvedValue({
      document: { attempts: 2 },
      attempts: [
        {
          id: 'review',
          kind: 'prepare',
          state: 'needs_details',
          created: '2026-11-04T00:00:00Z',
          result: { manualReview: { reason: 'rules' } }
        }
      ],
      events: []
    }),
    w = mount(ProcessingAttempts, {
      props: { id: 'queue-one' },
      global: { provide: { [workspaceKey as symbol]: store } }
    })
  try {
    expect(request).not.toHaveBeenCalled()
    ;(w.get('details').element as HTMLDetailsElement).open = true
    await w.get('details').trigger('toggle')
    await flushPromises()
    expect(request).toHaveBeenCalledExactlyOnceWith('intake-history', { id: 'queue-one' })
    expect(w.text()).toContain('rules')
    expect(w.text()).toContain('Recorded result')
  } finally {
    w.unmount()
  }
})
it('places batches inside Processing and keeps legacy operation links accessible', async () => {
  const store = createWorkspace()
  store.connection.value = {
    server: 'https://fixture.test',
    account: 'fixture',
    space: 'space',
    mode: 'demo',
    name: 'Fixture'
  }
  vi.spyOn(store, 'request').mockResolvedValue({ operations: [] })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/activity', component: Activity }]
  })
  await router.push('/document-workflow/activity?view=operations&operation=old')
  const w = mount(Activity, {
    global: {
      plugins: [router],
      provide: { [workspaceKey as symbol]: store },
      stubs: { IngestionHistory: true, OperationHistory: true }
    }
  })
  try {
    await flushPromises()
    expect(w.get('nav').text()).toBe('ProcessingFiling historyEvents')
    expect(w.get('.processing-batches').attributes('open')).toBeDefined()
    expect(w.findComponent({ name: 'OperationHistory' }).exists()).toBe(true)
  } finally {
    w.unmount()
  }
})
