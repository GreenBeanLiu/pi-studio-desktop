import { describe, expect, it } from 'vitest'
import {
  GATEWAY_MODEL_PROVIDER,
  mapRouteToModelKey,
  selectRuntimeModelRoute,
  visibleSwitcherModels,
} from './model-route'
import { migrateRoutesToModelKeys } from './model-key-migration'

// 生产登记表 2026-10-24 的形状(节选)
const models = [
  { key: 'gpt-5.6-sol', routes: [{ profile_id: 'heilovehei' }] },
  { key: 'deepseek-flash', routes: [{ profile_id: 'deepseek' }, { profile_id: 'cloudflare-agent' }] },
  { key: 'deepseek-v4-pro', routes: [{ profile_id: 'deepseek' }, { profile_id: 'cloudflare-agent' }] },
]
const legacyProfiles = [
  { id: 'heilovehei', models: ['gpt-5.6-sol'] },
  { id: 'three-a-main', models: ['gpt-5.6-sol', 'grok-4.6'] },
  { id: 'deepseek', models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'] },
]
const key = (model: string) => ({ provider: GATEWAY_MODEL_PROVIDER, model })

describe('mapping a legacy route to a model key', () => {
  it('prefers the key the route is registered under', () => {
    expect(mapRouteToModelKey({ provider: 'heilovehei', model: 'gpt-5.6-sol' }, models)).toBe('gpt-5.6-sol')
  })

  it('follows DeepSeek aliases to the current name', () => {
    expect(mapRouteToModelKey({ provider: 'deepseek', model: 'deepseek-v4-flash' }, models)).toBe('deepseek-flash')
  })

  it('maps a same-name favorite on an unregistered route to the key (the user wants that model)', () => {
    expect(mapRouteToModelKey({ provider: 'three-a-main', model: 'gpt-5.6-sol' }, models)).toBe('gpt-5.6-sol')
  })

  it('leaves unregistered models and ACP agents unmapped', () => {
    expect(mapRouteToModelKey({ provider: 'three-a-main', model: 'grok-4.6' }, models)).toBeNull()
    expect(mapRouteToModelKey({ provider: 'acp', model: 'claude-code' }, models)).toBeNull()
  })

  it('keeps a model-key route only while the key still exists', () => {
    expect(mapRouteToModelKey(key('gpt-5.6-sol'), models)).toBe('gpt-5.6-sol')
    expect(mapRouteToModelKey(key('retired'), models)).toBeNull()
  })
})

describe('choosing the runtime model once the gateway has model keys', () => {
  it('moves a legacy selection onto its model key', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'three-a-main', model: 'gpt-5.6-sol' },
        gatewayProfiles: legacyProfiles,
        gatewayModels: models,
      }),
    ).toEqual(key('gpt-5.6-sol'))
  })

  it('respects an unmapped legacy selection that is still on offer', () => {
    const grok = { provider: 'three-a-main', model: 'grok-4.6' }
    expect(selectRuntimeModelRoute({ selected: grok, gatewayProfiles: legacyProfiles, gatewayModels: models })).toEqual(grok)
  })

  it('defaults to the key the old default route maps to, else the first key', () => {
    expect(selectRuntimeModelRoute({ selected: null, gatewayProfiles: [], gatewayModels: models })).toEqual(key('gpt-5.6-sol'))
    expect(
      selectRuntimeModelRoute({ selected: null, gatewayProfiles: [], gatewayModels: models.slice(1) }),
    ).toEqual(key('deepseek-flash'))
  })

  it('keeps the old per-route behaviour when the gateway has no model keys', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'heilovehei', model: 'gpt-5.6-sol' },
        gatewayProfiles: legacyProfiles,
        gatewayModels: [],
      }),
    ).toEqual({ provider: 'heilovehei', model: 'gpt-5.6-sol' })
  })
})

describe('migrating favorites to model keys', () => {
  it('maps, de-duplicates, keeps ACP and keeps what it cannot map', () => {
    const result = migrateRoutesToModelKeys({
      favoriteModels:
        'heilovehei::gpt-5.6-sol, three-a-main::gpt-5.6-sol, deepseek::deepseek-v4-flash, deepseek::deepseek-flash, three-a-main::grok-4.6, acp::claude-code',
      legacyProvider: 'openai',
      selected: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      models,
    })

    expect(result.favoriteModels).toBe(
      'pi-studio::gpt-5.6-sol, pi-studio::deepseek-flash, three-a-main::grok-4.6, acp::claude-code',
    )
    expect(result.selected).toEqual(key('deepseek-flash'))
    expect(result.unmapped).toEqual([{ provider: 'three-a-main', model: 'grok-4.6' }])
  })
})

describe('what the switcher shows', () => {
  const runtime = [
    { provider: 'pi-studio', id: 'gpt-5.6-sol' },
    { provider: 'heilovehei', id: 'gpt-5.6-sol' },
    { provider: 'three-a-main', id: 'grok-4.6' },
    { provider: 'acp', id: 'claude-code' },
  ]

  it('hides the legacy per-route groups once model keys exist', () => {
    expect(visibleSwitcherModels(runtime, { provider: 'pi-studio', id: 'gpt-5.6-sol' })).toEqual([
      { provider: 'pi-studio', id: 'gpt-5.6-sol' },
      { provider: 'acp', id: 'claude-code' },
    ])
  })

  it('still shows the legacy model the current session is using', () => {
    const shown = visibleSwitcherModels(runtime, { provider: 'three-a-main', id: 'grok-4.6' })
    expect(shown).toContainEqual({ provider: 'three-a-main', id: 'grok-4.6' })
    expect(shown).not.toContainEqual({ provider: 'heilovehei', id: 'gpt-5.6-sol' })
  })

  it('lists everything when the gateway has no model keys yet', () => {
    const legacyOnly = runtime.filter((model) => model.provider !== 'pi-studio')
    expect(visibleSwitcherModels(legacyOnly, null)).toEqual(legacyOnly)
  })
})
