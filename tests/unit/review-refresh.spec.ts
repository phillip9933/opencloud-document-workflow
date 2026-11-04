import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import ReviewInbox from '../../src/views/ReviewInbox.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
import { samples } from '../../src/domain/samples'
import { validateBundle, defaultPolicy } from '../../src/domain/review'
import { defaultAIConfig } from '../../src/domain/ai'
it('refreshes new background reviews on entry and preserves the selected resource', async () => {
  const bundles = samples().slice(0, 2),
    store = createWorkspace()
  store.connection.value = {
    mode: 'demo',
    server: 'https://opencloud.example',
    account: 'synthetic-user',
    space: 'synthetic-space',
    name: 'Tester'
  }
  store.reviews.value = [validateBundle(bundles[0])]
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/document-workflow/review', component: ReviewInbox }]
  })
  await router.push('/document-workflow/review')
  await router.isReady()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/status')
              ? {
                  actor: store.connection.value,
                  jobs: [...bundles].reverse().map((bundle, i) => ({
                    id: String(i),
                    source: bundle.source,
                    state: 'needs_review',
                    decision: null as null,
                    bundle
                  })),
                  preferences: { policy: defaultPolicy(), ai: defaultAIConfig() }
                }
              : url.endsWith('/intake')
                ? { configuration: { folder: 'Inbox', enabled: false } }
                : { files: [] }
          )
        )
    )
  )
  try {
    const w = mount(ReviewInbox, {
      global: {
        plugins: [router],
        provide: { [workspaceKey as symbol]: store },
        stubs: { PdfPreview: true }
      }
    })
    await flushPromises()
    expect(store.reviews.value).toHaveLength(2)
    expect(w.get('h1').text()).toBe('electricity.pdf')
    expect(w.get('.suggested-filename').text()).toContain('Example Electricity Company')
    w.unmount()
  } finally {
    vi.unstubAllGlobals()
  }
})
