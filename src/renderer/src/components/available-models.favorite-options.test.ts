import { describe, expect, it } from 'vitest'
import { buildFavoriteModelOptions } from './available-models'

const entry = (key: string) => ({ key, metadata: {}, routes: [{ profile_id: 'deepseek', display_name: 'DeepSeek 官方' }] })

describe('buildFavoriteModelOptions', () => {
  it('offers the gateway model keys under the pi-studio provider', () => {
    expect(buildFavoriteModelOptions([entry('deepseek-flash'), entry('gpt-6-sol')], [])).toEqual([
      { value: 'pi-studio::deepseek-flash', label: 'deepseek-flash' },
      { value: 'pi-studio::gpt-6-sol', label: 'gpt-6-sol' },
    ])
  })

  it('keeps unmapped legacy favorites visible so they can still be removed', () => {
    expect(
      buildFavoriteModelOptions([entry('deepseek-flash')], ['pi-studio::deepseek-flash', 'three-a-main::grok-4.6']),
    ).toEqual([
      { value: 'pi-studio::deepseek-flash', label: 'deepseek-flash' },
      { value: 'three-a-main::grok-4.6', label: 'three-a-main::grok-4.6(未登记，切换器里不显示)' },
    ])
  })
})
