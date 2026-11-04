// SPDX-License-Identifier: AGPL-3.0-only
import { localPort } from './development-server.mjs'
// Local development bridge. No production service, remote documents, cloud calls or file mutation.
import { resolve } from 'node:path'
import { ProposalJournal } from './journal.mjs'
import { listModels, localEndpoint } from './ollama.mjs'
import { samples } from '../src/domain/samples.ts'
import { defaultPolicy } from '../src/domain/review.ts'
/** @returns {import('vite').Plugin} */
export function localAIPlugin() {
  return {
    name: 'local-workflow-ai',
    configureServer(server) {
      const endpoint = process.env.WORKFLOW_OLLAMA_URL
        ? localEndpoint(process.env.WORKFLOW_OLLAMA_URL)
        : null
      const db = process.env.WORKFLOW_JOURNAL || resolve('companion/state/preview.sqlite3')
      /** @type {ProposalJournal|undefined} */
      let journal
      let busy = false
      server.httpServer?.once('close', () => journal?.close())
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/_workflow/local/')) return next()
        const port = localPort(server),
          origin = `http://127.0.0.1:${port}`
        /** @param {number} status @param {unknown} data */
        const send = (status, data) => {
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          })
          res.end(JSON.stringify(data))
        }
        if (
          req.headers.host !== `127.0.0.1:${port}` ||
          req.headers.origin !== origin ||
          req.method !== 'POST'
        )
          return send(403, { error: 'Local same-origin POST required' })
        if (!endpoint)
          return send(503, {
            error: 'Start the local preview with an explicitly authorized WORKFLOW_OLLAMA_URL'
          })
        if (busy) return send(409, { error: 'A local AI request is already running' })
        let size = 0,
          parts = [],
          owns = false
        try {
          for await (const chunk of req) {
            size += chunk.length
            if (size > 2048) return send(413, { error: 'Request too large' })
            parts.push(chunk)
          }
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
          if (localEndpoint(body.endpoint) !== endpoint)
            return send(400, {
              error: 'Endpoint must match the companion’s configured local Ollama origin'
            })
          if (busy) return send(409, { error: 'A local AI request is already running' })
          busy = true
          owns = true
          const models = await listModels(endpoint)
          if (req.url === '/_workflow/local/models') return send(200, { endpoint, models })
          if (req.url !== '/_workflow/local/synthetic')
            return send(404, { error: 'Unknown local AI operation' })
          if (!models.some((m) => m.name === body.model))
            return send(400, { error: 'Select an installed local model' })
          if (![0, 1, 2].includes(body.sample))
            return send(400, { error: 'Only the three synthetic fixtures are supported' })
          const { proposal, ...input } = samples()[body.sample]
          journal ??= new ProposalJournal(db)
          const result = await journal.prepare(input, {
            endpoint,
            model: body.model,
            policy: defaultPolicy()
          })
          return send(200, {
            id: result.id,
            cached: result.cached,
            bundle: result.review.bundle,
            state: result.review.state
          })
        } catch {
          return send(422, {
            error:
              'Local AI preparation failed or evidence was rejected. Inspect the local journal before an explicit retry.'
          })
        } finally {
          if (owns) busy = false
        }
      })
    }
  }
}
