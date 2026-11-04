// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localAIPlugin } from '../../companion/preview-api.mjs'
function middleware() {
  let handler
  const prior = process.env.WORKFLOW_OLLAMA_URL
  process.env.WORKFLOW_OLLAMA_URL = 'http://192.168.1.50:11434'
  try {
    localAIPlugin().configureServer({
      httpServer: { address: () => ({ port: 5174 }), once: () => {} },
      middlewares: {
        use: (h) => {
          handler = h
        }
      }
    })
  } finally {
    if (prior === undefined) delete process.env.WORKFLOW_OLLAMA_URL
    else process.env.WORKFLOW_OLLAMA_URL = prior
  }
  return handler
}
async function call(
  handler,
  {
    origin = 'http://127.0.0.1:5174',
    host = '127.0.0.1:5174',
    method = 'POST',
    body = { endpoint: 'http://192.168.1.51:11434' }
  } = {}
) {
  let status, data
  const req = {
    url: '/_workflow/local/models',
    headers: { origin, host },
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  await handler(
    req,
    {
      writeHead: (s) => {
        status = s
      },
      end: (b) => {
        data = JSON.parse(b)
      }
    },
    () => {}
  )
  return { status, data }
}
test('development bridge rejects foreign origins, hosts, and methods before provider access', async () => {
  const h = middleware()
  for (const args of [
    { origin: 'https://foreign.example' },
    { origin: undefined },
    { host: 'foreign.example' },
    { method: 'GET' }
  ]) {
    if (Object.hasOwn(args, 'origin') && args.origin === undefined) args.origin = ''
    assert.equal((await call(h, args)).status, 403)
  }
})
test('development bridge refuses another endpoint instead of acting as a network proxy', async () => {
  assert.equal((await call(middleware())).status, 400)
})
