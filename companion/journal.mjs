// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { DatabaseSync } from 'node:sqlite'
import { migrateJournal } from './migrations.mjs'
import { acquireRuntime } from './runtime-owner.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateBundle, validateDocumentInput, validatePolicy } from '../src/domain/review.ts'
import { generateProposal, localEndpoint, proposalRecipe } from './ollama.mjs'
import { generateRouted } from './providers.mjs'
import { validatePreparedReview, manualFallbackReason } from './preparation.mjs'
/** @typedef {import('./proposal-contracts.d.mts').ProposalConfiguration} ProposalConfiguration */
/** @typedef {import('./proposal-contracts.d.mts').PreparationOptions} PreparationOptions */
/** @param {unknown} v */
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
/** @param {import('../src/domain/review.ts').DocumentInput} input
 * @param {ProposalConfiguration} configuration
 * @param {{manualFallback: boolean, ocrAttempted: boolean, workflowScope?: string}} options
 */
function preparationContext(input, configuration, { manualFallback, ocrAttempted, workflowScope }) {
  const checked = validateDocumentInput(input)
  const policy = validatePolicy(configuration.policy)
  const rulesOnly =
    configuration.rulesOnly === true && (policy.aiInput === 'off' || policy.aiOutput === 'off')
  if (!rulesOnly && (policy.aiInput === 'off' || policy.aiOutput === 'off'))
    throw new WorkflowError(
      'OPERATION_HELD',
      'AI input and output must both be enabled for proposal generation'
    )
  const endpoint = rulesOnly
      ? undefined
      : configuration.routes
        ? configuration.endpoint
        : localEndpoint(configuration.endpoint ?? ''),
    model = rulesOnly ? undefined : configuration.model
  validateModel(model, rulesOnly, configuration.routes)
  /** @type {ProposalConfiguration & {localRulesVersion?: number, proposalRecipe?: string, manualReviewVersion?: number, ocrAttempted?: boolean}} */
  const config = rulesOnly
    ? { policy, localRulesVersion: 1 }
    : { endpoint, model, policy, proposalRecipe }
  if (manualFallback) {
    config.manualReviewVersion = 1
    if (ocrAttempted) config.ocrAttempted = true
  }
  if (configuration.contextTokens) config.contextTokens = configuration.contextTokens
  if (configuration.routes) {
    config.routes = configuration.routes
    config.recipe = configuration.recipe
  }
  if (configuration.ocrLanguages) config.ocrLanguages = configuration.ocrLanguages
  if (configuration.reviewRevision) {
    if (!/^[a-f0-9-]{36}$/.test(configuration.reviewRevision))
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid review revision')
    config.reviewRevision = configuration.reviewRevision
  }
  const { sourceScope, scope } = preparationScope(checked, workflowScope)
  const id = hash({
    input: checked,
    config,
    ...(scope !== sourceScope ? { workflowScope: scope } : {})
  })
  return { checked, rulesOnly, endpoint, model, config, scope, id }
}
/** @param {string|undefined} model @param {boolean} rulesOnly @param {ProposalConfiguration['routes']} routes */
function validateModel(model, rulesOnly, routes) {
  if (
    !rulesOnly &&
    (typeof model !== 'string' ||
      !model.trim() ||
      model.length > 150 ||
      /[\x00-\x1f\x7f]/.test(model) ||
      (!routes && model.includes(':cloud')))
  )
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid model')
}
/** @param {import('../src/domain/review.ts').DocumentInput} checked @param {string|undefined} workflowScope */
function preparationScope(checked, workflowScope) {
  const sourceScope = JSON.stringify([
      checked.source.server,
      checked.source.account,
      checked.source.space
    ]),
    scope = workflowScope ?? sourceScope
  if (
    typeof scope !== 'string' ||
    JSON.stringify(JSON.parse(scope).slice(0, 2)) !==
      JSON.stringify([checked.source.server, checked.source.account])
  )
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid workflow scope')
  return { sourceScope, scope }
}
/** @param {import('../src/domain/review.ts').DocumentInput} input
 * @param {ProposalConfiguration} configuration
 * @param {PreparationOptions & {rulesOnly: boolean, model?: string, endpoint?: string, onProgress: (stage: 'tagging') => void, onResponse: (raw: unknown) => void}} options
 * @returns {Promise<import('../src/domain/review.ts').Review>}
 */
async function generateReview(
  input,
  configuration,
  {
    rulesOnly,
    manualFallback,
    ocrAttempted,
    planner,
    cloudKey,
    model,
    endpoint,
    onProgress,
    onResponse
  }
) {
  if (rulesOnly)
    return validateBundle({
      ...input,
      proposal: null,
      manualReview: { reason: input.pages.some((page) => !page.trim()) ? 'text' : 'rules' }
    })
  if (input.pages.some((page) => !page.trim()))
    return validateBundle({
      ...input,
      proposal: null,
      ...(manualFallback && ocrAttempted ? { manualReview: { reason: 'text' } } : {})
    })
  if (!model || !endpoint)
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid model configuration')
  if (planner !== null && planner !== undefined)
    return planner(input, model, endpoint, undefined, onResponse)
  const onTagReview = () => onProgress('tagging')
  if (configuration.routes)
    return generateRouted(
      input,
      { ...configuration, routes: configuration.routes },
      { cloudKey, onResponse, onTagReview }
    )
  return generateProposal(input, model, endpoint, undefined, onResponse, {
    contextTokens: configuration.contextTokens,
    onTagReview
  })
}
export class ProposalJournal {
  /** @param {string} path */
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.ownership = acquireRuntime(path)
      this.runtime = this.ownership.runtime
    } catch (error) {
      this.db.close()
      throw error
    }
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
      migrateJournal(this.db)

      for (const row of this.db
        .prepare("SELECT id,owner FROM proposals WHERE state='running'")
        .all()) {
        if (typeof row.owner !== 'string' || !this.runtime.proposals.has(row.owner))
          this.db
            .prepare(
              "UPDATE proposals SET state='failed',owner=NULL,error='Preparation interrupted; retry required' WHERE id=?"
            )
            .run(row.id)
      }
    } catch (error) {
      this.db.close()
      this.ownership.release()
      throw error
    }
  }
  close() {
    try {
      this.db.close()
    } finally {
      this.ownership.release()
    }
  }
  /** @param {string} id @returns {import('./proposal-contracts.d.mts').ProposalRow | undefined} */
  get(id) {
    // The row shape is owned by migrateJournal, not a provider or request payload.
    return /** @type {import('./proposal-contracts.d.mts').ProposalRow | undefined} */ (
      this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id)
    )
  }
  /** @param {import('../src/domain/review.ts').DocumentInput} input
   * @param {ProposalConfiguration} configuration
   * @param {PreparationOptions} options
   */
  async prepare(
    input,
    configuration,
    {
      retry = false,
      planner,
      cloudKey,
      scope: workflowScope,
      manualFallback = false,
      ocrAttempted = false,
      onProgress = () => {}
    } = {}
  ) {
    const { checked, rulesOnly, endpoint, model, config, scope, id } = preparationContext(
      input,
      configuration,
      { manualFallback, ocrAttempted, workflowScope }
    )
    this.db
      .prepare(
        'INSERT OR IGNORE INTO proposals(id,scope,input,configuration,state,updated) VALUES(?,?,?,?,?,?)'
      )
      .run(
        id,
        scope,
        JSON.stringify(checked),
        JSON.stringify(config),
        'pending',
        new Date().toISOString()
      )
    const job = this.get(id)
    if (!job) throw new WorkflowError('INTERNAL_ERROR', 'Proposal journal row is missing')
    if (job.result) return { id, cached: true, review: validateBundle(JSON.parse(job.result)) }
    if (job.state !== 'pending') {
      if (!retry)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Previous attempt needs explicit retry after inspecting its state'
        )
      if (job.state === 'running' && job.owner && this.runtime.proposals.has(job.owner))
        throw new WorkflowError('OPERATION_HELD', 'Proposal is still running')
    }
    const owner = randomUUID()
    const claimed = this.db
      .prepare(
        `UPDATE proposals SET state='running',owner=?,pid=NULL,host=NULL,attempts=attempts+1,updated=? WHERE id=? AND state=? AND attempts=? RETURNING id`
      )
      .get(owner, new Date().toISOString(), id, job.state, job.attempts)
    if (!claimed) throw new WorkflowError('OPERATION_HELD', 'Proposal claimed by another worker')
    this.runtime.proposals.add(owner)
    try {
      const review = await generateReview(checked, configuration, {
        rulesOnly,
        manualFallback,
        ocrAttempted,
        planner,
        cloudKey,
        model,
        endpoint,
        onProgress,
        onResponse: (raw) =>
          this.db
            .prepare('UPDATE proposals SET raw=? WHERE id=? AND owner=?')
            .run(JSON.stringify(raw), id, owner)
      })
      // Validate again before persisting any provider result.
      const validated = validatePreparedReview(checked, review.bundle)
      this.db
        .prepare(
          'UPDATE proposals SET state=?,result=?,error=NULL,owner=NULL,updated=? WHERE id=? AND owner=?'
        )
        .run(validated.state, JSON.stringify(validated.bundle), new Date().toISOString(), id, owner)
      return { id, cached: false, review: validated }
    } catch (e) {
      const reason = manualFallbackReason(e, manualFallback)
      if (reason) {
        const review = validateBundle({ ...checked, proposal: null, manualReview: { reason } })
        this.db
          .prepare(
            "UPDATE proposals SET state='needs_details',result=?,error=NULL,owner=NULL,updated=? WHERE id=? AND owner=?"
          )
          .run(JSON.stringify(review.bundle), new Date().toISOString(), id, owner)
        return { id, cached: false, review }
      }
      this.db
        .prepare(
          "UPDATE proposals SET state='failed',error=?,owner=NULL,updated=? WHERE id=? AND owner=?"
        )
        .run(
          'Proposal generation or evidence validation failed',
          new Date().toISOString(),
          id,
          owner
        )
      throw e
    } finally {
      this.runtime.proposals.delete(owner)
    }
  }
}
