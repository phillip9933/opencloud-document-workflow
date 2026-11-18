// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { requestText, optionalText } from './api-input.mjs'
import { validateManualActions, validatePolicy } from '../src/domain/review.ts'
/** @param {Pick<import('./api-contracts.d.mts').RouteServices,'workflow'|'automation'|'send'|'prepare'>} services
 * @returns {Record<string,import('./api-contracts.d.mts').FullAPIRoute>} */
export function createReviewRoutes({ workflow, automation, send, prepare }) {
  return {
    async prepare({ actor, documentAPI, body, res }) {
      send(
        res,
        200,
        await prepare(actor, documentAPI, requestText(body.path), {
          retry: body.retry === true,
          newReview: body.newReview === true,
          cloudConsent: body.cloudConsent === true,
          expectedResourceId: optionalText(body.resourceId),
          expectedEtag: optionalText(body.etag)
        })
      )
      return true
    },
    async approve({ actor, api, body, res }) {
      send(
        res,
        200,
        await workflow.approve(
          actor,
          api,
          requestText(body.id),
          validatePolicy(body.policy),
          requestText(body.reviewDigest),
          body.manualActions === undefined ? undefined : validateManualActions(body.manualActions)
        )
      )
      return true
    },
    async reject({ actor, body, res }) {
      send(res, 200, workflow.reject(actor, requestText(body.id)))
      return true
    },
    async apply({ actor, api, body, res, operation }) {
      const result = await workflow.apply(actor, api, requestText(body.id), {
        reconcileOnly: operation === 'reconcile'
      })
      if (
        result.state === 'done' &&
        automation.statusFor(actor, requestText(body.id)) &&
        automation.statusFor(actor, requestText(body.id))?.state !== 'done'
      )
        automation.update(
          actor,
          requestText(body.id),
          'done',
          operation === 'reconcile'
            ? 'Outcome confirmed by read-only verification'
            : 'Completed after explicit manual filing'
        )
      send(res, 200, result)
      return true
    },
    async activity({ actor, body, res }) {
      const page = workflow.activityPage(actor, body)
      // Account events retain operational identifiers and counts. Document metadata is
      // available through the individual, permission-checked history.
      send(res, 200, {
        ...page,
        events: page.events.map((event) => ({
          ...event,
          detail: event.job
            ? null
            : Object.fromEntries(
                Object.entries(event.detail ?? {}).filter(([key]) =>
                  ['id', 'kind', 'count', 'state', 'attempts', 'stage'].includes(key)
                )
              )
        }))
      })
      return true
    },
    async 'activity-detail'({ actor, api, body, res }) {
      if (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq))
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid event')
      const event = workflow.db
        .prepare('select job,detail from activity where seq=? and scope=?')
        .get(body.seq, workflow.scope(actor))
      if (!event?.job) throw new WorkflowError('RESOURCE_NOT_FOUND', 'Document event not found')
      await workflow.requireReadableJob(actor, api, String(event.job))
      send(res, 200, { detail: JSON.parse(String(event.detail)) })
      return true
    }
  }
}
