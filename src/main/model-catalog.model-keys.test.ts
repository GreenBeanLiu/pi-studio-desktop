import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogCoordinator, type ModelCatalogDependencies } from './model-catalog'
import { buildGatewayProviderConfigs, type GatewayModelEntry, type LlmProviderProfile } from './llm-gateway'

// T3.1:Pi 里多一个按模型键的 provider,旧的按线路 provider 留着给旧会话恢复。

const profile: LlmProviderProfile = {
  id: 'heilovehei',
  display_name: 'heilovehei',
  base_url: 'https://www.heilovehei.com/v1',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}
const gatewayModels: GatewayModelEntry[] = [
  { key: 'gpt-5.6-sol', metadata: {}, routes: [{ profile_id: 'heilovehei', display_name: 'heilovehei' }] },
  {
    key: 'deepseek-flash',
    metadata: {},
    routes: [
      { profile_id: 'deepseek', display_name: 'DeepSeek 官方' },
      { profile_id: 'cloudflare-agent', display_name: 'Cloudflare Agent' },
    ],
  },
]

function dependencies(overrides: Partial<ModelCatalogDependencies> = {}): ModelCatalogDependencies {
  return {
    getConnection: () => ({ available: true, relay: 'https://relay.example', key: 'app-key', error: null }),
    fetchCatalog: vi.fn(async () => ({ providers: [profile] })),
    fetchModels: vi.fn(async () => gatewayModels),
    createSessionToken: vi.fn(async () => ({ token: 'chat', expires_at: 1, scope: 'llm:chat' as const })),
    createImageAgentToken: vi.fn(async () => ({ token: 'image', expires_at: 1, scope: 'imagegen:agent' as const })),
    listProfiles: vi.fn(async () => [profile]),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    refreshProfileModels: vi.fn(),
    probeModel: vi.fn(),
    providerHealth: vi.fn(),
    projectModels: vi.fn(),
    loadCachedProfiles: vi.fn(() => []),
    saveCachedProfiles: vi.fn(),
    loadCachedModels: vi.fn(() => []),
    saveCachedModels: vi.fn(),
    migrateToModelKeys: vi.fn(() => false),
    migrateOfficialDeepSeekFavorites: vi.fn(() => false),
    migrateDirectProviderRetirement: vi.fn(() => false),
    ...overrides,
  } as unknown as ModelCatalogDependencies
}

describe('model-key provider in the Pi registry', () => {
  it('registers one model-key provider on the new endpoint and keeps the per-route ones', () => {
    const providers = buildGatewayProviderConfigs('https://relay.example/', [profile], gatewayModels)

    expect(Object.keys(providers)).toEqual(['pi-studio', 'heilovehei'])
    expect(providers['pi-studio']).toMatchObject({
      baseUrl: 'https://relay.example/llm/v1',
      apiKey: '$PI_STUDIO_LLM_KEY',
      api: 'openai-completions',
    })
    expect(providers['pi-studio'].models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'deepseek-flash'])
    expect(providers.heilovehei.baseUrl).toBe('https://relay.example/llm/v1/heilovehei')
  })

  it('fills a model key with no metadata from the same fallbacks (DeepSeek seed, name heuristic)', () => {
    const providers = buildGatewayProviderConfigs('https://relay.example', [], gatewayModels)
    const [gpt, flash] = providers['pi-studio'].models

    expect(gpt.reasoning).toBe(true)
    expect(flash).toMatchObject({ name: 'DeepSeek V4 Flash', reasoning: true })
    expect(flash.contextWindow).toBeGreaterThan(0)
  })

  it('registers no model-key provider when the gateway has no model keys', () => {
    expect(Object.keys(buildGatewayProviderConfigs('https://relay.example', [profile], []))).toEqual(['heilovehei'])
  })
})

describe('model catalog coordination with model keys', () => {
  it('projects and caches the model keys next to the profiles and migrates favorites once', async () => {
    const onChanged = vi.fn()
    const deps = dependencies({ migrateToModelKeys: vi.fn(() => true) })
    const catalog = new ModelCatalogCoordinator(deps, onChanged)

    await expect(catalog.sync()).resolves.toMatchObject({ profiles: [profile], models: gatewayModels })
    expect(deps.saveCachedModels).toHaveBeenCalledWith(gatewayModels)
    expect(deps.projectModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ gatewayProfiles: [profile], gatewayModels }),
    )
    expect(deps.migrateToModelKeys).toHaveBeenCalledWith(gatewayModels)
    expect(onChanged).toHaveBeenCalled()
  })

  it('falls back to the cached model keys when the gateway has no /llm/models yet', async () => {
    const deps = dependencies({
      fetchModels: vi.fn(async () => { throw new Error('HTTP 404') }),
      loadCachedModels: vi.fn(() => gatewayModels),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    const result = await catalog.sync()

    expect(result.models).toEqual(gatewayModels)
    expect(result.warning).toBeUndefined()
  })

  it('drops malformed cache entries, including old route::model keys', () => {
    const deps = dependencies({
      loadCachedModels: vi.fn(() => [
        ...gatewayModels,
        { key: 'heilovehei::gpt-5.6-sol', metadata: {}, routes: [{ profile_id: 'heilovehei', display_name: 'h' }] },
        { key: 'no-routes', metadata: {}, routes: [] },
        { nonsense: true },
      ] as unknown as GatewayModelEntry[]),
    })

    expect(new ModelCatalogCoordinator(deps).listCachedModels()).toEqual(gatewayModels)
  })
})

describe('model-key migration at startup (0.19.0 regression)', () => {
  // 0.19.0:搬迁只挂在 sync 上，而启动时带 onChanged 的协调器只调 loadProviderLabels —— 装上后收藏一直没搬。
  it('runs when the renderer first loads provider labels', async () => {
    const onChanged = vi.fn()
    const deps = dependencies({ migrateToModelKeys: vi.fn(() => true) })
    const catalog = new ModelCatalogCoordinator(deps, onChanged)

    await catalog.loadProviderLabels()

    expect(deps.fetchModels).toHaveBeenCalled()
    expect(deps.migrateToModelKeys).toHaveBeenCalledWith(gatewayModels)
    expect(onChanged).toHaveBeenCalled()
  })

  it('runs from the cached model keys when the cloud is not configured', async () => {
    const deps = dependencies({
      getConnection: () => ({ available: false, relay: '', key: '', error: 'offline' }),
      loadCachedProfiles: vi.fn(() => [profile]),
      loadCachedModels: vi.fn(() => gatewayModels),
    } as unknown as Partial<ModelCatalogDependencies>)
    const catalog = new ModelCatalogCoordinator(deps, vi.fn())

    await catalog.loadProviderLabels()

    expect(deps.migrateToModelKeys).toHaveBeenCalledWith(gatewayModels)
  })

  it('still returns labels when the model-key catalog cannot be fetched', async () => {
    const deps = dependencies({ fetchModels: vi.fn(async () => { throw new Error('HTTP 404') }) })
    const catalog = new ModelCatalogCoordinator(deps, vi.fn())

    await expect(catalog.loadProviderLabels()).resolves.toEqual({
      providerLabels: { heilovehei: 'heilovehei', 'pi-studio': '模型' },
    })
    expect(deps.migrateToModelKeys).not.toHaveBeenCalled()
  })
})
