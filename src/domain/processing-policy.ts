// SPDX-License-Identifier: AGPL-3.0-only
import type { Policy } from './review'
const changes = ['fields', 'rename', 'move', 'tags'] as const
// Project the old internal gates into choices the user can actually act on.
// A legacy AI-review gate must never become automatic filing merely by saving.
export function editableProcessingPolicy(value: Policy): Policy {
  const policy = JSON.parse(JSON.stringify(value)) as Policy
  if (
    policy.ocr === 'suggest' ||
    (policy.aiInput !== 'off' &&
      policy.aiOutput !== 'off' &&
      (policy.aiInput === 'suggest' || policy.aiOutput === 'suggest'))
  )
    for (const key of changes) if (policy[key] === 'automatic') policy[key] = 'suggest'
  policy.fields ??= 'suggest'
  policy.ocr = policy.ocr === 'off' ? 'off' : 'automatic'
  return policy
}
export function processingPolicy(value: Policy): Policy {
  const policy = JSON.parse(JSON.stringify(value)) as Policy,
    enabled = policy.aiInput !== 'off' && policy.aiOutput !== 'off'
  policy.fields ??= 'suggest'
  policy.ocr = policy.ocr === 'off' ? 'off' : 'automatic'
  policy.aiInput = policy.aiOutput = enabled
    ? changes.some((key) => (policy[key] ?? 'suggest') === 'suggest')
      ? 'suggest'
      : 'automatic'
    : 'off'
  return policy
}

export type ProcessingMode = 'review' | 'automatic'
export function processingMode(value: Policy): ProcessingMode {
  return value.aiInput === 'automatic' &&
    value.aiOutput === 'automatic' &&
    value.ocr !== 'suggest' &&
    changes.every((key) => value[key] === 'automatic')
    ? 'automatic'
    : 'review'
}
export function modeProcessingPolicy(value: Policy, mode: ProcessingMode): Policy {
  const policy = editableProcessingPolicy(value)
  for (const key of changes)
    policy[key] = mode === 'automatic' ? 'automatic' : policy[key] === 'off' ? 'off' : 'suggest'
  policy.aiInput = policy.aiOutput =
    mode === 'automatic'
      ? 'automatic'
      : policy.aiInput !== 'off' && policy.aiOutput !== 'off'
        ? 'suggest'
        : 'off'
  return policy
}
