// SPDX-License-Identifier: AGPL-3.0-only
import { cloudCompletion } from './provider-response.mjs'
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
/** @param {Parameters<typeof resolveExecutionConfig>[0]} preferences @param {Parameters<typeof resolveExecutionConfig>[1]} options */
export const executionConfig = (preferences, options) =>
  resolveExecutionConfig(preferences, options, proposalRecipe)
/** @param {import('../src/domain/review.ts').DocumentInput} input
 * @param {import('./proposal-contracts.d.mts').RoutedConfiguration} configuration
 * @param {{cloudKey?: string, fetcher?: typeof fetch, onResponse?: (raw: unknown) => void, onTagReview?: () => void}} options
 * @returns {Promise<import('../src/domain/review.ts').Review>}
 */
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
  /** @type {Map<string, import('../src/domain/review.ts').Proposal | null>} */
  const results = new Map()
  for (const route of Object.values(configuration.routes)) {
    if (!route) continue
    const key = JSON.stringify(route)
    if (results.has(key)) continue
    const review = await reviewRoute(checked, configuration, route, key, {
      cloudKey,
      fetcher,
      onResponse,
      onTagReview
    })
    results.set(key, review.bundle.proposal)
  }
  /** @param {import('../src/domain/ai.ts').AITask} task */
  const get = (task) =>
    configuration.routes[task] ? results.get(JSON.stringify(configuration.routes[task])) : null
  const facts = get('facts'),
    filing = get('filing'),
    tags = get('tags')
  if (!facts) throw new WorkflowError('UPSTREAM_FAILURE', 'Fact extraction returned no proposal')
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

/** @param {import('../src/domain/review.ts').DocumentInput} checked
 * @param {import('./proposal-contracts.d.mts').RoutedConfiguration} configuration
 * @param {NonNullable<import('./proposal-contracts.d.mts').RoutedConfiguration['routes']['facts']>} route
 * @param {string} key
 * @param {{cloudKey?:string,fetcher:typeof fetch,onResponse:(raw:unknown)=>void,onTagReview:()=>void}} options
 */
async function reviewRoute(
  checked,
  configuration,
  route,
  key,
  { cloudKey, fetcher, onResponse, onTagReview }
) {
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
    if (!cloudKey) throw new WorkflowError('DEPENDENCY_UNAVAILABLE', 'Cloud credential unavailable')
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
    /** @type {unknown} */
    let proposal = JSON.parse(cloudCompletion(data))
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
      const tagResult = JSON.parse(cloudCompletion(result)),
        tags = tagReviewValues(requestInput, tagResult)
      proposal = { ...review.bundle.proposal, tags }
      onResponse({ route, proposal })
      review = validateBundle({ ...requestInput, proposal })
    }
  }
  return review
}
