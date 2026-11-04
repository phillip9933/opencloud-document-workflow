// SPDX-License-Identifier: AGPL-3.0-only
import { pageOptions, pageCursor } from './pagination.mjs'
import { inboxSummary } from './inbox.mjs'
import { processingProgress } from '../src/domain/processing.ts'
/** @param {import('./intake.mjs').Intake} intake @param {import('./contracts.d.mts').Actor} actor @param {import('./workflow-contracts.d.mts').PageOptions & {includeHistory?:boolean}} options @param {import('./workflow-contracts.d.mts').InboxCurrentFile[]|null} currentFiles */
export function intakeStatus(intake, actor, options = {}, currentFiles = null) {
  const scope = intake.w.scope(actor),
    configuration = intake.configuration(actor),
    sessionAttached = intake.sessions.has(scope),
    active = intake.activeScope === scope
  const health = /** @type {import('./workflow-contracts.d.mts').IntakeHealth} */ (
    intake.db
      .prepare(
        'select last_attempt lastAttempt,last_success lastSuccess,reason,message from intake_health where scope=?'
      )
      .get(scope) ?? { lastAttempt: null, lastSuccess: null, reason: null, message: null }
  )
  const state = intakeHealthState({
    enabled: configuration.enabled,
    paused: intake.paused(actor),
    active,
    sessionAttached,
    reason: health.reason,
    lastSuccess: health.lastSuccess
  })
  const present = presentQueueIds(intake, scope, currentFiles)
  const queueRecords = intake.records(actor)
  const unresolved = queueRecords.filter(
    (row) =>
      (row.decision && !['done', 'rejected'].includes(row.decision)) ||
      row.state === 'running' ||
      ['pending', 'running'].includes(row.automaticState ?? '')
  )
  const allowed = present
    ? JSON.stringify([...new Set([...present, ...unresolved.map((row) => row.id)])])
    : null
  const { limit, after } = pageOptions(options, 'number'),
    rows = /** @type {import('./workflow-contracts.d.mts').IntakeStatusRow[]} */ (
      intake.db
        .prepare(
          'select q.id,q.resource,q.path,q.etag,q.state,q.attempts,q.job,q.detail,q.stage,q.first_seen firstSeen,d.state decision from intake_queue q left join decisions d on d.job=q.job and d.actor=? where q.scope=? and (? is null or q.id in (select value from json_each(?))) and (? is null or q.first_seen<? or(q.first_seen=? and q.id<?)) order by q.first_seen desc,q.id desc limit ?'
        )
        .all(
          actor.account,
          scope,
          options.includeHistory === true ? null : allowed,
          allowed,
          after?.time ?? null,
          after?.time ?? null,
          after?.time ?? null,
          after?.id ?? null,
          limit + 1
        )
    ),
    queue = rows
      .slice(0, limit)
      .map((row) => describeQueueRow(intake, actor, row, present, unresolved))
  const { summary, historySummary } = queueSummary(
    intake,
    actor,
    queueRecords,
    unresolved,
    currentFiles,
    present
  )
  return {
    configuration,
    paused: intake.paused(actor),
    summary,
    ...(present ? { historicalTotal: historySummary.total } : {}),
    configured: !!intake.db.prepare('select 1 from intake_settings where scope=?').get(scope),
    queue,
    nextCursor:
      rows.length > limit && queue.length
        ? pageCursor(queue[queue.length - 1].firstSeen, queue[queue.length - 1].id)
        : null,
    sessionAttached,
    health: {
      ...health,
      state,
      manualCheck: intake.manualChecks.get(scope)?.state ?? null,
      manualOnly: configuration.intervalSeconds === 0,
      nextScanAt:
        configuration.enabled &&
        !intake.paused(actor) &&
        configuration.intervalSeconds > 0 &&
        sessionAttached &&
        !active
          ? Math.max(intake.now(), (health.lastAttempt ?? 0) + configuration.intervalSeconds * 1000)
          : null
    }
  }
}

/** @param {{enabled:boolean,paused:boolean,active:boolean,sessionAttached:boolean,reason:string|null,lastSuccess:number|null}} state */
export function intakeHealthState({
  enabled,
  paused,
  active,
  sessionAttached,
  reason,
  lastSuccess
}) {
  if (!enabled || paused) return active ? 'pausing' : 'paused'
  if (active) return 'running'
  if (!sessionAttached) return 'waiting_for_session'
  if (reason === 'session') return 'resuming'
  if (reason) return 'held'
  return lastSuccess !== null ? 'ready' : 'starting'
}
/** @param {import('./intake.mjs').Intake} intake @param {string} scope
 * @param {import('./workflow-contracts.d.mts').InboxCurrentFile[]|null} currentFiles
 */
function presentQueueIds(intake, scope, currentFiles) {
  const current =
    currentFiles === null
      ? null
      : new Set(currentFiles.map((file) => JSON.stringify([file.resourceId, file.etag, file.path])))
  const records = current
      ? intake.db.prepare('select id,resource,etag,path from intake_queue where scope=?').all(scope)
      : [],
    present = current
      ? new Set(
          records
            .filter((row) => current.has(JSON.stringify([row.resource, row.etag, row.path])))
            .map((row) => row.id)
        )
      : null

  return present
}

/** @param {import('./intake.mjs').Intake} intake @param {import('./contracts.d.mts').Actor} actor
 * @param {import('./workflow-contracts.d.mts').IntakeStatusRow} row
 * @param {ReturnType<typeof presentQueueIds>} present
 * @param {import('./workflow-contracts.d.mts').IntakeRecord[]} unresolved
 */
function describeQueueRow(intake, actor, row, present, unresolved) {
  const automation =
      row.job && (row.state === 'prepared' || row.state === 'cancelled')
        ? (intake.w.automation.statusFor(actor, row.job) ?? null)
        : null,
    proposalState = row.job
      ? String(
          intake.db.prepare('select state from proposals where id=?').get(row.job)?.state ?? ''
        )
      : null
  return {
    ...row,
    ...(present
      ? { historical: !present.has(row.id) && !unresolved.some((item) => item.id === row.id) }
      : {}),
    automation,
    proposalState,
    retryable:
      (!present || present.has(row.id)) &&
      intake.retryable({ ...row, proposalState, automaticState: automation?.state }),
    progress: processingProgress({ ...row, automatic: automation, proposalState })
  }
}

/** @param {import('./intake.mjs').Intake} intake @param {import('./contracts.d.mts').Actor} actor
 * @param {import('./workflow-contracts.d.mts').IntakeRecord[]} queueRecords
 * @param {import('./workflow-contracts.d.mts').IntakeRecord[]} unresolved
 * @param {import('./workflow-contracts.d.mts').InboxCurrentFile[]|null} currentFiles
 * @param {ReturnType<typeof presentQueueIds>} present
 */
function queueSummary(intake, actor, queueRecords, unresolved, currentFiles, present) {
  const historySummary = intake.summary(actor, queueRecords),
    summary = currentFiles === null ? historySummary : inboxSummary(currentFiles)
  if (present && currentFiles) {
    for (const row of queueRecords.filter((row) => present.has(row.id))) {
      if (intake.retryable(row)) summary.retryable++
      if (intake.cancellable(row)) summary.cancellable++
    }
    for (const row of unresolved.filter(
      (row) =>
        !present.has(row.id) &&
        !currentFiles.some((file) => file.resourceId === row.resource && file.path === row.path)
    )) {
      summary.total++
      summary[intake.bucket(row)]++
    }
  }
  return { summary, historySummary }
}
