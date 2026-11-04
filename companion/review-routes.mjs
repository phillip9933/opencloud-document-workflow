// SPDX-License-Identifier: AGPL-3.0-only
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
      send(res, 200, workflow.activityPage(actor, body))
      return true
    }
  }
}
