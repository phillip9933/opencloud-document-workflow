// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import {
  generateProposal,
  localEndpoint,
  proposalRecipe,
  systemFor,
  schemaFor,
  promptContext,
  boundedJSON,
  tagReviewRequest,
  factInput,
  tagReviewValues,
  tagReviewPromptSize
} from './ollama.mjs'
import { validateAIConfig } from '../src/domain/ai.ts'
import {
  validateBundle,
  validateDocumentInput,
  documentDateCandidates
} from '../src/domain/review.ts'
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
export function executionConfig(preferences, { local, cloud, cloudKey, ocrLanguages = [] }) {
  const ai = validateAIConfig(preferences.ai),
    routes = {}
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
  for (const task of ['facts', 'filing', 'tags']) {
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
export async function generateRouted(
  input,
  configuration,
  { cloudKey, fetcher = fetch, onResponse = () => {}, onTagReview = () => {} } = {}
) {
  const checked = validateDocumentInput(input)
  if (checked.pages.some((p) => !p.trim())) return validateBundle({ ...checked, proposal: null })
  if (Object.values(configuration.routes).some((route) => route?.provider === 'cloud'))
    promptContext(checked, configuration.contextTokens ?? 32768)
  if (
    checked.tagDiscovery &&
    configuration.routes.tags?.provider === 'cloud' &&
    tagReviewPromptSize(checked) > (configuration.contextTokens ?? 32768)
  )
    throw new Error(
      'Document exceeds configured model context capacity; increase it in Processing settings or select a model with a larger context'
    )
  const results = new Map()
  for (const route of Object.values(configuration.routes).filter(Boolean)) {
    const key = JSON.stringify(route)
    if (results.has(key)) continue
    let review
    const tagRoute = configuration.routes.tags && JSON.stringify(configuration.routes.tags) === key,
      requestInput = checked.tagDiscovery && !tagRoute ? factInput(checked) : checked
    if (route.provider === 'local')
      review = await generateProposal(
        requestInput,
        route.model,
        route.endpoint,
        fetcher,
        (raw) => onResponse({ route, proposal: raw }),
        { contextTokens: configuration.contextTokens ?? 32768, onTagReview }
      )
    else {
      if (!cloudKey) throw new Error('Cloud credential unavailable')
      const cloudInput = requestInput.tagDiscovery ? factInput(requestInput) : requestInput
      const data = await boundedJSON(
        await fetcher(`${cloudEndpoint(route.endpoint)}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(120000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloudKey}` },
          body: JSON.stringify({
            model: route.model,
            store: false,
            messages: [
              { role: 'system', content: systemFor(cloudInput) },
              {
                role: 'user',
                content: JSON.stringify({
                  CURRENT_DOCUMENT: cloudInput.pages.map((text, i) => ({ page: i + 1, text })),
                  DATE_CANDIDATES: documentDateCandidates(cloudInput)
                })
              }
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'document_proposal',
                strict: true,
                schema: schemaFor(cloudInput)
              }
            }
          })
        })
      )
      const choice = data.choices?.[0]
      if (
        choice?.finish_reason !== 'stop' ||
        choice.message?.refusal ||
        choice.message?.tool_calls ||
        typeof choice.message?.content !== 'string'
      )
        throw new Error('Cloud result is incomplete or refused')
      let proposal = JSON.parse(choice.message.content)
      onResponse({ route, proposal })
      review = validateBundle({ ...cloudInput, proposal })
      if (requestInput.tagDiscovery) {
        onTagReview()
        const { messages, schema } = tagReviewRequest(requestInput)
        promptContext(requestInput, configuration.contextTokens ?? 32768)
        const result = await boundedJSON(
          await fetcher(`${cloudEndpoint(route.endpoint)}/chat/completions`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(120000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloudKey}` },
            body: JSON.stringify({
              model: route.model,
              store: false,
              messages,
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'document_tags', strict: true, schema }
              }
            })
          })
        )
        const tagChoice = result.choices?.[0]
        if (
          tagChoice?.finish_reason !== 'stop' ||
          tagChoice.message?.refusal ||
          tagChoice.message?.tool_calls ||
          typeof tagChoice.message?.content !== 'string'
        )
          throw new Error('Cloud result is incomplete or refused')
        const tagResult = JSON.parse(tagChoice.message.content),
          tags = tagReviewValues(requestInput, tagResult)
        proposal = { ...review.bundle.proposal, tags }
        onResponse({ route, proposal })
        review = validateBundle({ ...requestInput, proposal })
      }
    }
    results.set(key, review.bundle.proposal)
  }
  const get = (task) =>
    configuration.routes[task] ? results.get(JSON.stringify(configuration.routes[task])) : null
  const facts = get('facts'),
    filing = get('filing'),
    tags = get('tags')
  return validateBundle({
    ...checked,
    proposal: {
      issuer: facts.issuer,
      date: facts.date,
      kind: facts.kind,
      folder: filing?.folder ?? { value: 'Other', evidence: facts.kind.evidence },
      tags: tags?.tags ?? []
    }
  })
}
