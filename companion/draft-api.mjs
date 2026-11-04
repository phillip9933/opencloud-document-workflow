// SPDX-License-Identifier: AGPL-3.0-only
import { createSystemRoutes } from './system-routes.mjs'
import { createOperationRoutes } from './operation-routes.mjs'
import { createDocumentRoutes } from './document-routes.mjs'
import { createReviewRoutes } from './review-routes.mjs'
import { requestText, sourceInput } from './api-input.mjs'
import { createQueueRoutes } from './queue-routes.mjs'
import { bindWorkflowServices } from './services.mjs'
import { describeFiles } from './file-listing.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { readRequestBody } from './http-body.mjs'
import { apiError } from './api-errors.mjs'
import { logEvent } from './logging.mjs'
import { ProposalJournal } from './journal.mjs'
import { Workflow } from './workflow.mjs'
import { Metadata } from './metadata.mjs'
import { FiledLocations } from './locations.mjs'
import { DocumentLibrary } from './documents.mjs'
import { DocumentTrash } from './document-trash.mjs'
import { Conversions } from './conversions.mjs'
import { Operations } from './operations.mjs'
import { Configuration } from './configuration.mjs'
import { Automation } from './automation.mjs'
import { Transfers } from './transfers.mjs'
import { Duplicates } from './duplicates.mjs'
import { SimilarDocuments } from './similarity.mjs'
import { Intake } from './intake.mjs'
import { DemoAdapter } from './demo.mjs'
import { inboxFiles } from './inbox.mjs'
import { OpenCloudAdapter } from './opencloud.mjs'
import { localEndpoint } from './ollama.mjs'
import { executionConfig, cloudEndpoint } from './providers.mjs'
import { OCRPacks } from './ocr-packs.mjs'
import { ocrLanguages, runOCRTool } from './ocr.mjs'
/** @param {import('./api-contracts.d.mts').APIOptions} options */
export function createWorkflowAPI({
  logger = logEvent,
  database,
  mode = 'demo',
  origin,
  space,
  ollama,
  cloud,
  cloudKey,
  allowOrigin,
  backgroundConnect,
  backgroundDisconnect,
  backgroundSession = () => ({ configured: false, state: 'not_configured' }),
  backupStatus = () => ({ configured: false, state: 'not_configured' }),
  backupDetails = backupStatus,
  backupConfigure,
  observeSession = () => {},
  ocrDirectory,
  ocrPackOptions = {},
  adapterFactory = (options) => new OpenCloudAdapter(options)
}) {
  if (!['demo', 'live'].includes(mode))
    throw new WorkflowError('OPERATION_HELD', 'Invalid runtime mode')
  if (mode === 'live' && !origin)
    throw new WorkflowError('OPERATION_HELD', 'Live mode requires an explicit OpenCloud origin')
  const journal = new ProposalJournal(database),
    workflow = new Workflow(journal),
    metadata = new Metadata(workflow),
    documents = new DocumentLibrary(workflow),
    configurationStore = new Configuration(workflow)

  const local = ollama ? localEndpoint(ollama) : null,
    cloudBase = cloud ? cloudEndpoint(cloud) : null

  /** @param {import('./contracts.d.mts').Actor} actor @returns {string[]} */
  const languages = (actor) =>
    JSON.parse(
      String(
        journal.db
          .prepare('select languages from ocr_settings where scope=?')
          .get(workflow.scope(actor))?.languages ?? '[]'
      )
    )
  const demo = mode === 'demo' ? new DemoAdapter(journal.db) : null
  demo?.seed()
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api @param {string} path @param {import('./workflow-contracts.d.mts').PrepareOptions & {cloudConsent?:boolean}} options */
  const prepare = async (actor, api, path, options = {}) => {
    const preferences = workflow.preference(actor)
    if (!preferences)
      throw new WorkflowError('OPERATION_HELD', 'Save AI settings before preparing a review')
    const execution = executionConfig(preferences, {
      local,
      cloud: cloudBase,
      cloudKey,
      ocrLanguages: languages(actor)
    })
    const configuration = {
      ...execution,
      contextTokens: configurationStore.settings(actor).limits.contextTokens
    }
    if (
      Object.values(configuration.routes).some((r) => r?.provider === 'cloud') &&
      options.cloudConsent !== true
    )
      throw new WorkflowError(
        'OPERATION_HELD',
        'Confirm sending extracted document text to the selected cloud provider'
      )
    return workflow.prepare(actor, api, path, configuration, { ...options, cloudKey })
  }
  const conversions = new Conversions(workflow)
  const operations = new Operations(workflow, {
    metadata,
    logger,
    prepare,
    convert: (actor, api, input) => conversions.convert(actor, api, sourceInput(input)),
    session: (actor) => intake.sessions.get(workflow.scope(actor))?.api,
    invalidateSession: (api) => intake.detach(api)
  })
  /** @type {Automation} */
  let automation
  const intake = new Intake(workflow, {
    logger,
    prepare,
    processPrepared: (actor, api, id, options) => automation.run(actor, api, id, options),
    resume: async (actor, api) => {
      await automation.resume(actor, api)
      await duplicates.resume(actor, api)
    }
  })
  automation = new Automation(workflow, metadata, intake, { logger })
  const duplicates = new Duplicates(workflow, intake),
    transfers = new Transfers(workflow),
    similarities = new SimilarDocuments(workflow),
    documentTrash = new DocumentTrash(workflow)
  bindWorkflowServices(workflow, {
    configuration: configurationStore,
    metadata,
    intake,
    automation,
    transfers,
    documentTrash,
    conversions,
    locations: new FiledLocations(workflow),
    similarities
  })
  const packs = new OCRPacks(workflow, {
    directory: ocrDirectory,
    installed: ocrLanguages,
    validate: (path) => runOCRTool('combine_tessdata', ['-d', path]),
    ...ocrPackOptions
  })
  /** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 413 ? { Connection: 'close' } : {})
    })
    res.end(JSON.stringify(body))
  }
  /** @type {WeakMap<import('./api-contracts.d.mts').ServiceAdapter,import('./api-contracts.d.mts').ServiceAdapter[]>} */
  const managedSessions = new WeakMap()
  /** @param {import('./api-contracts.d.mts').ServiceAdapter} api @param {{account?:string}} options */
  const attach = async (api, { account } = {}) => {
    const actor = api.accountIdentity ? await api.accountIdentity() : await api.identity()
    if (mode === 'live' && (actor.server !== origin || (account && actor.account !== account)))
      throw new WorkflowError('ACCESS_DENIED', 'Background identity mismatch')
    const group = []
    try {
      const verified = await api.identity()
      if (workflow.scope(verified) !== workflow.scope(actor))
        throw new WorkflowError('OPERATION_HELD', 'Space identity changed')
      intake.attach(verified, api, { background: true })
      group.push(api)
    } catch {
      workflow.event(actor, null, 'background_space_held', {
        reason: 'Space access could not be verified'
      })
    }
    for (const row of journal.db.prepare('select scope from intake_settings').all()) {
      const [server, owner, target] = JSON.parse(String(row.scope))
      if (server !== actor.server || owner !== actor.account || target === actor.space) continue
      try {
        const scoped = api.forSpace(target),
          verified = await scoped.identity()
        if (workflow.scope(verified) !== row.scope)
          throw new WorkflowError('OPERATION_HELD', 'Space identity changed')
        intake.attach(verified, scoped, { background: true })
        group.push(scoped)
      } catch {
        workflow.event({ server, account: owner, space: target }, null, 'background_space_held', {
          reason: 'Space access could not be verified'
        })
      }
    }
    managedSessions.set(api, group)
    for (const session of intake.sessions.values())
      if (group.some((adapter) => adapter === session.api) && !intake.paused(session.actor))
        operations.resumeProcessing(session.actor, session.api)
    return actor
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').FileEntry[]} listing */
  const describeFilesForActor = (actor, listing) => describeFiles({ workflow }, actor, listing)
  /** @param {import('./contracts.d.mts').Actor} actor @param {import('./contracts.d.mts').MutationAdapter} api */
  async function readCurrentInbox(actor, api) {
    const configuration = intake.configuration(actor),
      listing = await inboxFiles(api, configuration)
    if (JSON.stringify(configuration) !== JSON.stringify(intake.configuration(actor)))
      throw new WorkflowError('OPERATION_HELD', 'The inbox settings changed. Refresh Activity.')
    return describeFilesForActor(actor, listing)
  }
  const routeServices = {
    workflow,
    metadata,
    documents,
    journal,
    intake,
    automation,
    conversions,
    operations,
    duplicates,
    transfers,
    similarities,
    documentTrash,
    configurationStore,
    packs,
    demo,
    local,
    cloudBase,
    cloudKey,
    send,
    languages,
    describeFilesForActor,
    prepare,
    backgroundConnect,
    backgroundDisconnect,
    backgroundSession,
    backupDetails,
    backupStatus,
    backupConfigure
  }
  // Handlers run only after common origin, identity and document-Space checks.
  /** @type {Record<string,import('./api-contracts.d.mts').FullAPIRoute>} */
  const routes = {
    ...createQueueRoutes({
      workflow,
      intake,
      operations,
      duplicates,
      configurationStore,
      readCurrentInbox,
      backgroundSession,
      languages,
      local,
      cloudBase,
      cloudKey,
      send
    }),
    ...createSystemRoutes(routeServices),
    ...createOperationRoutes(routeServices),
    ...createDocumentRoutes(routeServices),
    ...createReviewRoutes(routeServices)
  }
  routes['ocr-pack-install'] = routes['ocr-packs']
  routes['duplicate-verify'] = routes['duplicate-trash']
  routes['document-trash-verify'] = routes['document-trash']
  routes['reconcile'] = routes['apply']
  /** @param {import('./api-contracts.d.mts').ServiceAdapter} directory @param {import('./contracts.d.mts').Actor} identity */
  async function selectSpace(directory, identity) {
    let target = /** @type {string|undefined} */ (
      journal.db
        .prepare('select space from workspace_selection where server=? and account=?')
        .get(identity.server, identity.account)?.space
    )
    if (!target) {
      const configured = journal.db
        .prepare('select scope from intake_settings')
        .all()
        .map((row) => JSON.parse(String(row.scope)))
        .filter(([server, account]) => server === origin && account === identity.account)
      const choices = [...new Set(configured.map(([, , id]) => id))]
      if (choices.length === 1) target = choices[0]
      else if (choices.length > 1)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Choose a workflow Space from a previously connected browser before connecting this device'
        )
      else {
        const available = await directory.spaces(),
          personal = available.filter((value) => value.type === 'personal')
        if (personal.length === 1) target = personal[0].id
        else if (available.length === 1) target = available[0].id
        else
          throw new WorkflowError(
            'OPERATION_HELD',
            'Select an OpenCloud Space before setting up this workflow'
          )
      }
    }
    return target
  }
  /** @param {import('node:http').IncomingMessage} req @param {string} operation */
  async function authenticate(req, operation) {
    const selectedSpace = req.headers['x-workflow-space']
    if (
      selectedSpace !== undefined &&
      (typeof selectedSpace !== 'string' ||
        !selectedSpace ||
        selectedSpace.length > 400 ||
        /[/\\?#%\x00-\x20]/.test(selectedSpace))
    )
      throw new WorkflowError('REQUEST_INVALID', 'Invalid selected Space')
    /** @type {import('./api-contracts.d.mts').ServiceAdapter|null} */
    let api = demo ? (selectedSpace ? demo.forSpace(selectedSpace) : demo) : null
    let bootstrapAccount
    if (!api) {
      if (!origin)
        throw new WorkflowError('OPERATION_HELD', 'Live mode requires an OpenCloud origin')
      const auth = req.headers.authorization
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !auth.slice(7).trim())
        throw new WorkflowError('AUTH_REQUIRED', 'OpenCloud sign-in required')
      let target = selectedSpace ?? space
      if (!target && operation !== 'spaces') {
        const directory = adapterFactory({
            origin,
            space: '__space_directory__',
            token: auth.slice(7)
          }),
          identity = await directory.accountIdentity?.()
        if (
          identity?.server !== origin ||
          typeof identity.account !== 'string' ||
          !identity.account
        )
          throw new WorkflowError('ACCESS_DENIED', 'Authenticated account could not be verified')
        bootstrapAccount = identity.account
        target = await selectSpace(directory, identity)
      }
      api = adapterFactory({
        origin,
        space: target ?? '__space_directory__',
        token: auth.slice(7)
      })
    }

    return { api, bootstrapAccount }
  }
  const service = {
    close: () => {
      clearInterval(intake.timer)
      intake.stopped = true
      journal.close()
    },
    async stop() {
      await packs.stop()
      await operations.stop()
      await intake.stop()
      journal.close()
    },
    async start() {
      if (demo) await attach(demo)
      intake.start()
    },
    attach,
    /** @param {import('./api-contracts.d.mts').ServiceAdapter} api */
    detach(api) {
      const group = managedSessions.get(api) ?? [api]
      for (const adapter of group) intake.detach(adapter)
      managedSessions.delete(api)
    },
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      if (!req.url?.startsWith('/_workflow/api/')) return false
      const expected = allowOrigin instanceof Function ? allowOrigin() : allowOrigin
      if (
        req.headers.host !== new URL(expected).host ||
        req.method !== 'POST' ||
        req.headers.origin !== expected
      ) {
        send(res, 403, { error: 'Same-origin POST required' })
        return true
      }
      try {
        const operation = req.url.slice('/_workflow/api/'.length)
        const { api, bootstrapAccount } = await authenticate(req, operation)
        if (operation === 'spaces') {
          const spaces = await api.spaces()
          await readRequestBody(req)
          send(res, 200, { spaces })
          return true
        }
        if (api instanceof DemoAdapter) api.seed()
        const actor = await api.identity()
        if (
          (bootstrapAccount && actor.account !== bootstrapAccount) ||
          (mode === 'live' && actor.server !== origin)
        )
          throw new WorkflowError('ACCESS_DENIED', 'Workspace identity changed')
        const body = await readRequestBody(req)
        if (operation === 'status' && mode === 'live')
          journal.db
            .prepare(
              'insert into workspace_selection values(?,?,?) on conflict(server,account) do update set space=excluded.space'
            )
            .run(actor.server, actor.account, actor.space)
        intake.attach(actor, api)
        observeSession(actor, api)
        /** @type {import('./contracts.d.mts').MutationAdapter} */
        let documentAPI = api
        if (body.documentSpace !== undefined) {
          if (
            ![
              'files',
              'metadata',
              'metadata-save',
              'metadata-reconcile',
              'metadata-tag-remove',
              'preview',
              'prepare',
              'document-processing',
              'document-trash',
              'prepare-original'
            ].includes(operation)
          )
            throw new WorkflowError('OPERATION_HELD', 'Unexpected document Space')
          documentAPI = await transfers.adapter(actor, api, requestText(body.documentSpace))
        }
        if (Object.hasOwn(routes, operation))
          return await routes[operation]({ actor, api, documentAPI, body, res, operation })
        send(res, 404, { error: 'Unknown operation' })
        return true
      } catch (e) {
        logger('request_failed', e)
        if (res.headersSent || res.writableEnded || res.destroyed) {
          if (!res.writableEnded) res.destroy()
          return true
        }
        const failure = apiError(e)
        send(res, failure.status, failure.body)
        return true
      }
    }
  }
  return service
}

// Compatibility for development plugins and existing integrations.
export const createDraftAPI = createWorkflowAPI
