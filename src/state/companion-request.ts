// SPDX-License-Identifier: AGPL-3.0-only
import { errorMessageKey } from '../domain/error-messages'
interface RequestContext {
  token(): string
  space(): string
  generation(): number
  connection(): { server: string; account: string; space: string } | null
}
/** Session renewal may continue a read only after the same identity is verified. */
export function createCompanionRequest(context: RequestContext) {
  return async function request(operation: string, body: unknown = {}) {
    const bearer = context.token(),
      generation = context.generation(),
      actor = context.connection(),
      pin = actor ? JSON.stringify([actor.server, actor.account, actor.space]) : null,
      space = context.space()
    let verifiedBearer = bearer
    const checkSession = async () => {
      if (generation !== context.generation())
        throw new Error('The workspace changed. Reload its current state before continuing.')
      if (verifiedBearer === context.token()) return
      const renewed = context.token()
      if (!pin || !renewed)
        throw new Error('The workspace changed. Reload its current state before continuing.')
      // Token renewal is normal during OCR. Re-authenticate the current session
      // before exposing a response produced under the earlier credential.
      const check = await fetch('/_workflow/api/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${renewed}`,
          ...(space ? { 'X-Workflow-Space': space } : {})
        },
        body: JSON.stringify({ activeOnly: true }),
        signal: AbortSignal.timeout(30_000)
      })
      const status = check.ok ? await check.json() : null,
        actor = status?.actor
      if (
        generation !== context.generation() ||
        renewed !== context.token() ||
        !actor ||
        JSON.stringify([actor.server, actor.account, actor.space]) !== pin
      )
        throw new Error('The workspace changed. Reload its current state before continuing.')
      verifiedBearer = renewed
    }
    const response = await fetch(`/_workflow/api/${operation}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(context.space() ? { 'X-Workflow-Space': context.space() } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(480_000)
    })
    await checkSession()
    if (operation === 'preview' && response.ok) {
      const blob = await response.blob()
      await checkSession()
      return blob
    }
    let result
    try {
      result = await response.json()
    } catch {
      throw new Error(
        'Companion is not connected. Start the companion server or configure its same-origin route.'
      )
    }
    await checkSession()
    if (!response.ok)
      throw Object.assign(
        new Error(errorMessageKey(result.code) ?? result.error ?? 'Companion request failed'),
        operation === 'document-trash' && result.trashRecorded === false
          ? { trashRecorded: false }
          : {}
      )
    return result
  }
}
