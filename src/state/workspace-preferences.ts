// SPDX-License-Identifier: AGPL-3.0-only
import type { Ref } from 'vue'
import { WorkflowError } from '../domain/errors'
import { validatePolicy, type Policy } from '../domain/review'
import { preparationProblem, validateAIConfig, type AIConfig } from '../domain/ai'
import type { createCompanionRequest } from './companion-request'
type Preferences = { policy: Policy; ai: AIConfig }
interface Options {
  policy: Ref<Policy>
  ai: Ref<AIConfig>
  storedPreferences: Ref<Preferences | null>
  intakeEnabled: Ref<boolean>
  capabilities: Ref<{ cloudEnabled: boolean; atomicPreferencePause: boolean }>
  request: ReturnType<typeof createCompanionRequest>
  connected: () => boolean
}
export function workspacePreferenceSaver({
  policy,
  ai,
  storedPreferences,
  intakeEnabled,
  capabilities,
  request,
  connected
}: Options) {
  async function savePreferences(configuration = { policy: policy.value, ai: ai.value }) {
    const snapshot = {
      policy: validatePolicy(JSON.parse(JSON.stringify(configuration.policy))),
      ai: validateAIConfig(JSON.parse(JSON.stringify(configuration.ai)))
    }
    let paused = false
    if (connected()) {
      if (
        !capabilities.value.atomicPreferencePause &&
        intakeEnabled.value &&
        preparationProblem(snapshot, capabilities.value.cloudEnabled)
      ) {
        const current = await request('intake')
        await request('intake-settings', {
          configuration: { ...current.configuration, enabled: false }
        })
        intakeEnabled.value = false
        paused = true
      }
      try {
        const result = await request('preferences', { configuration: snapshot })
        if (result.paused) {
          intakeEnabled.value = false
          paused = true
        }
      } catch (e) {
        if (paused)
          throw new WorkflowError(
            'OPERATION_HELD',
            'Automatic preparation is paused. Could not confirm the settings save; reload saved settings before retrying.',
            { cause: e }
          )
        throw e
      }
    }
    policy.value = snapshot.policy
    ai.value = snapshot.ai
    storedPreferences.value = JSON.parse(JSON.stringify(snapshot))
    return { paused }
  }

  return savePreferences
}
