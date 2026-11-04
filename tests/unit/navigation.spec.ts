import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { ComponentCustomProperties } from 'vue'
import { useRouter, useRoute } from '../../src/state/navigation'
it('uses the host router instance and follows its current route without private injection symbols', async () => {
  const host = {
    currentRoute: ref({ path: '/document-workflow/settings', params: { section: 'ai' } }),
    push: vi.fn()
  }
  let returned: unknown
  const view = mount(
    {
      setup() {
        returned = useRouter()
        return { route: useRoute() }
      },
      template: '<p>{{ route.params.section }}</p>'
    },
    {
      global: {
        config: { globalProperties: { $router: host } as unknown as ComponentCustomProperties }
      }
    }
  )
  expect(returned).toBe(host)
  expect(view.text()).toBe('ai')
  host.currentRoute.value = { path: '/document-workflow/settings', params: { section: 'metadata' } }
  await nextTick()
  expect(view.text()).toBe('metadata')
  view.unmount()
})
