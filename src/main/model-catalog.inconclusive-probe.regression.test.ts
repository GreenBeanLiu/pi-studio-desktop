import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogCoordinator, type ModelCatalogDependencies } from './model-catalog'
import type { LlmModelProbeResult, LlmProviderProfile } from './llm-gateway'

// 回归:0.18.6 把探测失败(任何非 2xx)一律当成模型坏了，并用通过的列表覆盖线路。
// key 过期时所有模型 401 → 线路被写成 models: [];一次 429 就能永久删掉一个模型。

const profile: LlmProviderProfile = {
  id: 'three-a-main',
  display_name: '3A API',
  base_url: 'https://api.3a-api.com/v1',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol', 'grok-4.6', 'o-reasoner'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}

function dependencies(
  probe: (model: string) => Promise<LlmModelProbeResult>,
  newModels: string[] = ['gpt-6.1-sol'],
): ModelCatalogDependencies {
  return {
    getConnection: () => ({ available: true, relay: 'https://relay.example', key: 'app-key' }),
    fetchCatalog: vi.fn(async () => ({ providers: [profile] })),
    createSessionToken: vi.fn(async () => ({ token: 'session', expires_at: 1, scope: 'llm:chat' })),
    createImageAgentToken: vi.fn(async () => ({ token: 'image', expires_at: 1, scope: 'imagegen:agent' })),
    listProfiles: vi.fn(async () => [profile]),
    createProfile: vi.fn(),
    updateProfile: vi.fn(async (_relay, _key, write) => ({ ...profile, ...write, has_key: true })),
    deleteProfile: vi.fn(),
    refreshProfileModels: vi.fn(async () => ({ ...profile, new_models: newModels })),
    probeModel: vi.fn(async (_relay, _token, _provider, model: string) => probe(model)),
    providerHealth: vi.fn(),
    projectModels: vi.fn(),
    loadCachedProfiles: vi.fn(() => []),
    saveCachedProfiles: vi.fn(),
    migrateOfficialDeepSeekFavorites: vi.fn(() => false),
    migrateDirectProviderRetirement: vi.fn(() => false),
  } as unknown as ModelCatalogDependencies
}

function lastWrittenModels(deps: ModelCatalogDependencies): string[] {
  const calls = vi.mocked(deps.updateProfile).mock.calls
  return calls[calls.length - 1][2].models
}

describe('inconclusive model probes must not delete configured models regression', () => {
  it('keeps every configured model when the upstream key is rejected for all of them', async () => {
    const deps = dependencies(async () => 'inconclusive')
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).resolves.toMatchObject({
      models: profile.models,
      verifiedModels: [],
      rejectedModels: [],
      unverifiedModels: [...profile.models, 'gpt-6.1-sol'],
    })
    // 新发现的模型没测通，不加入;已配置的一个都不能少。
    expect(lastWrittenModels(deps)).toEqual(profile.models)
  })

  it('removes only the model the upstream explicitly says does not exist', async () => {
    const deps = dependencies(async (model) => {
      if (model === 'grok-4.6') return 'inconclusive' // e.g. 429 / 5xx / max_tokens rejected
      if (model === 'o-reasoner') return 'missing'
      return 'ok'
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).resolves.toMatchObject({
      models: ['gpt-5.6-sol', 'grok-4.6', 'gpt-6.1-sol'],
      rejectedModels: ['o-reasoner'],
      unverifiedModels: ['grok-4.6'],
    })
    expect(lastWrittenModels(deps)).toEqual(['gpt-5.6-sol', 'grok-4.6', 'gpt-6.1-sol'])
  })

  it('treats "every model is missing" as a broken route and restores the configured list', async () => {
    const deps = dependencies(async () => 'missing')
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).rejects.toThrow('疑似线路配置有误')
    expect(lastWrittenModels(deps)).toEqual(profile.models)
    expect(deps.projectModels).not.toHaveBeenCalled()
  })

  it('keeps the original error visible when restoring the list also fails', async () => {
    const deps = dependencies(async () => { throw new Error('relay unreachable') }, [])
    vi.mocked(deps.updateProfile).mockRejectedValue(new Error('HTTP 502'))
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).rejects.toThrow(
      /relay unreachable.*恢复原模型列表也失败了.*HTTP 502/,
    )
  })
})
