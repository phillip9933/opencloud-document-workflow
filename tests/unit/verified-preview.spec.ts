// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { useVerifiedPreview } from '../../src/state/verified-preview'

const messages = { changed: 'Document changed', failed: 'Preview failed' }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  let preview!: ReturnType<typeof useVerifiedPreview>
  const view = mount(
    defineComponent({
      setup() {
        preview = useVerifiedPreview()
        return (): null => null
      }
    })
  )
  return { preview, view }
}

it('ignores an older response and error while a new document is loading', async () => {
  const { preview, view } = setup()
  try {
    const first = deferred<Blob>(),
      second = deferred<Blob>(),
      latest = deferred<Blob>()
    const one = preview.load(hash('first'), () => first.promise, messages)
    const two = preview.load(hash('second'), () => second.promise, messages)
    const three = preview.load(hash('latest'), () => latest.promise, messages)
    first.resolve(new Blob(['first']))
    second.reject(new Error('Old request failed'))
    await Promise.all([one, two])
    expect(preview.data.value).toBeNull()
    expect(preview.error.value).toBe('')
    expect(preview.busy.value).toBe(true)
    latest.resolve(new Blob(['latest']))
    await three
    expect(await preview.data.value?.text()).toBe('latest')
    expect(preview.busy.value).toBe(false)
  } finally {
    view.unmount()
  }
})

it('withholds changed bytes and clears the hold only on a fresh verified preview', async () => {
  const { preview, view } = setup()
  try {
    await preview.load(hash('expected'), async () => new Blob(['changed']), messages)
    expect(preview.data.value).toBeNull()
    expect(preview.changed.value).toBe(true)
    expect(preview.error.value).toBe(messages.changed)
    await preview.load(hash('expected'), async () => new Blob(['expected']), messages)
    expect(preview.changed.value).toBe(false)
    expect(preview.error.value).toBe('')
    expect(await preview.data.value?.text()).toBe('expected')
    await preview.load(hash('expected'), async () => null, messages)
    expect(preview.data.value).toBeNull()
    expect(preview.busy.value).toBe(false)
  } finally {
    view.unmount()
  }
})

it('invalidates location resolvers on reset and ignores pending work after unmount', async () => {
  const { preview, view } = setup()
  const pending = deferred<Blob>()
  let current!: () => boolean
  const load = preview.load(
    hash('old'),
    (guard) => {
      current = guard
      return pending.promise
    },
    messages
  )
  expect(current()).toBe(true)
  preview.reset()
  expect(current()).toBe(false)
  view.unmount()
  pending.resolve(new Blob(['old']))
  await load
  expect(preview.data.value).toBeNull()
  expect(preview.error.value).toBe('')
  expect(preview.busy.value).toBe(false)
})

it('ignores a hash check that finishes after a newer preview', async () => {
  const { preview, view } = setup()
  try {
    const bytes = deferred<ArrayBuffer>(),
      old = new Blob(['old'])
    const read = vi.spyOn(old, 'arrayBuffer').mockReturnValue(bytes.promise)
    const pending = preview.load(hash('old'), async () => old, messages)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    await preview.load(hash('current'), async () => new Blob(['current']), messages)
    bytes.resolve(await new Blob(['old']).arrayBuffer())
    await pending
    expect(await preview.data.value?.text()).toBe('current')
    expect(preview.changed.value).toBe(false)
  } finally {
    view.unmount()
  }
})

it('invalidates outstanding work on unmount without changing the retained state', async () => {
  const { preview, view } = setup(),
    pending = deferred<Blob>()
  let current!: () => boolean
  const load = preview.load(
    hash('old'),
    (guard) => {
      current = guard
      return pending.promise
    },
    messages
  )
  view.unmount()
  expect(current()).toBe(false)
  pending.reject(new Error('Late error'))
  await load
  expect(preview.error.value).toBe('')
  expect(preview.data.value).toBeNull()
  expect(preview.busy.value).toBe(true)
  const resolver = vi.fn(async () => new Blob(['new']))
  await preview.load(hash('new'), resolver, messages)
  expect(resolver).not.toHaveBeenCalled()
})
