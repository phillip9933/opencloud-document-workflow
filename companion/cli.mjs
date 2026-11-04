// SPDX-License-Identifier: AGPL-3.0-only
import { errorProperty } from './error-properties.mjs'
import { WorkflowError } from '../src/domain/errors.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { ProposalJournal } from './journal.mjs'
import { listModels } from './ollama.mjs'
import { defaultPolicy } from '../src/domain/review.ts'
const [mode, inputPath, outputPath] = process.argv.slice(2)
try {
  const endpoint = process.env.WORKFLOW_OLLAMA_URL
  if (!endpoint)
    throw new WorkflowError(
      'OPERATION_HELD',
      'Set WORKFLOW_OLLAMA_URL to the explicitly authorized local Ollama origin'
    )
  if (mode === 'models') console.log(JSON.stringify(await listModels(endpoint), null, 2))
  else if (mode === 'prepare') {
    if (!inputPath || !outputPath || !process.env.WORKFLOW_JOURNAL || !process.env.WORKFLOW_MODEL)
      throw new WorkflowError(
        'OPERATION_HELD',
        'Set WORKFLOW_JOURNAL/WORKFLOW_MODEL and provide input/output paths'
      )
    const data = readFileSync(inputPath)
    if (data.length > 1_000_000) throw new WorkflowError('OPERATION_HELD', 'Input exceeds 1 MB')
    const journal = new ProposalJournal(process.env.WORKFLOW_JOURNAL)
    try {
      const result = await journal.prepare(
        JSON.parse(data.toString('utf8')),
        { endpoint, model: process.env.WORKFLOW_MODEL, policy: defaultPolicy() },
        { retry: process.env.WORKFLOW_RETRY === '1' }
      )
      writeFileSync(outputPath, JSON.stringify(result.review.bundle, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600
      })
      console.log(
        JSON.stringify({
          id: result.id,
          cached: result.cached,
          state: result.review.state,
          output: outputPath
        })
      )
    } finally {
      journal.close()
    }
  } else
    throw new WorkflowError(
      'OPERATION_HELD',
      'Usage: node companion/cli.mjs models | prepare input.json output.json'
    )
} catch (e) {
  console.error(String(errorProperty(e, 'message') ?? 'Operation failed'))
  process.exitCode = 1
}
