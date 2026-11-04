// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
/** @param {NodeJS.ProcessEnv} environment @param {'demo'|'live'} mode */
export function listenAddress(environment, mode) {
  const address = environment.WORKFLOW_LISTEN_ADDRESS || '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(address))
    throw new WorkflowError('VALIDATION_INVALID', 'Unsupported listen address')
  if (address === '0.0.0.0' && (mode !== 'live' || environment.WORKFLOW_PRIVATE_NETWORK !== 'true'))
    throw new WorkflowError(
      'OPERATION_HELD',
      'Network listening requires live mode and an explicitly private container network'
    )
  return address
}
