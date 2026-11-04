// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import {
  requestText,
  optionalText,
  requestStrings,
  sourceInput,
  metadataInput
} from './api-input.mjs'
import { safePath } from '../src/domain/review.ts'
import { tagNameKey } from '../src/domain/tag-names.ts'
import { definitionUsage } from './metadata-usage.mjs'
import { inboxFiles, inboxSummary } from './inbox.mjs'
import { processingIssue, preparationState } from './processing-issues.mjs'
/** @param {Pick<import('./api-contracts.d.mts').RouteServices,'workflow'|'metadata'|'documents'|'intake'|'conversions'|'operations'|'similarities'|'documentTrash'|'configurationStore'|'send'|'describeFilesForActor'|'prepare'>} services
 * @returns {Record<string,import('./api-contracts.d.mts').FullAPIRoute>} */
export function createDocumentRoutes({
  workflow,
  metadata,
  documents,
  intake,
  conversions,
  similarities,
  documentTrash,
  configurationStore,
  send,
  describeFilesForActor
}) {
  return {
    async 'tag-options'({ actor, api, res }) {
      /** @type {string[]} */
      let remote = [],
        available = true
      try {
        remote = (await api.listTags?.()) ?? []
      } catch {
        available = false
      }
      send(res, 200, {
        tags: [
          ...new Set([
            ...remote,
            ...metadata
              .schema(actor)
              .tags.map((tag) => tag.tag)
              .filter((tag) => !remote.some((name) => tagNameKey(name) === tagNameKey(tag)))
          ])
        ].filter(
          (tag) =>
            typeof tag === 'string' &&
            tag.trim() &&
            tag.length <= 80 &&
            !/[\x00-\x1f\x7f,]/.test(tag)
        ),
        available
      })
      return true
    },
    async 'metadata-usage'({ actor, api, res }) {
      send(res, 200, await definitionUsage(workflow, documents, actor, api))
      return true
    },
    async 'metadata-schema'({ actor, res }) {
      send(res, 200, metadata.schema(actor))
      return true
    },
    async 'saved-views'({ actor, res }) {
      send(res, 200, { views: documents.views(actor) })
      return true
    },
    async 'saved-view-save'({ actor, body, res }) {
      send(res, 200, {
        views: documents.saveView(actor, { id: body.id, name: body.name, query: body.query })
      })
      return true
    },
    async 'saved-view-delete'({ actor, body, res }) {
      send(res, 200, { views: documents.deleteView(actor, requestText(body.id)) })
      return true
    },
    async 'document-trash-pending'({ actor, res }) {
      send(res, 200, { operations: documentTrash.list(actor) })
      return true
    },
    async 'document-trash'({ actor, api, body, res, operation }) {
      send(
        res,
        200,
        await documentTrash.process(
          actor,
          api,
          operation === 'document-trash-verify'
            ? { id: requestText(body.id) }
            : {
                ...sourceInput(body),
                id: requestText(body.id),
                sha256: requestText(body.sha256),
                documentSpace: optionalText(body.documentSpace),
                job: optionalText(body.job)
              },
          {
            verifyOnly: operation === 'document-trash-verify'
          }
        )
      )
      return true
    },
    async 'prepare-original'({ actor, documentAPI, body, res }) {
      send(res, 200, await workflow.prepareOriginal(actor, documentAPI, sourceInput(body)))
      return true
    },
    async 'library-files'({ actor, api, body, res }) {
      send(res, 200, await documents.browse(actor, api, body))
      return true
    },
    async documents({ actor, api, body, res }) {
      send(res, 200, await documents.currentList(actor, api, body))
      return true
    },
    async jobs({ actor, body, res }) {
      send(res, 200, workflow.jobPage(actor, body))
      return true
    },
    async job({ actor, api, body, res }) {
      const job = workflow.jobView(actor, requestText(body.id))
      /** @type {Array<{id:string,path:string}>} */
      let potentialDuplicates = [],
        duplicateCheck = 'complete'
      try {
        potentialDuplicates = await similarities.forJob(actor, api, requestText(body.id))
      } catch {
        duplicateCheck = 'unavailable'
      }
      send(res, 200, { job: { ...job, potentialDuplicates, duplicateCheck } })
      return true
    },
    async 'document-location'({ actor, api, body, res }) {
      send(res, 200, await workflow.location(actor, api, requestText(body.id)))
      return true
    },
    async 'metadata-schema-save'({ actor, api, body, res }) {
      send(res, 200, await metadata.saveConnectedSchema(actor, api, body.schema))
      return true
    },
    async 'document-processing'({ actor, documentAPI, body, res }) {
      safePath(body.path)
      const source = await documentAPI.stat(requestText(body.path))
      if (
        !source ||
        source.folder ||
        source.resourceId !== body.resourceId ||
        source.etag !== body.etag
      )
        throw new WorkflowError(
          'OPERATION_HELD',
          'The source document changed. Reload document details before continuing.'
        )
      send(res, 200, {
        source: { resourceId: source.resourceId, etag: source.etag },
        ...preparationState(workflow, actor, {
          ...source,
          space: documentAPI.space ?? actor.space
        })
      })
      return true
    },
    async metadata({ actor, documentAPI, body, res }) {
      const result = await metadata.get(actor, documentAPI, requestText(body.path))
      send(res, 200, {
        ...result,
        conversion: conversions.association(actor, result.source.resourceId),
        processingIssue: processingIssue(workflow, actor, result.source)
      })
      return true
    },
    async 'metadata-tag-remove'({ actor, documentAPI, body, res }) {
      send(
        res,
        200,
        await metadata.removeTag(actor, documentAPI, {
          ...metadataInput(body),
          tag: requestText(body.tag)
        })
      )
      return true
    },
    async 'metadata-save'({ actor, documentAPI, body, res }) {
      send(
        res,
        200,
        await metadata.save(actor, documentAPI, {
          ...metadataInput(body),
          fields: body.fields,
          addTags: requestStrings(body.addTags)
        })
      )
      return true
    },
    async 'metadata-reconcile'({ actor, documentAPI, body, res }) {
      send(res, 200, await metadata.reconcile(actor, documentAPI, requestText(body.id)))
      return true
    },
    async files({ actor, api, documentAPI, body, res }) {
      const flat = body.flattenInbox === true
      if (
        flat &&
        (body.documentSpace !== undefined || body.path !== intake.configuration(actor).folder)
      )
        throw new WorkflowError('OPERATION_HELD', 'Choose the configured inbox')
      const listing = flat
        ? await inboxFiles(api, intake.configuration(actor))
        : await documentAPI.list(body.path === undefined ? 'Inbox' : requestText(body.path))
      const files = describeFilesForActor(actor, listing)
      send(res, 200, { files, ...(flat ? { summary: inboxSummary(files) } : {}) })
      return true
    },
    async preview({ actor, documentAPI, body, res }) {
      const current = await documentAPI.stat(requestText(body.path))
      if (!current || current.folder)
        throw new WorkflowError('OPERATION_HELD', 'Document not found')
      const bytes = await documentAPI.get(
        requestText(body.path),
        current.etag,
        configurationStore.settings(actor).limits.maxMiB * 1024 * 1024
      )
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="document.pdf"',
        'X-Content-Type-Options': 'nosniff'
      })
      res.end(bytes)
      return true
    }
  }
}
