// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { validateAIConfig } from '../src/domain/ai.ts'
/** @param {string} value */
export function localEndpoint(value) {
  const u = new URL(value)
  const h = u.hostname
  const privateHost =
    h === 'localhost' ||
    h === '[::1]' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  if (
    !privateHost ||
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw new Error(
      'Local Ollama requires an explicit private-network or loopback origin without credentials'
    )
  return u.origin
}
/** @param {string} value */
export function cloudEndpoint(value) {
  const u = new URL(value)
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname.includes('//')
  )
    throw new Error('Cloud provider requires an HTTPS API base without credentials')
  return u.href.replace(/\/$/, '')
}
/** @param {{ai:import('../src/domain/ai.ts').AIConfig,policy:import('../src/domain/review.ts').Policy}} preferences
 * @param {{local?:string|null,cloud?:string|null,cloudKey?:string,ocrLanguages?:string[]}} options
 * @param {string} proposalRecipe
 */
export function resolveExecutionConfig(
  preferences,
  { local, cloud, cloudKey, ocrLanguages = [] },
  proposalRecipe
) {
  const ai = validateAIConfig(preferences.ai),
    routes =
      /** @type {Partial<Record<import('../src/domain/ai.ts').AITask,{provider:'local'|'cloud',endpoint:string,model:string}|null>>} */ ({})
  if (preferences.policy.aiInput === 'off' || preferences.policy.aiOutput === 'off')
    return {
      rulesOnly: true,
      policy: preferences.policy,
      routes,
      ocrLanguages,
      recipe: 'local-rules-v1'
    }
  if (ai.tasks.facts === 'off')
    throw new Error('Enable fact extraction before preparing a filing review')
  for (const task of /** @type {const} */ (['facts', 'filing', 'tags'])) {
    const provider = ai.tasks[task]
    if (provider === 'off') {
      routes[task] = null
      continue
    }
    const selected = ai[provider],
      endpoint =
        provider === 'local' ? localEndpoint(selected.endpoint) : cloudEndpoint(selected.endpoint)
    if (provider === 'local' && endpoint !== local)
      throw new Error('Local provider must match operator configuration')
    if (provider === 'cloud' && (!cloudKey || !cloud || endpoint !== cloudEndpoint(cloud)))
      throw new Error('Cloud execution is not enabled for this provider by the companion operator')
    routes[task] = { provider, endpoint, model: ai.modelOverrides[task] || selected.model }
  }
  if (!routes.facts) throw new Error('Enable fact extraction before preparing a filing review')
  return {
    ...(ai.tagDiscovery && ai.tagDiscovery !== 'off' && routes.tags
      ? { tagDiscovery: ai.tagDiscovery }
      : {}),
    endpoint: routes.facts.endpoint,
    model: routes.facts.model,
    policy: preferences.policy,
    routes,
    ocrLanguages,
    recipe: createHash('sha256')
      .update(proposalRecipe + 'task-routes-v1')
      .digest('hex')
  }
}
