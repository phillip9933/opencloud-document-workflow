// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { requestText, requestObject } from './api-input.mjs'
import { validatePolicy } from '../src/domain/review.ts'
import { withTransaction } from './transactions.mjs'
import { listModels } from './ollama.mjs'
import { ocrLanguages } from './ocr.mjs'
import { validateAIConfig } from '../src/domain/ai.ts'
/** @param {Pick<import('./api-contracts.d.mts').RouteServices,'workflow'|'journal'|'intake'|'transfers'|'configurationStore'|'packs'|'demo'|'local'|'cloudBase'|'cloudKey'|'send'|'languages'|'prepare'|'backgroundConnect'|'backgroundDisconnect'|'backgroundSession'|'backupDetails'|'backupStatus'|'backupConfigure'>} services
 * @returns {Record<string,import('./api-contracts.d.mts').FullAPIRoute>} */
export function createSystemRoutes({
  workflow,
  journal,
  intake,
  transfers,
  configurationStore,
  packs,
  demo,
  local,
  cloudBase,
  cloudKey,
  send,
  languages,
  backgroundConnect,
  backgroundDisconnect,
  backgroundSession,
  backupDetails,
  backupStatus,
  backupConfigure
}) {
  return {
    async 'demo-add-scan'({ api, res }) {
      if (!demo)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Synthetic fixtures are only available in demo mode'
        )
      if (!api.addScannedFixture)
        throw new WorkflowError('OPERATION_HELD', 'Synthetic fixtures are unavailable')
      send(res, 200, api.addScannedFixture())
      return true
    },
    async status({ actor, body, res }) {
      const options = { activeOnly: body.activeOnly === true }
      const page = workflow.jobPage(actor, options)
      send(res, 200, {
        actor,
        ollama: local,
        cloud: cloudBase,
        cloudEnabled: !!(cloudBase && cloudKey),
        atomicPreferencePause: true,
        preferences: workflow.preference(actor),
        jobs: page.jobs,
        jobsHasMore: page.hasMore,
        jobsCursor: page.nextCursor,
        ocrLanguages: languages(actor)
      })
      return true
    },
    async preferences({ actor, api, body, res }) {
      const input = requestObject(body.configuration)
      const configuration = { ai: validateAIConfig(input.ai), policy: validatePolicy(input.policy) }
      if (
        (local && configuration.ai.local.endpoint !== local) ||
        (!local && Object.values(configuration.ai.tasks).includes('local'))
      )
        throw new WorkflowError(
          'OPERATION_HELD',
          'Local endpoint must match the companion configuration'
        )
      const prior = intake.configuration(actor),
        paused =
          prior.enabled &&
          configuration.policy.aiInput !== 'off' &&
          configuration.policy.aiOutput !== 'off' &&
          configuration.ai.tasks.facts === 'off'
      const saved = withTransaction(journal.db, () => {
        const saved = workflow.savePreference(actor, configuration)
        if (paused) intake.save(actor, { ...prior, enabled: false }, api)
        return saved
      })
      send(res, 200, { ...saved, paused })
      return true
    },
    async models({ res }) {
      if (!local) throw new WorkflowError('OPERATION_HELD', 'Configure a local Ollama endpoint')
      send(res, 200, { models: await listModels(local) })
      return true
    },
    async 'ocr-packs'({ actor, api, body, res, operation }) {
      const canManage = (await api.isAdministrator?.()) === true
      if (operation === 'ocr-pack-install') {
        if (!canManage)
          throw new WorkflowError('ACCESS_DENIED', 'OpenCloud administrator access required')
        await packs.start(requestText(body.code))
        workflow.event(actor, null, 'ocr_language_install_requested', {
          code: requestText(body.code)
        })
      }
      send(res, 200, await packs.status(canManage))
      return true
    },
    async 'ocr-languages'({ actor, res }) {
      send(res, 200, { installed: await ocrLanguages(), selected: languages(actor) })
      return true
    },
    async 'ocr-settings'({ actor, body, res }) {
      const installed = await ocrLanguages()
      if (
        !Array.isArray(body.languages) ||
        body.languages.length > 10 ||
        body.languages.some((l) => !installed.includes(l))
      )
        throw new WorkflowError('OPERATION_HELD', 'Choose installed OCR languages')
      journal.db
        .prepare(
          'insert into ocr_settings values(?,?) on conflict(scope) do update set languages=excluded.languages'
        )
        .run(workflow.scope(actor), JSON.stringify([...new Set(body.languages)]))
      workflow.event(actor, null, 'ocr_languages_saved')
      send(res, 200, { languages: languages(actor) })
      return true
    },
    async 'background-connect'({ actor, body, res }) {
      if (!backgroundConnect)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Private background token storage is not configured'
        )
      let result
      try {
        result = await backgroundConnect(actor, {
          username: requestText(body.username),
          appToken: requestText(body.appToken)
        })
      } catch {
        throw new WorkflowError(
          'OPERATION_HELD',
          'App token connection failed. Check account name, expiry and permissions.'
        )
      }
      workflow.event(actor, null, 'background_app_token_connected')
      send(res, 200, result)
      return true
    },
    async 'background-disconnect'({ actor, res }) {
      if (!backgroundDisconnect)
        throw new WorkflowError(
          'OPERATION_HELD',
          'Private background token storage is not configured'
        )
      send(res, 200, await backgroundDisconnect(actor))
      workflow.event(actor, null, 'background_app_token_disconnected')
      return true
    },
    async reliability({ actor, api, res }) {
      const canManage = (await api.isAdministrator?.()) === true
      const backups = /** @type {Record<string,unknown>} */ ({
        ...(canManage ? await backupDetails(actor, api) : backupStatus()),
        canManage
      })
      if (!canManage) {
        delete backups.settings
        delete backups.storage
        delete backups.destination
      }
      send(res, 200, { backgroundSession: backgroundSession(actor), backups })
      return true
    },
    async 'backup-settings-save'({ actor, api, body, res }) {
      if ((await api.isAdministrator?.()) !== true)
        throw new WorkflowError('ACCESS_DENIED', 'OpenCloud administrator access required')
      if (!backupConfigure)
        throw new WorkflowError('OPERATION_HELD', 'Backup storage is not configured')
      const result = await backupConfigure(body.settings, actor, api)
      workflow.event(actor, null, 'backup_settings_saved')
      send(res, 200, { ...result, canManage: true })
      return true
    },
    async 'filing-settings'({ actor, res }) {
      send(res, 200, {
        ...configurationStore.settings(actor),
        destinationSpace: configurationStore.destinationSpace(actor)
      })
      return true
    },
    async 'filing-settings-save'({ actor, api, body, res }) {
      const targetSpace =
        body.destinationSpace === undefined
          ? configurationStore.destinationSpace(actor)
          : requestText(body.destinationSpace)
      await transfers.adapter(actor, api, targetSpace)
      const result = withTransaction(journal.db, () => {
        configurationStore.saveDestination(actor, targetSpace)
        return configurationStore.save(actor, { rules: body.rules, limits: body.limits })
      })
      send(res, 200, { ...result, destinationSpace: targetSpace })
      return true
    }
  }
}
