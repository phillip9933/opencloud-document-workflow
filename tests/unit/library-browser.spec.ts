// SPDX-License-Identifier: AGPL-3.0-only
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { filterLibrary, libraryFacets, libraryTree } from '../../src/domain/library'
import type { LibraryEntry } from '../../src/domain/library'
import LibraryFiles from '../../src/components/LibraryFiles.vue'
import { createWorkspace, workspaceKey } from '../../src/state/workspace'
const folder = (path: string): LibraryEntry => ({ path, resourceId: path, folder: true, tags: [] })
const file = (path: string, tags: string[], fields = {}): LibraryEntry => ({
  path,
  resourceId: path,
  etag: 'v1',
  folder: false,
  tags,
  fields
})
const entries = [
  folder('Docs/Vehicles'),
  folder('Docs/Receipts'),
  folder('Docs/Receipts/2026'),
  folder('Docs/Empty'),
  file('Docs/Vehicles/registration.pdf', ['Vehicles', 'Alex'], { number: 'ＡＢ１２３' }),
  file('Docs/Receipts/2026/repair.pdf', ['Vehicles', 'Receipts'], { amount: 120 }),
  file('Docs/Receipts/2026/shop.jpg', ['Receipts', 'Jordan'])
]
const base = { search: '', tags: [] as string[], format: '' }
it('combines words, all selected tags and formats, normalizes search, and narrows tag choices to matching files', () => {
  expect(
    filterLibrary(entries, { search: 'vehicles ab123', tags: ['Alex'], format: 'PDF' }).map(
      (e) => e.path
    )
  ).toEqual(['Docs/Vehicles/registration.pdf'])
  expect(libraryFacets(entries, { ...base, tags: ['Vehicles'] })).toEqual([
    { tag: 'Alex', count: 1 },
    { tag: 'Receipts', count: 1 },
    { tag: 'Vehicles', count: 2 }
  ])
  expect(libraryFacets(entries, { ...base, tags: ['Vehicles', 'Receipts'] })).toEqual([
    { tag: 'Receipts', count: 1 },
    { tag: 'Vehicles', count: 1 }
  ])
  expect(libraryFacets(entries, { search: 'no match', tags: ['Vehicles'], format: '' })).toEqual([
    { tag: 'Vehicles', count: 0 }
  ])
  expect(filterLibrary(entries, { ...base, format: 'Images' }).map((e) => e.path)).toEqual([
    'Docs/Receipts/2026/shop.jpg'
  ])
})
it('keeps normal empty folders but prunes branches without matches and expands matching descendants', () => {
  expect(
    libraryTree(entries, filterLibrary(entries, base), 'Docs', new Set(), false).map(
      (r) => r.entry.path
    )
  ).toEqual(['Docs/Empty', 'Docs/Receipts', 'Docs/Vehicles'])
  const matches = filterLibrary(entries, { ...base, tags: ['Receipts', 'Vehicles'] })
  const tree = libraryTree(entries, matches, 'Docs', new Set(), true)
  expect(tree.map((r) => [r.entry.path, r.depth])).toEqual([
    ['Docs/Receipts', 0],
    ['Docs/Receipts/2026', 1],
    ['Docs/Receipts/2026/repair.pdf', 2]
  ])
  expect(
    libraryTree(entries, matches, 'Docs', new Set(), true, new Set(['Docs/Receipts'])).map(
      (r) => r.entry.path
    )
  ).toEqual(['Docs/Receipts'])
})
const Details = defineComponent({
  props: ['path'],
  emits: ['state', 'changed'],
  template: `<section class="test-editor">{{ path }}<button @click="$emit('state',{dirty:true,busy:false,uncertain:false})">Draft</button><button @click="$emit('state',{dirty:false,busy:true,uncertain:false});$emit('changed')">Saving</button><button @click="$emit('state',{dirty:false,busy:false,uncertain:false})">Saved</button></section>`
})
async function setup() {
  const store = createWorkspace()
  store.connection.value = {
    mode: 'live',
    server: 'https://fixture.test',
    account: 'fixture',
    space: 'inbox',
    name: 'Fixture'
  }
  const request = vi.spyOn(store, 'request').mockImplementation(async (op, body: any) => {
      if (op !== 'library-files') throw Error(op)
      const path = body?.path ?? 'Docs'
      return {
        root: 'Docs',
        space: 'library',
        path,
        files: entries.filter((e) => e.path.split('/').slice(0, -1).join('/') === path)
      }
    }),
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:all(.*)', component: { template: '<div />' } }]
    })
  await router.push('/document-workflow/documents')
  const w = mount(LibraryFiles, {
    global: {
      plugins: [router],
      provide: { [workspaceKey as symbol]: store },
      stubs: { DocumentDetails: Details }
    }
  })
  await flushPromises()
  return { w, store, request, router }
}
const button = (w: any, text: string) =>
  w.findAll('button').find((b: any) => b.text() === text || b.attributes('aria-label') === text)!
it('indexes nested folders, keeps details inline with filters intact, and uses the same matching tree in folder view', async () => {
  const s = await setup()
  try {
    expect(s.request.mock.calls.map((c) => (c[1] as any)?.path ?? 'Docs').sort()).toEqual([
      'Docs',
      'Docs/Empty',
      'Docs/Receipts',
      'Docs/Receipts/2026',
      'Docs/Vehicles'
    ])
    await s.w.get('input[type=search]').setValue('repair')
    expect(s.w.findAll('.browser-entry')).toHaveLength(1)
    await button(s.w, 'repair.pdf').trigger('click')
    await flushPromises()
    expect(s.w.get('.test-editor').text()).toContain('Docs/Receipts/2026/repair.pdf')
    expect(s.router.currentRoute.value.fullPath).toBe('/document-workflow/documents')
    expect((s.w.get('input').element as HTMLInputElement).value).toBe('repair')
    expect(s.w.findAll('.facet-tags label').map((b) => b.text())).toEqual([
      'Receipts1',
      'Vehicles1'
    ])
    await button(s.w, 'Folders').trigger('click')
    expect(s.w.findAll('.browser-entry').map((b) => b.text())).toEqual([
      'Receipts',
      '2026',
      'repair.pdf'
    ])
    expect(s.w.find('.test-editor').exists()).toBe(true)
    expect(s.request.mock.calls.every((c) => c[0] === 'library-files')).toBe(true)
  } finally {
    s.w.unmount()
  }
})
it('protects unsaved inline edits and refreshes the list only after a confirmed save is no longer busy', async () => {
  const s = await setup()
  try {
    await button(s.w, 'registration.pdf').trigger('click')
    await flushPromises()
    await button(s.w, 'Draft').trigger('click')
    expect(s.w.get('input[type=search]').attributes('disabled')).toBeDefined()
    expect(button(s.w, 'repair.pdf').attributes('disabled')).toBeDefined()
    const n = s.request.mock.calls.length
    await button(s.w, 'Saving').trigger('click')
    await flushPromises()
    expect(s.request).toHaveBeenCalledTimes(n)
    await button(s.w, 'Saved').trigger('click')
    await flushPromises()
    expect(s.request.mock.calls.length).toBeGreaterThan(n)
    expect(s.w.get('input[type=search]').attributes('disabled')).toBeUndefined()
  } finally {
    s.w.unmount()
  }
})
it('discards late old-account listings without committing their results', async () => {
  const s = await setup()
  try {
    let resolve!: (v: any) => void
    s.request.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    s.store.connection.value = { ...s.store.connection.value!, account: 'next' }
    await flushPromises()
    expect(s.w.findAll('.browser-entry')).toHaveLength(0)
    s.store.connection.value = null
    await flushPromises()
    resolve({ root: 'Docs', space: 'library', files: entries })
    await flushPromises()
    expect(s.w.findAll('.browser-entry')).toHaveLength(0)
  } finally {
    s.w.unmount()
  }
})

it('rejects a destination change mid-index instead of presenting partial facets as complete', async () => {
  const s = await setup()
  try {
    s.request.mockImplementation(async (_op, body: any) => ({
      root: body?.path ? 'Other' : 'Docs',
      space: 'library',
      files: body?.path ? [] : [folder('Docs/New')]
    }))
    s.store.connection.value = { ...s.store.connection.value!, account: 'changed' }
    await flushPromises()
    expect(s.w.text()).toContain('The filing destination changed. Refresh documents.')
    expect(s.w.findAll('.browser-entry')).toHaveLength(0)
  } finally {
    s.w.unmount()
  }
})

it('uses tag checkboxes to narrow results while keeping layout controls with the list', async () => {
  const s = await setup()
  try {
    const vehicles = s.w
      .findAll('.facet-tags label')
      .find((label) => label.text().startsWith('Vehicles'))!
    await vehicles.get('input').setValue(true)
    expect(s.w.findAll('.browser-entry')).toHaveLength(2)
    expect(
      s.w.findAll('.facet-tags label').some((label) => label.text().startsWith('Jordan'))
    ).toBe(false)
    await s.w
      .findAll('.facet-tags label')
      .find((label) => label.text().startsWith('Receipts'))!
      .get('input')
      .setValue(true)
    expect(s.w.findAll('.browser-entry')).toHaveLength(1)
    expect(s.w.get('.browser-entry').text()).toBe('repair.pdf')
    expect(s.w.find('.list-toolbar [aria-label="Folders"]').exists()).toBe(true)
    expect(s.w.find('.browser-toolbar [aria-label="Folders"]').exists()).toBe(false)
    await button(s.w, 'Clear filters').trigger('click')
    expect(s.w.findAll('.browser-entry')).toHaveLength(3)
    expect(s.request.mock.calls.every((c) => c[0] === 'library-files')).toBe(true)
  } finally {
    s.w.unmount()
  }
})

it('follows an open file by identity after an external rename and refreshes on return without replacing a draft', async () => {
  const s = await setup()
  try {
    await button(s.w, 'registration.pdf').trigger('click')
    await flushPromises()
    await button(s.w, 'Draft').trigger('click')
    const renamed = entries.map((entry) =>
      entry.path === 'Docs/Vehicles/registration.pdf'
        ? { ...entry, path: 'Docs/Vehicles/renamed.pdf' }
        : entry
    )
    s.request.mockImplementation(async (_op, body: any) => {
      const path = body?.path ?? 'Docs'
      return {
        root: 'Docs',
        space: 'library',
        files: renamed.filter((entry) => entry.path.slice(0, entry.path.lastIndexOf('/')) === path)
      }
    })
    const count = s.request.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(s.request).toHaveBeenCalledTimes(count)
    expect(s.w.get('.test-editor').text()).toContain('registration.pdf')
    await button(s.w, 'Saved').trigger('click')
    await flushPromises()
    expect(s.w.get('.test-editor').text()).toContain('Docs/Vehicles/renamed.pdf')
    expect(button(s.w, 'renamed.pdf')).toBeDefined()
  } finally {
    s.w.unmount()
  }
})
it('shows a directional chevron for collapsed documents and reverses it when clicked open, then closed', async () => {
  const s = await setup()
  try {
    const row = button(s.w, 'registration.pdf')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(row.get('.entry-chevron').classes()).not.toContain('open')
    await row.trigger('click')
    await flushPromises()
    expect(row.attributes('aria-expanded')).toBe('true')
    expect(row.get('.entry-chevron').classes()).toContain('open')
    await row.trigger('click')
    await flushPromises()
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(row.get('.entry-chevron').classes()).not.toContain('open')
    expect(s.w.find('.test-editor').exists()).toBe(false)
  } finally {
    s.w.unmount()
  }
})
it('updates a confirmed document in place without re-indexing folders and refreshes its facets', async () => {
  const s = await setup()
  try {
    await button(s.w, 'registration.pdf').trigger('click')
    await flushPromises()
    const n = s.request.mock.calls.length
    s.w
      .findComponent(Details)
      .vm.$emit('changed', {
        path: 'Docs/Vehicles/registration.pdf',
        resourceId: 'Docs/Vehicles/registration.pdf',
        etag: 'v1',
        tags: ['Alex'],
        fields: { number: 'AB123' }
      })
    await flushPromises()
    expect(s.request).toHaveBeenCalledTimes(n)
    expect(s.w.find('.test-editor').exists()).toBe(true)
    expect(s.w.findAll('.facet-tags label').map((b) => b.text())).toContain('Vehicles1')
  } finally {
    s.w.unmount()
  }
})
