import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogCoordinator, type ModelCatalogDependencies } from './model-catalog'
import type { LlmProviderProfile } from '../shared/contracts'

const profile: LlmProviderProfile = {
  id: 'three-a-main',
  display_name: '3A API',
  api_type: 'openai-completions',
  models: ['gpt-5.6-sol', 'grok-4.6', 'broken-configured-model'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}

function dependencies(overrides: Partial<ModelCatalogDependencies> = {}): ModelCatalogDependencies {
  return {
    getConnection: () => ({ available: true, relay: 'https://relay.example', key: 'app-key' }),
    fetchCatalog: vi.fn(async () => ({ providers: [profile] })),
    createSessionToken: vi.fn(async () => ({ token: 'session', expires_at: 1, scope: 'llm:chat' })),
    createImageAgentToken: vi.fn(async () => ({ token: 'image', expires_at: 1, scope: 'imagegen:agent' })),
    listProfiles: vi.fn(async () => [profile]),
    createProfile: vi.fn(),
    updateProfile: vi.fn(async (_relay, _key, write) => ({ ...profile, ...write, has_key: true })),
    deleteProfile: vi.fn(),
    refreshProfileModels: vi.fn(async () => ({ ...profile, new_models: ['new-working-model'] })),
    probeModel: vi.fn(async (_relay, _token, _provider, model) => model !== 'broken-configured-model'),
    providerHealth: vi.fn(),
    projectModels: vi.fn(),
    loadCachedProfiles: vi.fn(() => []),
    saveCachedProfiles: vi.fn(),
    migrateOfficialDeepSeekFavorites: vi.fn(() => false),
    migrateDirectProviderRetirement: vi.fn(() => false),
    ...overrides,
  } as unknown as ModelCatalogDependencies
}

describe('configured provider models were not individually verified regression', () => {
  it('re-probes configured and newly discovered models, then keeps only successful routes', async () => {
    const deps = dependencies()
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).resolves.toMatchObject({
      verifiedModels: ['gpt-5.6-sol', 'grok-4.6', 'new-working-model'],
      rejectedModels: ['broken-configured-model'],
    })
    expect(deps.probeModel).toHaveBeenCalledTimes(4)
    expect(deps.probeModel).toHaveBeenCalledWith('https://relay.example', 'session', profile.id, 'gpt-5.6-sol')
    expect(deps.updateProfile).toHaveBeenLastCalledWith(
      'https://relay.example',
      'app-key',
      expect.objectContaining({ models: ['gpt-5.6-sol', 'grok-4.6', 'new-working-model'] }),
    )
  })

  it('restores the configured list when probing fails at the transport layer', async () => {
    const deps = dependencies({
      probeModel: vi.fn(async () => { throw new Error('relay timeout') }),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.verifyDiscoveredModels(profile.id)).rejects.toThrow('relay timeout')
    expect(deps.updateProfile).toHaveBeenLastCalledWith(
      'https://relay.example',
      'app-key',
      expect.objectContaining({ models: profile.models }),
    )
  })
})
