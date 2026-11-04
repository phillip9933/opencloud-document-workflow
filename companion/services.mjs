// SPDX-License-Identifier: AGPL-3.0-only
const required = {
  configuration: ['settings', 'destinationSpace'],
  metadata: ['inspect', 'read', 'save', 'reconcile'],
  intake: ['configuration', 'attach', 'detach'],
  automation: ['run', 'guard', 'statusFor'],
  transfers: ['adapter', 'canonical', 'apply'],
  documentTrash: ['pending', 'assertAvailable', 'process'],
  conversions: ['convert', 'association'],
  locations: ['refresh'],
  similarities: ['forJob']
}
/** Validate the complete production service graph before any background work.
 * Small isolated tests may still construct a deliberately partial workflow.
 * @param {Record<string,unknown>} workflow @param {Record<keyof typeof required,unknown>} services
 */
export function bindWorkflowServices(workflow, services) {
  for (const [name, methods] of Object.entries(required)) {
    const service = services[/** @type {keyof typeof required} */ (name)]
    if (
      !service ||
      typeof service !== 'object' ||
      methods.some((method) => typeof Reflect.get(service, method) !== 'function')
    )
      throw new Error(`Missing workflow service: ${name}`)
    if (workflow[name] !== undefined && workflow[name] !== service)
      throw new Error(`Conflicting workflow service: ${name}`)
  }
  for (const [name, service] of Object.entries(services))
    Object.defineProperty(workflow, name, {
      value: service,
      enumerable: true,
      writable: false,
      configurable: false
    })
}
