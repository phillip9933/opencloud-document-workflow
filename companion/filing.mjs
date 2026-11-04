// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'

/**
 * Execute an already authorized same-Space filing under the caller's job and
 * resource locks. Identity/evidence/approval and metadata guards belong to
 * Workflow.apply; this engine must never be exposed as an API operation.
 * @param {import('./contracts.d.mts').FilingContext} context
 */
export async function applyFiling(context) {
  const operation = new FilingOperation(context)
  let state = context.state
  while (true) {
    const result = await operation.step(state)
    if (!('next' in result)) return result
    state = result.next
  }
}

class FilingOperation {
  /** @param {import('./contracts.d.mts').FilingContext} context */
  constructor(context) {
    this.context = context
    this.plan = context.plan
  }
  /** @param {string} state @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async step(state) {
    switch (state) {
      case 'approved':
        return this.approved()
      case 'folders_pending':
        return this.foldersPending()
      case 'move_intent':
        return this.moveIntent()
      case 'move_done':
        return this.moveDone()
      case 'tags_intent':
        return this.tagsIntent()
      case 'done':
        return this.done()
      default:
        throw new WorkflowError('INTERNAL_ERROR', 'Unexpected operation state')
    }
  }
  /** @param {import('./contracts.d.mts').FilingState} state */
  save(state) {
    this.context.save(state, this.plan)
  }
  /** @returns {never} */
  conflict() {
    this.save('conflict')
    throw new WorkflowError(
      'OPERATION_HELD',
      'Remote state conflicts with the approved operation; no further writes made'
    )
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async approved() {
    const { api, source, target, tags, check, reconcileOnly } = this.context
    if (reconcileOnly) return { state: 'approved', target }
    const current = await check(api, source.path, source, source.etag)
    if (!current) return this.conflict()
    if (target !== source.path && (await api.stat(target))) return this.conflict()
    this.plan = {
      originalTags: current.tags,
      expectedTags: [...new Set([...current.tags, ...tags])].sort()
    }
    this.save('folders_pending')
    return { next: 'folders_pending' }
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async foldersPending() {
    const { api, source, target, check, reconcileOnly, guard, event } = this.context
    requireFilingPlan(this.plan)
    if (reconcileOnly) return { state: 'folders_pending', target }
    if (!(await check(api, source.path, source, source.etag))) return this.conflict()
    const folders = target.split('/').slice(0, -1)
    for (let n = 1; n <= folders.length; n++) {
      const folder = folders.slice(0, n).join('/')
      guard()
      event('folder_intent', { folder })
      await api.mkdir(folder)
    }
    if (target === source.path) {
      this.save('move_done')
      return { next: 'move_done' }
    }
    if (await api.stat(target)) return this.conflict()
    guard()
    this.save('move_intent')
    try {
      await api.move(source.path, target, source.etag)
    } catch (error) {
      event('move_response_uncertain')
      throw error
    }
    return { next: 'move_intent' }
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async moveIntent() {
    const { api, source, target, check } = this.context
    const destination = await check(api, target, source)
    if (!destination) {
      if (await api.stat(target)) return this.conflict()
      const original = await check(api, source.path, source, source.etag)
      if (original) return { state: 'move_intent', uncertain: true, target }
      return this.conflict()
    }
    if (await api.stat(source.path)) return this.conflict()
    this.save('move_done')
    return { next: 'move_done' }
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async moveDone() {
    const { api, source, target, tags, check, reconcileOnly, guard, event } = this.context
    const current = await check(api, target, source)
    if (
      !current ||
      !requireFilingPlan(this.plan).originalTags.every((tag) => current.tags.includes(tag))
    )
      return this.conflict()
    if (tags.every((tag) => current.tags.includes(tag))) {
      this.save('done')
      return { state: 'done', target, tags: current.tags }
    }
    if (reconcileOnly) return { state: 'move_done', target }
    guard()
    this.save('tags_intent')
    try {
      await api.addTags(source.resourceId, tags)
    } catch (error) {
      event('tags_response_uncertain')
      throw error
    }
    return { next: 'tags_intent' }
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async tagsIntent() {
    const { api, source, target, check } = this.context
    const current = await check(api, target, source)
    if (
      !current ||
      !requireFilingPlan(this.plan).originalTags.every((tag) => current.tags.includes(tag))
    )
      return this.conflict()
    if (!requireFilingPlan(this.plan).expectedTags.every((tag) => current.tags.includes(tag)))
      return { state: 'tags_intent', uncertain: true, target }
    this.save('done')
    return { state: 'done', target, tags: current.tags }
  }
  /** @returns {Promise<import('./contracts.d.mts').FilingStep>} */
  async done() {
    const { api, source, target, check } = this.context
    const final = await check(api, target, source)
    if (
      !final ||
      !requireFilingPlan(this.plan).expectedTags.every((tag) => final.tags.includes(tag))
    )
      return this.conflict()
    return {
      state: 'done',
      target,
      tags: final.tags,
      verification: {
        checkedAt: new Date().toISOString(),
        resourceId: final.resourceId,
        sha256: source.sha256
      }
    }
  }
}

/** Read only the known shape of a stored filing plan. Missing plans are valid
 * before approval execution, but cannot authorize a resumed write.
 * @param {unknown} value
 * @returns {Partial<import('./contracts.d.mts').TransferPlan>}
 */
export function readFilingPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('OPERATION_HELD', 'Recorded filing plan is invalid')
  const record = /** @type {Record<string,unknown>} */ (value)
  const originalTags = record.originalTags,
    expectedTags = record.expectedTags,
    targetResource = record.targetResource
  if (targetResource !== undefined && typeof targetResource !== 'string')
    throw new WorkflowError('OPERATION_HELD', 'Recorded filing plan is invalid')
  if (
    (originalTags !== undefined &&
      (!Array.isArray(originalTags) || originalTags.some((tag) => typeof tag !== 'string'))) ||
    (expectedTags !== undefined &&
      (!Array.isArray(expectedTags) || expectedTags.some((tag) => typeof tag !== 'string')))
  )
    throw new WorkflowError('OPERATION_HELD', 'Recorded filing plan is invalid')
  return {
    ...(targetResource !== undefined ? { targetResource } : {}),
    ...(originalTags ? { originalTags } : {}),
    ...(expectedTags ? { expectedTags } : {})
  }
}
/** @param {Partial<import('./contracts.d.mts').TransferPlan>} plan @returns {import('./contracts.d.mts').TransferPlan} */
export function requireFilingPlan(plan) {
  if (!plan.originalTags || !plan.expectedTags)
    throw new WorkflowError('OPERATION_HELD', 'Recorded filing plan is incomplete')
  return { ...plan, originalTags: plan.originalTags, expectedTags: plan.expectedTags }
}
