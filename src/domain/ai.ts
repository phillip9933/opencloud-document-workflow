// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from './errors.ts'
export const aiTasks = [
  {
    id: 'facts',
    label: 'Extract document facts',
    detail: 'Sender, document type and printed date'
  },
  { id: 'filing', label: 'Suggest filing', detail: 'Filename and destination folder' },
  { id: 'tags', label: 'Suggest tags', detail: 'Evidence-backed document categories' }
] as const
export type AITask = (typeof aiTasks)[number]['id']
export interface AIConfig {
  tagDiscovery?: 'off' | 'existing' | 'create'
  local: { endpoint: string; model: string }
  cloud: { endpoint: string; model: string }
  tasks: Record<AITask, 'off' | 'local' | 'cloud'>
  modelOverrides: Record<AITask, string>
}
export function defaultAIConfig(): AIConfig {
  return {
    local: { endpoint: 'http://127.0.0.1:11434', model: '' },
    cloud: { endpoint: '', model: '' },
    tasks: { facts: 'off', filing: 'off', tags: 'off' },
    modelOverrides: { facts: '', filing: '', tags: '' }
  }
}
export function validateAIConfig(input: unknown): AIConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WorkflowError('VALIDATION_INVALID', 'Unexpected AI configuration fields.')
  // The candidate is returned only after all provider/task fields are checked.
  const config = input as AIConfig
  const exact = (value: unknown, keys: string[]) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
    )
      throw new WorkflowError('VALIDATION_INVALID', 'Unexpected AI configuration fields.')
  }
  exact(config, [
    'local',
    'cloud',
    'tasks',
    'modelOverrides',
    ...('tagDiscovery' in config ? ['tagDiscovery'] : [])
  ])
  if ('tagDiscovery' in config && !['off', 'existing', 'create'].includes(config.tagDiscovery!))
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid tag discovery mode.')
  exact(
    config.tasks,
    aiTasks.map((t) => t.id)
  )
  exact(
    config.modelOverrides,
    aiTasks.map((t) => t.id)
  )
  for (const key of ['local', 'cloud'] as const) {
    exact(config[key], ['endpoint', 'model'])
    if (typeof config[key].endpoint !== 'string' || typeof config[key].model !== 'string')
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid provider configuration.')
  }
  const normalized = structuredClone(config)
  for (const provider of ['local', 'cloud'] as const) {
    const p = normalized[provider]
    if (p.endpoint) {
      const url = new URL(p.endpoint)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new WorkflowError(
          'VALIDATION_INVALID',
          'Use an HTTP endpoint without credentials, query parameters or fragments.'
        )
      if (provider === 'local') {
        if (url.pathname !== '/')
          throw new WorkflowError(
            'VALIDATION_INVALID',
            'Ollama needs a server origin without an API path.'
          )
        p.endpoint = url.origin
      }
      if (provider === 'cloud' && url.protocol !== 'https:')
        throw new WorkflowError('VALIDATION_INVALID', 'Cloud endpoints require HTTPS.')
      if (p.endpoint.length > 500)
        throw new WorkflowError('VALIDATION_INVALID', 'Endpoint is too long.')
    }
    if (p.model.length > 150 || /[\x00-\x1f\x7f]/.test(p.model))
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid model identifier.')
  }
  for (const task of aiTasks) {
    const override = config.modelOverrides[task.id]
    if (typeof override !== 'string' || override.length > 150 || /[\x00-\x1f\x7f]/.test(override))
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid task model identifier.')
    const target = config.tasks[task.id]
    if (!['off', 'local', 'cloud'].includes(target))
      throw new WorkflowError('VALIDATION_INVALID', 'Unknown AI task destination.')
    if (
      target !== 'off' &&
      (!config[target].endpoint.trim() || !(override.trim() || config[target].model.trim()))
    )
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Set an endpoint and model before assigning a task to that provider.'
      )
  }
  if (config.tagDiscovery && config.tagDiscovery !== 'off' && config.tasks.tags === 'off')
    throw new WorkflowError(
      'VALIDATION_INVALID',
      'Choose a provider for AI tags before enabling semantic tag review.'
    )
  return normalized
}

// This is a UI readiness check; the companion independently validates execution.
export function preparationProblem(
  preferences: { ai: AIConfig; policy: { aiInput: string; aiOutput: string } } | null,
  cloudEnabled = false
): string {
  if (!preferences) return 'Save your AI and processing settings before preparing documents.'
  if (preferences.policy.aiInput === 'off' || preferences.policy.aiOutput === 'off') return ''
  try {
    const ai = validateAIConfig(JSON.parse(JSON.stringify(preferences.ai)))
    if (ai.tasks.facts === 'off')
      return 'Choose a provider and model for fact extraction in AI settings.'
    if (Object.values(ai.tasks).includes('cloud') && !cloudEnabled)
      return 'The cloud provider must be enabled by the companion operator.'
  } catch (e) {
    return e instanceof Error ? e.message : 'Check your AI settings.'
  }
  return ''
}
