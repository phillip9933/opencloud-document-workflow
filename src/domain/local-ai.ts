// SPDX-License-Identifier: AGPL-3.0-only
import { validateBundle } from './review'
export interface LocalModel {
  name: string
  digest: string | null
}
async function request(path: string, body: unknown) {
  const response = await fetch(`/_workflow/local/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(130_000)
  })
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('The local AI companion is not connected to this app.')
  }
  if (!response.ok)
    throw new Error(typeof data.error === 'string' ? data.error : 'Local AI request failed')
  return data
}
export async function discoverLocalModels(endpoint: string): Promise<LocalModel[]> {
  const data = await request('models', { endpoint })
  if (!Array.isArray(data.models)) throw new Error('Invalid companion model list')
  return data.models
}
export async function generateSyntheticReview(endpoint: string, model: string, sample: number) {
  const data = await request('synthetic', { endpoint, model, sample })
  return { review: validateBundle(data.bundle), cached: !!data.cached }
}
