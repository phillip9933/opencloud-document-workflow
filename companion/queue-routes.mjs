// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { withTransaction } from './transactions.mjs'
import { processingHistory } from './processing-history.mjs'
import { processingIssue } from './processing-issues.mjs'
import { validateIntake } from './intake-policy.mjs'
import { executionConfig } from './providers.mjs'
import { requestID, requestPage, requestAction, requestSelection } from './api-input.mjs'
/** Queue routes execute only after the main API verifies actor and Space identity.
 * @param {import('./api-contracts.d.mts').QueueRouteServices} services
 * @returns {Record<string,import('./api-contracts.d.mts').APIRoute>}
 */
export function createQueueRoutes({
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
}) {
  const journal = workflow.journal
  return {
    async 'intake-history'({ actor, body, res }) {
      send(res, 200, processingHistory(workflow, actor, requestID(body.id)))
      return true
    },
    async intake({ actor, api, body, res }) {
      const currentFiles = body.currentInbox === true ? await readCurrentInbox(actor, api) : null
      const status = intake.status(
        actor,
        { ...requestPage(body), includeHistory: body.includeHistory === true },
        currentFiles
      )
      send(res, 200, {
        ...status,
        bulkPreparation: operations.processingSummary(actor, currentFiles),
        queue: status.queue.map((row) => ({ ...row, trash: duplicates.record(actor, row.id) })),
        duplicateAction: duplicates.action(actor),
        destinationSpace: configurationStore.destinationSpace(actor),
        destinationRoot: configurationStore.settings(actor).rules.root,
        backgroundSession: backgroundSession(actor)
      })
      return true
    },
    async 'intake-settings'({ actor, api, body, res }) {
      const checked = validateIntake(body.configuration),
        folder = await api.stat(checked.folder)
      if (!folder?.folder)
        throw new WorkflowError(
          'VALIDATION_INVALID',
          'Choose an existing inbox folder in the configured Space'
        )
      if (checked.enabled) {
        const preferences = workflow.preference(actor)
        if (!preferences)
          throw new WorkflowError(
            'OPERATION_HELD',
            'Save processing settings before starting ingestion'
          )
        const configuration = executionConfig(preferences, {
          local,
          cloud: cloudBase,
          cloudKey,
          ocrLanguages: languages(actor)
        })
        if (
          Object.values(configuration.routes).some((route) => route?.provider === 'cloud') &&
          !checked.cloudConsent
        )
          throw new WorkflowError(
            'OPERATION_HELD',
            'Folder cloud consent is required for the selected cloud provider'
          )
        if (preferences.policy.ocr !== 'off' && !languages(actor).length)
          throw new WorkflowError(
            'VALIDATION_INVALID',
            'Choose installed OCR languages in processing settings before starting ingestion'
          )
      }
      if (
        body.duplicateAction !== undefined &&
        body.duplicateAction !== 'keep' &&
        body.duplicateAction !== 'trash'
      )
        throw new WorkflowError('VALIDATION_INVALID', 'Choose a duplicate action')
      const duplicateAction = body.duplicateAction
      const config = withTransaction(journal.db, () => {
        const saved = intake.save(actor, checked, api)
        if (duplicateAction !== undefined) duplicates.save(actor, duplicateAction, checked.folder)
        return saved
      })
      send(res, 200, { configuration: config, duplicateAction: duplicates.action(actor) })
      return true
    },
    async 'intake-scan'({ actor, res }) {
      send(res, 202, intake.requestCheck(actor))
      return true
    },
    async 'intake-item'({ actor, body, res }) {
      const id = requestID(body.id)
      const row = journal.db
        .prepare('select state,job,path,resource,etag from intake_queue where id=? and scope=?')
        .get(id, workflow.scope(actor))
      if (!row)
        throw Object.assign(new WorkflowError('RESOURCE_NOT_FOUND', 'Processing item not found'), {
          status: 404
        })
      send(res, 200, {
        state: row.state,
        job: row.job,
        source: { resourceId: row.resource, etag: row.etag },
        processingIssue: processingIssue(workflow, actor, {
          path: String(row.path),
          resourceId: String(row.resource),
          etag: String(row.etag)
        })
      })
      return true
    },
    async 'intake-retry'({ actor, api, body, res }) {
      const id = requestID(body.id)
      const row = journal.db
        .prepare('select resource,etag,path from intake_queue where id=? and scope=?')
        .get(id, workflow.scope(actor))
      const current = row ? await api.stat(String(row.path)) : null
      if (
        !row ||
        !current ||
        current.folder ||
        current.resourceId !== row.resource ||
        current.etag !== row.etag
      )
        throw new WorkflowError(
          'OPERATION_HELD',
          'This import is no longer current. Refresh Activity.'
        )
      intake.retry(actor, id)
      send(res, 200, { state: 'queued' })
      return true
    },
    async 'intake-control'({ actor, api, body, res }) {
      const action = requestAction(body.action),
        selection = requestSelection(body.ids, action)
      const currentFiles =
        body.currentInbox === true && ['retry', 'cancel'].includes(action)
          ? await readCurrentInbox(actor, api)
          : null
      let ids = selection
      if (currentFiles) {
        const present = new Set(
          currentFiles.map((file) => JSON.stringify([file.resourceId, file.etag, file.path]))
        )
        const allowed = journal.db
          .prepare('select id,resource,etag,path from intake_queue where scope=?')
          .all(workflow.scope(actor))
          .filter((row) => present.has(JSON.stringify([row.resource, row.etag, row.path])))
          .map((row) => String(row.id))
        if (ids !== undefined && (!Array.isArray(ids) || !ids.length))
          throw new WorkflowError('VALIDATION_INVALID', 'Choose processing items')
        ids = ids === undefined ? allowed : ids.filter((id) => allowed.includes(id))
      }
      const result =
        ids?.length === 0
          ? { affected: 0, paused: intake.paused(actor), summary: intake.summary(actor) }
          : intake.manage(actor, action, ids)
      if (action === 'cancel' && !body.ids && currentFiles && ids?.length === 0)
        result.paused = intake.manage(actor, 'pause').paused
      if (!body.ids) {
        if (action === 'cancel') result.affected += operations.cancelProcessing(actor)
        if (action === 'retry')
          result.affected += operations.retryProcessing(actor, api, currentFiles)
        if (action === 'resume') operations.resumeProcessing(actor, api)
      }
      if (
        ['retry', 'resume'].includes(action) &&
        intake.configuration(actor).enabled &&
        !result.paused
      )
        intake.requestCheck(actor)
      send(res, 200, result)
      return true
    }
  }
}
