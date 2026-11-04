// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { cloudEndpoint, resolveExecutionConfig } from './provider-routing.mjs'
export { cloudEndpoint } from './provider-routing.mjs'
import {
  generateProposal,
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
import {
  validateBundle,
  validateDocumentInput,
  documentDateCandidates
} from '../src/domain/review.ts'
export const executionConfig = (preferences, options) =>
  resolveExecutionConfig(preferences, options, proposalRecipe)
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
    throw new WorkflowError(
      'WORKFLOW_CONTEXT_CAPACITY',
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
