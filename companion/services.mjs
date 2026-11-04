// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
const required = {
  configuration: ['settings', 'destinationSpace'],
  metadata: ['inspect', 'read', 'save', 'reconcile'],
  intake: ['configuration', 'paused', 'attach', 'detach'],
  automation: ['run', 'guard', 'statusFor'],
  transfers: ['adapter', 'canonical', 'apply'],
  documentTrash: ['pending', 'assertAvailable', 'process'],
  conversions: ['convert', 'association'],
  locations: ['refresh', 'locate'],
  similarities: ['forJob']
}
/** Validate the complete production service graph before any background work.
 * Service constructors do not register themselves; unbound access fails closed.
 * @param {object} workflow @param {Record<keyof typeof required,unknown>} services
 */
export function bindWorkflowServices(workflow, services) {
  for (const [name, methods] of Object.entries(required)) {
    const service = services[/** @type {keyof typeof required} */ (name)]
    if (
      !service ||
      typeof service !== 'object' ||
      methods.some((method) => typeof Reflect.get(service, method) !== 'function')
    )
      throw new WorkflowError('INTERNAL_ERROR', `Missing workflow service: ${name}`)
    if (Object.hasOwn(workflow, name) && Reflect.get(workflow, name) !== service)
      throw new WorkflowError('INTERNAL_ERROR', `Conflicting workflow service: ${name}`)
  }
  for (const [name, service] of Object.entries(services))
    Object.defineProperty(workflow, name, {
      value: service,
      enumerable: true,
      writable: false,
      configurable: false
    })
}

/** An unbound workflow is unusable until the composition root supplies every service.
 * @param {string} name @returns {never}
 */
export function unboundService(name) {
  throw new WorkflowError('INTERNAL_ERROR', `Workflow service is not bound: ${name}`)
}
