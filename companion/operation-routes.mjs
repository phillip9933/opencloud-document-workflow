// SPDX-License-Identifier: AGPL-3.0-only
import { requestText, operationInput } from './api-input.mjs'
/** @param {Pick<import('./api-contracts.d.mts').RouteServices,'automation'|'conversions'|'operations'|'duplicates'|'send'>} services
 * @returns {Record<string,import('./api-contracts.d.mts').FullAPIRoute>} */
export function createOperationRoutes({ automation, conversions, operations, duplicates, send }) {
  return {
    async operations({ actor, res }) {
      send(res, 200, { operations: operations.list(actor) })
      return true
    },
    async operation({ actor, body, res }) {
      send(res, 200, operations.status(actor, requestText(body.id)))
      return true
    },
    async 'conversion-settings'({ actor, res }) {
      send(res, 200, conversions.settings(actor))
      return true
    },
    async 'conversion-settings-save'({ actor, body, res }) {
      send(res, 200, conversions.save(actor, requestText(body.archive)))
      return true
    },
    async 'conversion-reformat'({ actor, api, body, res }) {
      send(res, 200, await conversions.reformat(actor, api, requestText(body.id)))
      return true
    },
    async 'conversion-reformat-verify'({ actor, api, body, res }) {
      send(res, 200, await conversions.verifyReformat(actor, api, requestText(body.id)))
      return true
    },
    async 'conversion-archive'({ actor, api, body, res }) {
      send(res, 200, await conversions.continueArchive(actor, api, requestText(body.id)))
      return true
    },
    async 'conversion-verify'({ actor, api, body, res }) {
      send(res, 200, await conversions.reconcile(actor, api, requestText(body.id)))
      return true
    },
    async 'operation-start'({ actor, api, body, res }) {
      send(res, 202, operations.start(actor, api, operationInput(body)))
      return true
    },
    async 'operation-retry'({ actor, api, body, res }) {
      send(res, 200, operations.retryHeld(actor, api, requestText(body.id)))
      return true
    },
    async 'operation-resume'({ actor, api, body, res }) {
      operations.launch(actor, api, requestText(body.id))
      send(res, 202, operations.status(actor, requestText(body.id)))
      return true
    },
    async 'automation-takeover'({ actor, api, body, res }) {
      send(
        res,
        200,
        await automation.takeOver(actor, api, requestText(body.id), requestText(body.reviewDigest))
      )
      return true
    },
    async 'automation-run'({ actor, api, body, res }) {
      send(
        res,
        200,
        await automation.run(actor, api, requestText(body.id), { retry: body.retry === true })
      )
      return true
    },
    async 'duplicate-trash'({ actor, api, body, res, operation }) {
      send(
        res,
        200,
        await duplicates.process(actor, api, requestText(body.id), {
          reconcileOnly: operation === 'duplicate-verify'
        })
      )
      return true
    }
  }
}
