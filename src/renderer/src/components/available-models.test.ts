import { describe, expect, it } from 'vitest'
import { buildAvailableModelRoutes } from './available-models'
import type { LlmProviderProfile } from '../../../shared/contracts'

const profile = (overrides: Partial<LlmProviderProfile>): LlmProviderProfile => ({
  id: 'three-a-main',
  display_name: '3A API',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol'],
  enabled: true,
  sort_order: 0,
  has_key: true,
  ...overrides,
})

describe('available model routes', () => {
  it('combines configured models with upstream discoveries and keeps provider identity', () => {
    expect(buildAvailableModelRoutes(
      [profile({}), profile({ id: 'disabled', enabled: false, models: ['hidden'] })],
      ['three-a-main::gpt-6.1-sol', 'other-provider::gpt-6.1-sol'],
    )).toEqual([
      'three-a-main::gpt-5.6-sol',
      'three-a-main::gpt-6.1-sol',
      'other-provider::gpt-6.1-sol',
    ])
  })

  it('deduplicates discoveries already present in a provider configuration', () => {
    expect(buildAvailableModelRoutes(
      [profile({ models: ['gpt-6.1-sol'] })],
      ['three-a-main::gpt-6.1-sol'],
    )).toEqual(['three-a-main::gpt-6.1-sol'])
  })
})
