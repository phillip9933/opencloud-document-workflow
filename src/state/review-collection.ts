// SPDX-License-Identifier: AGPL-3.0-only
import { ref, computed, toRaw } from 'vue'
import { validateBundle } from '../domain/review'
import type { Review } from '../domain/review'
import type { DraftJob } from './workspace'
export function createReviewCollection() {
  const jobs = ref<DraftJob[]>([]),
    reviews = ref<Review[]>([]),
    selected = ref(0)
  let reviewJobs = new WeakMap<Review, string>()
  const jobsById = computed(() => new Map(jobs.value.map((job) => [job.id, job])))
  function installJobs(rows: DraftJob[]) {
    const previous = reviews.value[selected.value]
    const previousId = previous && jobFor(previous)?.id
    jobs.value = [...new Map(rows.map((job) => [job.id, job])).values()]
    reviewJobs = new WeakMap()
    reviews.value = []
    for (const job of jobs.value) {
      if (!job.bundle) continue
      const review = validateBundle(job.bundle)
      reviewJobs.set(review, job.id)
      reviews.value.push(review)
    }
    const retained = reviews.value.findIndex((review) => jobFor(review)?.id === previousId)
    const sameSource = previous
      ? reviews.value.findIndex((review) => {
          const a = review.bundle.source,
            b = previous.bundle.source
          return (
            a.server === b.server &&
            a.account === b.account &&
            a.space === b.space &&
            a.resourceId === b.resourceId
          )
        })
      : -1
    const waiting = reviews.value.findIndex(
      (review) => review.proposal && !jobFor(review)?.decision
    )
    selected.value =
      retained >= 0 ? retained : sameSource >= 0 ? sameSource : waiting >= 0 ? waiting : 0
  }
  function jobFor(review: Review) {
    const id = reviewJobs.get(toRaw(review))
    return id ? jobsById.value.get(id) : undefined
  }
  function clear() {
    jobs.value = []
    reviews.value = []
    selected.value = 0
    reviewJobs = new WeakMap()
  }
  return { jobs, reviews, selected, jobsById, installJobs, jobFor, clear }
}

export function retainPinnedReview(rows: DraftJob[], pinned?: DraftJob): DraftJob[] {
  const merged = rows.map((job) =>
    pinned && sameRevision(job, pinned) && !Object.hasOwn(job, 'processingIssue')
      ? {
          ...job,
          potentialDuplicates: pinned.potentialDuplicates,
          duplicateCheck: pinned.duplicateCheck,
          preparationReview: pinned.preparationReview,
          processingIssue: pinned.processingIssue
        }
      : job
  )
  return pinned && !merged.some((job) => job.id === pinned.id) ? [pinned, ...merged] : merged
}
function sameRevision(a: DraftJob, b: DraftJob) {
  return (
    a.id === b.id &&
    a.state === b.state &&
    a.decision === b.decision &&
    a.updated === b.updated &&
    a.source.etag === b.source.etag
  )
}
