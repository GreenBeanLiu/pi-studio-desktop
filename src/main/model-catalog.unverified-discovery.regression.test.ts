import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogCoordinator, type ModelCatalogDependencies } from './model-catalog'
import type { LlmProviderProfile, LlmProfileWrite } from './llm-gateway'

const profile: LlmProviderProfile = {
  id: 'three-a-main',
  display_name: '3A API',
  base_url: 'https://api.3a-api.com/v1',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}

function dependencies(overrides: Partial<ModelCatalogDependencies> = {}): ModelCatalogDependencies {
  return {
    getConnection: () => ({
      available: true,
      relay: 'https://relay.example',
      key: 'desktop-key',
      error: null,
    }),
    fetchCatalog: vi.fn(async () => ({ providers: [profile] })),
    createSessionToken: vi.fn(async () => ({
      token: 'chat-token', expires_at: 4_000_000_000, scope: 'llm:chat' as const,
    })),
    createImageAgentToken: vi.fn(async () => ({
      token: 'image-token', expires_at: 4_000_000_000, scope: 'imagegen:agent' as const,
    })),
    listProfiles: vi.fn(async () => [profile]),
    createProfile: vi.fn(async (_relay, _key, value: LlmProfileWrite) => ({ ...profile, ...value })),
    updateProfile: vi.fn(async (_relay, _key, value: LlmProfileWrite) => ({ ...profile, ...value })),
    deleteProfile: vi.fn(async () => undefined),
    refreshProfileModels: vi.fn(async () => ({ ...profile, new_models: ['gpt-6.1-sol'] })),
    probeModel: vi.fn(async (_relay, _token, _provider, model) => model !== 'gpt-6.1-sol'),
    providerHealth: vi.fn(),
    projectModels: vi.fn(),
    loadCachedProfiles: vi.fn(() => []),
    saveCachedProfiles: vi.fn(),
    migrateOfficialDeepSeekFavorites: vi.fn(() => false),
    migrateDirectProviderRetirement: vi.fn(() => false),
    ...overrides,
  }
}

describe('unverified upstream model discovery regression', () => {
  it('rolls back a discovered model when the real chat probe rejects it', async () => {
    const onChanged = vi.fn()
    const deps = dependencies()
    const catalog = new ModelCatalogCoordinator(deps, onChanged)

    await expect(catalog.verifyDiscoveredModels(profile.id)).resolves.toEqual({
      verifiedModels: ['gpt-5.6-sol'],
      rejectedModels: ['gpt-6.1-sol'],
    })

    expect(deps.updateProfile).toHaveBeenNthCalledWith(1, 'https://relay.example', 'desktop-key', {
      id: profile.id,
      display_name: profile.display_name,
      base_url: profile.base_url,
      api_type: profile.api_type,
      api_key: '',
      models: ['gpt-5.6-sol', 'gpt-6.1-sol'],
      enabled: profile.enabled,
      sort_order: profile.sort_order,
    })
    expect(deps.updateProfile).toHaveBeenNthCalledWith(2, 'https://relay.example', 'desktop-key', {
      id: profile.id,
      display_name: profile.display_name,
      base_url: profile.base_url,
      api_type: profile.api_type,
      api_key: '',
      models: ['gpt-5.6-sol'],
      enabled: profile.enabled,
      sort_order: profile.sort_order,
    })
    expect(deps.projectModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ gatewayProfiles: [profile] }),
    )
    expect(onChanged).toHaveBeenCalledOnce()
  })
})
