// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import DocumentTagRemove from '../../src/components/DocumentTagRemove.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
const source = {
  path: 'Docs/test.pdf',
  space: 'library',
  resourceId: 'fixture-resource',
  etag: 'v1',
  sha256: 'a'.repeat(64)
}
function setup() {
  const store = createWorkspace()
  store.connection.value = {
    mode: 'live',
    server: 'https://example.org',
    account: 'fixture',
    space: 'inbox',
    name: 'Fixture'
  }
  const request = vi.spyOn(store, 'request').mockResolvedValue({ state: 'done' }),
    w = mount(DocumentTagRemove, {
      props: { tag: 'Vehicles', source, version: 3 },
      global: { provide: { [workspaceKey as symbol]: store }, stubs: { Teleport: true } }
    })
  return { store, request, w }
}
it('removes one tag directly on click without a confirmation and pins the document', async () => {
  const s = setup()
  try {
    await s.w.get('[aria-label="Remove tag Vehicles"]').trigger('click')
    await flushPromises()
    expect(s.w.find('dialog').exists()).toBe(false)
    expect(s.request).toHaveBeenCalledExactlyOnceWith('metadata-tag-remove', {
      path: source.path,
      resourceId: source.resourceId,
      etag: source.etag,
      sha256: source.sha256,
      version: 3,
      tag: 'Vehicles',
      documentSpace: 'library'
    })
    expect(s.w.emitted('changed')).toHaveLength(1)
    expect(s.w.get('button').attributes('disabled')).toBeDefined()
  } finally {
    s.w.unmount()
  }
})
it('reports uncertain removal for read-only reconciliation and never resends automatically', async () => {
  const s = setup()
  try {
    s.request.mockResolvedValue({ state: 'intent', uncertain: true })
    await s.w.get('button').trigger('click')
    await flushPromises()
    await s.w.get('button').trigger('click')
    await flushPromises()
    expect(s.request).toHaveBeenCalledTimes(1)
    expect(s.w.emitted('state')?.at(-1)).toEqual([{ busy: false, uncertain: true }])
    expect(s.w.emitted('changed')).toHaveLength(1)
  } finally {
    s.w.unmount()
  }
})
