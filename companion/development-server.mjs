// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
/** @param {import('vite').ViteDevServer} server */
export function localPort(server) {
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string')
    throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Local server is not listening')
  return address.port
}
/** @param {string|undefined} value @returns {'demo'|'live'} */
export function runtimeMode(value = 'demo') {
  if (value !== 'demo' && value !== 'live')
    throw new WorkflowError('VALIDATION_INVALID', 'WORKFLOW_MODE must be demo or live')
  return value
}
