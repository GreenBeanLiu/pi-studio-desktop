import { describe, expect, it } from 'vitest'
import type { GatewayModelEntry, LlmProviderProfile } from '../../../shared/contracts'
import { mergeAvailableModelInfo } from './available-models'
import { modelRouteSummary } from './model-menu'

const legacy: LlmProviderProfile = {
  id: 'three-a-main',
  display_name: '3A API',
  api_type: 'openai-completions',
  models: ['grok-4.6'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}
const keys: GatewayModelEntry[] = [
  {
    key: 'deepseek-flash',
    metadata: { contextWindow: 1_000_000, reasoning: true },
    routes: [
      { profile_id: 'deepseek', display_name: 'DeepSeek 官方' },
      { profile_id: 'cloudflare-agent', display_name: 'Cloudflare Agent' },
    ],
  },
  { key: 'gpt-5.6-sol', metadata: {}, routes: [{ profile_id: 'heilovehei', display_name: 'heilovehei' }] },
]

describe('switcher fill-in once the gateway has model keys', () => {
  it('fills model-key entries and never brings the hidden per-route groups back', () => {
    const models = mergeAvailableModelInfo([], [legacy], keys)

    expect(models.map((model) => `${model.provider}::${model.id}`)).toEqual([
      'pi-studio::deepseek-flash',
      'pi-studio::gpt-5.6-sol',
    ])
    expect(models[0]).toMatchObject({ contextWindow: 1_000_000, reasoning: true })
  })

  it('still fills from route profiles when there are no model keys', () => {
    expect(mergeAvailableModelInfo([], [legacy]).map((model) => model.provider)).toEqual(['three-a-main'])
  })
})

describe('route summary in the model tooltip', () => {
  it('lists the registered routes in failover order for a model key', () => {
    expect(modelRouteSummary({ provider: 'pi-studio', id: 'deepseek-flash' }, keys)).toBe(
      'DeepSeek 官方 → Cloudflare Agent(故障时按顺序切换)',
    )
    expect(modelRouteSummary({ provider: 'pi-studio', id: 'gpt-5.6-sol' }, keys)).toBe('heilovehei')
  })

  it('is empty for per-route entries and unknown keys', () => {
    expect(modelRouteSummary({ provider: 'three-a-main', id: 'grok-4.6' }, keys)).toBeNull()
    expect(modelRouteSummary({ provider: 'pi-studio', id: 'retired' }, keys)).toBeNull()
  })
})

describe('model-key group in the switcher', () => {
  it('lists every registered key with favorites first instead of filtering to favorites', async () => {
    const { buildModelMenuGroups } = await import('./model-menu')
    const models = ['deepseek-flash', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({
      provider: 'pi-studio',
      id,
      contextWindow: 0,
      reasoning: false,
    }))

    const [group] = buildModelMenuGroups({
      models,
      favoriteModels: [
        { provider: 'pi-studio', model: 'gpt-5.6-sol' },
        { provider: 'pi-studio', model: 'deepseek-flash' },
      ],
      providerLabels: { 'pi-studio': '模型' },
      currentModel: null,
      query: '',
    })

    expect(group.label).toBe('模型')
    expect(group.children.map((entry) => entry.label)).toEqual([
      'deepseek-flash',
      'gpt-5.6-sol',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ])
  })
})
