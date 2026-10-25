import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_MODELS,
  DEEPSEEK_PROFILE_ID,
  migrateDeepSeekFavoriteModels,
} from './deepseek-profile'

describe('DeepSeek official profile preset', () => {
  it('uses the current official endpoint and V4 model ids', () => {
    expect(DEEPSEEK_PROFILE_ID).toBe('deepseek')
    expect(DEEPSEEK_OFFICIAL_MODELS).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })

  it('adds an existing cloud DeepSeek lane to a curated model switcher', () => {
    expect(
      migrateDeepSeekFavoriteModels({
        favoriteModels: 'openai::gpt-5.6-sol',
        legacyProvider: 'openai',
        enabledModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      }),
    ).toBe(
      'openai::gpt-5.6-sol, deepseek::deepseek-v4-flash, deepseek::deepseek-v4-pro',
    )
  })
})
