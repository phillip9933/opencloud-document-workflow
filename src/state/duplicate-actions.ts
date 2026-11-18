// SPDX-License-Identifier: AGPL-3.0-only
import { computed, type Ref } from 'vue'
import type { DocumentDetail } from '../domain/document-details'
import type { Workspace } from './workspace'
import type { useRouter } from './navigation'
import type { useInboxNavigation } from './inbox-navigation'
interface Options {
  store: Workspace
  router: ReturnType<typeof useRouter>
  data: Ref<DocumentDetail | null>
  busy: Ref<boolean>
  error: Ref<string>
  dirty: Ref<boolean>
  trashUncertain: Ref<boolean>
  navigation: ReturnType<typeof useInboxNavigation>
  alive: () => boolean
}
export function useDuplicateActions({
  store,
  router,
  data,
  busy,
  error,
  dirty,
  trashUncertain,
  navigation,
  alive
}: Options) {
  const duplicate = computed(
    () =>
      store.files.value.find((file) => file.resourceId === data.value?.source.resourceId)?.duplicate
  )
  async function openOriginal() {
    if (!duplicate.value?.job || busy.value) return
    busy.value = true
    error.value = ''
    try {
      const id = duplicate.value.job,
        location = await store.request('document-location', { id })
      await router.push({
        path: '/document-workflow/details',
        query: { path: location.path, job: id, return: 'filed', space: location.space }
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not open original'
    } finally {
      busy.value = false
    }
  }
  async function trashDuplicate() {
    if (!duplicate.value || !data.value || busy.value || dirty.value || data.value.pending.length)
      return
    const id = duplicate.value.id,
      resource = data.value.source.resourceId,
      before = navigation.snapshot(),
      verify = trashUncertain.value || duplicate.value.uncertain
    busy.value = true
    error.value = ''
    trashUncertain.value = true
    try {
      const result = await store.request(verify ? 'duplicate-verify' : 'duplicate-trash', { id })
      if (!alive()) return
      if (result.state === 'trashed') {
        busy.value = false
        await store.refresh()
        await navigation.advance(before, resource)
      } else {
        trashUncertain.value = result.uncertain === true
        error.value = result.detail ?? 'Trash outcome needs verification'
      }
    } catch (e) {
      if (alive()) error.value = e instanceof Error ? e.message : 'Trash outcome needs verification'
    } finally {
      busy.value = false
    }
  }

  return { duplicate, openOriginal, trashDuplicate }
}
