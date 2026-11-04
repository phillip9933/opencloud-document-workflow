import { createWorkspace } from '../../src/state/workspace'
import { defaultAIConfig, preparationProblem } from '../../src/domain/ai'
import { defaultPolicy } from '../../src/domain/review'
function ready() {
  const ai = defaultAIConfig()
  ai.local.model = 'fixture-model'
  ai.tasks.facts = 'local'
  return { policy: defaultPolicy(), ai }
}
afterEach(() => vi.unstubAllGlobals())
it('requires saved valid fact extraction and explicit operator-enabled cloud capability', () => {
  expect(preparationProblem(null)).toContain('Save')
  expect(preparationProblem({ policy: defaultPolicy(), ai: defaultAIConfig() })).toContain(
    'fact extraction'
  )
  const p = ready()
  expect(preparationProblem(p)).toBe('')
  p.policy.aiInput = 'off'
  expect(preparationProblem(p)).toBe('')
  p.policy.aiInput = 'suggest'
  p.ai.tasks.facts = 'cloud'
  p.ai.cloud = { endpoint: 'https://provider.example/v1', model: 'fixture' }
  expect(preparationProblem(p)).toContain('enabled by')
  expect(preparationProblem(p, true)).toBe('')
})
it('pauses intake before explicitly saving required AI stages Off, without any document operations', async () => {
  const current = ready(),
    calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: any) => {
      const op = url.split('/').pop()!
      calls.push(op)
      return Response.json(
        op === 'status'
          ? { actor: { mode: 'demo' }, jobs: [], preferences: current }
          : op === 'intake'
            ? {
                configuration: {
                  enabled: true,
                  folder: 'Inbox',
                  recursive: true,
                  intervalSeconds: 30,
                  settleSeconds: 10,
                  cloudConsent: false
                }
              }
            : { state: 'done' }
      )
    })
  )
  const store = createWorkspace()
  await store.connect()
  const candidate = ready()
  candidate.ai.tasks.facts = 'off'
  await store.savePreferences(candidate)
  expect(calls).toEqual(['status', 'intake', 'intake', 'intake-settings', 'preferences'])
  expect(store.intakeEnabled.value).toBe(false)
  expect(store.ai.value.tasks.facts).toBe('off')
})
it('does not replace locally confirmed settings when a settings save fails', async () => {
  const current = ready()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith('/status')
          ? { actor: { mode: 'demo' }, jobs: [], preferences: current }
          : url.endsWith('/intake')
            ? { configuration: { enabled: false, folder: 'Inbox' } }
            : { error: 'Server rejected configuration' },
        { status: url.endsWith('/preferences') ? 409 : 200 }
      )
    )
  )
  const store = createWorkspace()
  await store.connect()
  const candidate = ready()
  candidate.ai.local.model = 'unsaved-model'
  await expect(store.savePreferences(candidate)).rejects.toThrow('Server rejected')
  expect(store.ai.value.local.model).toBe('fixture-model')
})
it('uses the companion atomic settings operation when advertised instead of a separate pause request', async () => {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const op = url.split('/').pop()!
      calls.push(op)
      return Response.json(
        op === 'status'
          ? { actor: { mode: 'demo' }, jobs: [], preferences: ready(), atomicPreferencePause: true }
          : op === 'intake'
            ? { configuration: { enabled: true, folder: 'Inbox' } }
            : { paused: true }
      )
    })
  )
  const store = createWorkspace()
  await store.connect()
  const candidate = ready()
  candidate.ai.tasks.facts = 'off'
  const result = await store.savePreferences(candidate)
  expect(calls).toEqual(['status', 'intake', 'preferences'])
  expect(result.paused).toBe(true)
  expect(store.intakeEnabled.value).toBe(false)
})
