import { describe, expect, it } from 'vitest'
import type { LlmProviderProfile } from '../../../shared/contracts'
import type { ModelInfo } from '../../../shared/ipc/contract'
import { mergeAvailableModelInfo } from './available-models'

const profile: LlmProviderProfile = {
  id: 'heilovehei',
  display_name: 'Heilovehei',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol'],
  model_metadata: { 'gpt-5.6-sol': { name: 'GPT-5.6 Sol', reasoning: true, contextWindow: 128000 } },
  enabled: true,
  sort_order: 0,
  has_key: true,
  unavailable_models: ['broken-model'],
  new_models: ['unverified-model'],
}

const runtimeModel = (id: string): ModelInfo => ({
  provider: 'heilovehei',
  id,
  contextWindow: 64000,
  reasoning: false,
})

describe('stale runtime model list regression', () => {
  it('adds configured provider models missing from runtime and excludes unavailable routes', () => {
    const models = mergeAvailableModelInfo(
      [runtimeModel('broken-model')],
      [profile],
    )

    expect(models).toEqual([
      expect.objectContaining({
        provider: 'heilovehei',
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 128000,
        reasoning: true,
      }),
    ])
  })
})
