// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref, watch, type Ref } from 'vue'
import { WorkflowError } from '../domain/errors'
import { actions, validateManualActions, type Policy, type Review } from '../domain/review'
import type { Workspace, DraftJob } from './workspace'
interface Context {
  store: Workspace
  active: Ref<Review | undefined>
  job: Ref<DraftJob | undefined>
  policy: Ref<Policy>
  busy: Ref<boolean>
  error: Ref<string>
}
export function useFilingDraft({ store, active, job, policy, busy, error }: Context) {
  const manual = ref(false),
    manualTarget = ref(''),
    manualTags = ref(''),
    manualNeedsDestination = ref(false)
  function manualActions() {
    if (!manual.value) return
    if (manualNeedsDestination.value)
      throw new WorkflowError('VALIDATION_INVALID', 'Choose a destination before filing.')
    return validateManualActions(
      {
        target: manualTarget.value,
        addTags: manualTags.value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      },
      active.value?.bundle.manualReview?.reason === 'original'
        ? active.value.bundle.source.path
        : undefined
    )
  }
  const planning = computed(() => {
    if (job.value?.approval?.actions) return { actions: job.value.approval.actions, error: '' }
    if (!active.value || (active.value.bundle.manualReview && !manualTarget.value.trim()))
      return { actions: null, error: '' }
    try {
      return { actions: actions(active.value, policy.value, manualActions()), error: '' }
    } catch (e) {
      return { actions: null, error: e instanceof Error ? e.message : 'Filing needs attention' }
    }
  })
  const planned = computed(() => planning.value.actions),
    filingProblem = computed(() => planning.value.error)
  function editActions() {
    if (busy.value || job.value?.decision || !active.value) return
    let current
    try {
      current = actions(active.value, policy.value)
      manualNeedsDestination.value = false
    } catch (e) {
      try {
        const existing = actions(active.value, { ...policy.value, move: 'off' })
        if (!existing || !active.value.proposal) return
        const base = active.value.bundle.rules?.root ?? 'Filed'
        current = validateManualActions({
          target:
            policy.value.move === 'off'
              ? existing.target
              : `${base}/${active.value.proposal.folder.value}/${existing.target.split('/').pop()}`,
          addTags: existing.addTags
        })
        manualNeedsDestination.value = true
      } catch {
        manual.value = true
        manualTarget.value = ''
        manualTags.value =
          policy.value.tags === 'off'
            ? ''
            : (active.value.proposal?.tags ?? []).map((tag) => tag.value).join(', ')
        manualNeedsDestination.value = true
        error.value = ''
        return
      }
    }
    if (current) {
      manualTarget.value = current.target
      manualTags.value = current.addTags.join(', ')
      manual.value = true
    }
  }
  watch(
    () => job.value?.id,
    (id) => {
      manual.value = false
      manualNeedsDestination.value = false
      const draft = id ? store.filingDrafts.value[id] : undefined
      manualTarget.value = draft?.target || ''
      manualTags.value = draft?.tags || ''
      manual.value = !!draft || (!!active.value?.bundle.manualReview && !job.value?.decision)
      manualNeedsDestination.value = !!active.value?.bundle.manualReview && !draft?.target
    },
    { immediate: true }
  )
  watch([manualTarget, manualTags, manual, manualNeedsDestination], () => {
    const id = job.value?.id
    if (id && manual.value && !manualNeedsDestination.value && !job.value?.decision)
      store.filingDrafts.value[id] = { target: manualTarget.value, tags: manualTags.value }
  })
  function resetActions() {
    manual.value = false
    manualNeedsDestination.value = false
    if (job.value) delete store.filingDrafts.value[job.value.id]
  }
  watch(
    () => job.value?.decision,
    (decision) => {
      if (decision) {
        manual.value = false
        if (job.value) delete store.filingDrafts.value[job.value.id]
      }
    },
    { immediate: true }
  )

  function chooseManualTarget(target: string) {
    manualTarget.value = target
    manualNeedsDestination.value = false
  }
  return {
    manual,
    manualTarget,
    manualTags,
    manualActions,
    planned,
    filingProblem,
    editActions,
    resetActions,
    chooseManualTarget
  }
}
