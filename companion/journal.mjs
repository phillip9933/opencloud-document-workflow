// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite'
import { acquireRuntime } from './runtime-owner.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateBundle, validateDocumentInput, validatePolicy } from '../src/domain/review.ts'
import { generateProposal, localEndpoint, proposalRecipe } from './ollama.mjs'
import { generateRouted } from './providers.mjs'
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
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
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, input TEXT NOT NULL, configuration TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, pid INTEGER, host TEXT,
        result TEXT, raw TEXT, error TEXT, updated TEXT NOT NULL
      );`)
      if (
        !this.db
          .prepare('PRAGMA table_info(proposals)')
          .all()
          .some((c) => c.name === 'raw')
      )
        this.db.exec('ALTER TABLE proposals ADD COLUMN raw TEXT')
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
      const review = rulesOnly
        ? validateBundle({
            ...checked,
            proposal: null,
            manualReview: { reason: checked.pages.some((p) => !p.trim()) ? 'text' : 'rules' }
          })
        : checked.pages.some((p) => !p.trim())
          ? validateBundle({
              ...checked,
              proposal: null,
              ...(manualFallback && ocrAttempted ? { manualReview: { reason: 'text' } } : {})
            })
          : await (
              planner ??
              (configuration.routes
                ? (input, model, endpoint, fetcher, onResponse) =>
                    generateRouted(input, configuration, {
                      cloudKey,
                      onResponse,
                      onTagReview: () => onProgress('tagging')
                    })
                : (...args) =>
                    generateProposal(...args, {
                      contextTokens: configuration.contextTokens,
                      onTagReview: () => onProgress('tagging')
                    }))
            )(checked, model, endpoint, undefined, (raw) =>
              this.db
                .prepare('UPDATE proposals SET raw=? WHERE id=? AND owner=?')
                .run(JSON.stringify(raw), id, owner)
            )
      // Validate again before persisting any provider result.
      const validated = validateBundle(review.bundle)
      const { proposal, manualReview, ...returnedInput } = validated.bundle
      if (JSON.stringify(returnedInput) !== JSON.stringify(checked))
        throw new Error('Provider result changed source identity or extracted pages')
      this.db
        .prepare(
          'UPDATE proposals SET state=?,result=?,error=NULL,owner=NULL,updated=? WHERE id=? AND owner=?'
        )
        .run(validated.state, JSON.stringify(validated.bundle), new Date().toISOString(), id, owner)
      return { id, cached: false, review: validated }
    } catch (e) {
      const evidenceErrors = [
        'Missing bounded evidence',
        'Invalid evidence page',
        'Quote is absent from its page',
        'Fact is not present in its evidence',
        'Folder lacks supporting evidence',
        'Unknown folder category',
        'Invalid tag proposals',
        'Invalid discovered tag name',
        'Unexpected or missing fields',
        'Expected an object',
        'Invalid text field'
      ]
      const reason = manualFallback
        ? evidenceErrors.includes(e.message)
          ? 'evidence'
          : e.message.startsWith('Document exceeds configured model context capacity')
            ? 'capacity'
            : [
                  'Unsupported printed date format; add an explicit language/date rule',
                  'Ambiguous printed date; review the date convention explicitly',
                  'Invalid calendar date'
                ].includes(e.message)
              ? 'date'
              : null
        : null
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
