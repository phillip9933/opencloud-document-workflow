import { defaultAIConfig, validateAIConfig } from '../../src/state/workspace'
describe('AI preference boundaries', () => {
  it('starts with every AI task off', () => {
    expect(Object.values(validateAIConfig(defaultAIConfig()).tasks)).toEqual(['off', 'off', 'off'])
  })
  it('requires an endpoint and model for assigned tasks', () => {
    const c = defaultAIConfig()
    c.tasks.facts = 'cloud'
    expect(() => validateAIConfig(c)).toThrow('endpoint and model')
    c.cloud.endpoint = 'https://provider.example/v1'
    c.cloud.model = 'example-model'
    expect(validateAIConfig(c).tasks.facts).toBe('cloud')
  })
  it('allows a task-specific model in place of a provider default', () => {
    const c = defaultAIConfig()
    c.tasks.tags = 'local'
    c.modelOverrides.tags = 'example-tags-model'
    expect(validateAIConfig(c).modelOverrides.tags).toBe('example-tags-model')
  })
  it('normalizes a local origin with a trailing slash without mutating the input', () => {
    const c = defaultAIConfig()
    c.local.endpoint = 'http://127.0.0.1:11434/'
    expect(validateAIConfig(c).local.endpoint).toBe('http://127.0.0.1:11434')
    expect(c.local.endpoint).toBe('http://127.0.0.1:11434/')
  })
  it('rejects embedded credentials and insecure cloud endpoints', () => {
    const c = defaultAIConfig()
    for (const endpoint of [
      'https://user:secret@provider.example',
      'https://provider.example?token=secret',
      'http://provider.example'
    ]) {
      c.cloud.endpoint = endpoint
      expect(() => validateAIConfig(c)).toThrow()
    }
  })
})
