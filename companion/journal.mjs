// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite'
import { migrateJournal } from './migrations.mjs'
import { acquireRuntime } from './runtime-owner.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateBundle, validateDocumentInput, validatePolicy } from '../src/domain/review.ts'
import { generateProposal, localEndpoint, proposalRecipe } from './ollama.mjs'
import { generateRouted } from './providers.mjs'
import { validatePreparedReview, manualFallbackReason } from './preparation.mjs'
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function preparationContext(input, configuration, { manualFallback, ocrAttempted, workflowScope }) {
  const checked = validateDocumentInput(input)
  const policy = validatePolicy(configuration.policy)
  const rulesOnly =
    configuration.rulesOnly === true && (policy.aiInput === 'off' || policy.aiOutput === 'off')
  if (!rulesOnly && (policy.aiInput === 'off' || policy.aiOutput === 'off'))
    throw new Error('AI input and output must both be enabled for proposal generation')
  const endpoint = rulesOnly
      ? undefined
      : configuration.routes
        ? configuration.endpoint
        : localEndpoint(configuration.endpoint),
    model = rulesOnly ? undefined : configuration.model
  if (
    !rulesOnly &&
    (typeof model !== 'string' ||
      !model.trim() ||
      model.length > 150 ||
      /[\x00-\x1f\x7f]/.test(model) ||
      (!configuration.routes && model.includes(':cloud')))
  )
    throw new Error('Invalid model')
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
      throw new Error('Invalid review revision')
    config.reviewRevision = configuration.reviewRevision
  }
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
    throw new Error('Invalid workflow scope')
  const id = hash({
    input: checked,
    config,
    ...(scope !== sourceScope ? { workflowScope: scope } : {})
  })
  return { checked, rulesOnly, endpoint, model, config, scope, id }
}
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
  if (planner !== null && planner !== undefined)
    return planner(input, model, endpoint, undefined, onResponse)
  const onTagReview = () => onProgress('tagging')
  if (configuration.routes)
    return generateRouted(input, configuration, { cloudKey, onResponse, onTagReview })
  return generateProposal(input, model, endpoint, undefined, onResponse, {
    contextTokens: configuration.contextTokens,
    onTagReview
  })
}
export class ProposalJournal {
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
        if (!this.runtime.proposals.has(row.owner))
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
  get(id) {
    return this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id)
  }
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
    let job = this.get(id)
    if (job.result) return { id, cached: true, review: validateBundle(JSON.parse(job.result)) }
    if (job.state !== 'pending') {
      if (!retry)
        throw new Error('Previous attempt needs explicit retry after inspecting its state')
      if (job.state === 'running' && this.runtime.proposals.has(job.owner))
        throw new Error('Proposal is still running')
    }
    const owner = randomUUID()
    const claimed = this.db
      .prepare(
        `UPDATE proposals SET state='running',owner=?,pid=?,host=?,attempts=attempts+1,updated=? WHERE id=? AND state=? AND attempts=? RETURNING id`
      )
      .get(owner, process.pid, hostname(), new Date().toISOString(), id, job.state, job.attempts)
    if (!claimed) throw new Error('Proposal claimed by another worker')
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
