import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../../../shared/ipc/contract'
import { ACP_PROVIDER_LABEL } from '../../../shared/model-route'
import { buildModelChip, buildModelMenuGroups, servedByLabel, type ModelMenuInput } from './model-menu'

function model(provider: string, id: string, name?: string, contextWindow = 0): ModelInfo {
  return { provider, id, name, contextWindow, reasoning: false }
}

function build(overrides: Partial<ModelMenuInput> = {}) {
  return buildModelMenuGroups({
    models: [],
    favoriteModels: [],
    providerLabels: {},
    currentModel: null,
    ...overrides,
  })
}

const CODEX = model('acp', 'codex-acp', 'Codex')
const CLAUDE = model('acp', 'claude-acp', 'Claude Agent')
const DS_CHAT = model('deepseek', 'deepseek-chat', undefined, 64000)
const DS_PRO = model('deepseek', 'deepseek-v4-pro')

describe('provider grouping', () => {
  it('groups by provider and uses the configured label', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO],
      providerLabels: { deepseek: 'DeepSeek 官方' },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ provider: 'deepseek', label: 'DeepSeek 官方' })
    expect(groups[0]?.children.map((c) => c.key)).toEqual([
      'deepseek::deepseek-v4-pro',
      'deepseek::deepseek-chat',
    ])
  })

  it('falls back to the provider id when there is no label', () => {
    expect(build({ models: [DS_CHAT] })[0]?.label).toBe('deepseek')
  })

  it('filters each provider independently and keeps unconfigured providers visible', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO, model('heilovehei', 'gpt-5.6-sol')],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
    expect(groups.find((group) => group.provider === 'deepseek')?.children.map((c) => c.info.id))
      .toEqual(['deepseek-chat'])
    expect(groups.find((group) => group.provider === 'heilovehei')?.children.map((c) => c.info.id))
      .toEqual(['gpt-5.6-sol'])
  })

  it('keeps the model in use visible even when it is not a favourite', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      currentModel: { provider: 'deepseek', id: 'deepseek-v4-pro' },
    })
    expect(groups[0]?.children.map((c) => c.info.id)).toEqual(['deepseek-v4-pro', 'deepseek-chat'])
  })

  it('uses a small fallback for a provider with no selected models', () => {
    const groups = build({
      models: [DS_CHAT, CODEX],
      favoriteModels: [{ provider: 'acp', model: 'codex-acp' }],
    })
    expect(groups.map((g) => g.provider)).toEqual(['deepseek', 'acp'])
  })
})

// 收藏过滤是给 registry 里成百上千个模型防刷屏用的。ACP 一共十来个,
// 按它过滤会让整组消失 —— 用户配过收藏就再也看不到 Claude Code 和 Codex。
describe('the ACP group is exempt from favourite filtering', () => {
  it('stays fully visible when favourites are configured elsewhere', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO, CODEX, CLAUDE],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
    const acp = groups.find((g) => g.provider === 'acp')
    expect(acp?.children.map((c) => c.info.id)).toEqual(['codex-acp', 'claude-acp'])
  })

  it('is not capped at the per-provider fallback limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => model('acp', `agent-${i}`, `Agent ${i}`))
    expect(build({ models: many })[0]?.children).toHaveLength(12)
  })

  it('gets its own label instead of the bare provider id', () => {
    expect(build({ models: [CODEX] })[0]?.label).toBe(ACP_PROVIDER_LABEL)
  })

  // id 是 codex-acp / claude-acp,registry 给的展示名才是 Codex / Claude Agent
  it('shows the registry display name, not the agent id', () => {
    expect(build({ models: [CODEX, CLAUDE] })[0]?.children.map((c) => c.label)).toEqual([
      'Codex',
      'Claude Agent',
    ])
  })

  it('falls back to the id when the registry gave no name', () => {
    expect(build({ models: [model('acp', 'nameless')] })[0]?.children[0]?.label).toBe('nameless')
  })

  it('still keys entries as provider::id so pickModel can parse them', () => {
    expect(build({ models: [CODEX] })[0]?.children[0]?.key).toBe('acp::codex-acp')
  })
})

// 原来 23 个外部 agent 加上网关的模型只能滚,没有搜索。
describe('搜索', () => {
  const all = [DS_CHAT, DS_PRO, CODEX, CLAUDE]

  it('跨分组按名字和 id 匹配', () => {
    expect(build({ models: all, query: 'codex' })[0]?.children.map((c) => c.info.id)).toEqual([
      'codex-acp',
    ])
    expect(build({ models: all, query: 'deepseek' }).flatMap((g) => g.children).length).toBe(2)
  })

  it('匹配 registry 给的展示名,不只是 id', () => {
    // id 是 claude-acp,展示名是 Claude Agent
    expect(build({ models: all, query: 'claude a' })[0]?.children.map((c) => c.info.id)).toEqual([
      'claude-acp',
    ])
  })

  // 组名也进匹配:搜「外部」应该把整组捞出来,而不是要求你记得 agent 的 id。
  it('按组名搜会命中整组', () => {
    expect(build({ models: all, query: '外部' })[0]?.children.map((c) => c.info.id)).toEqual([
      'codex-acp',
      'claude-acp',
    ])
  })

  it('也能按分组名找', () => {
    const groups = build({ models: all, providerLabels: { deepseek: 'DeepSeek 官方' }, query: '官方' })
    expect(groups.flatMap((g) => g.children).length).toBe(2)
  })

  // 用户明确在找东西,收藏过滤和每组上限都不该再挡着。
  it('搜索时忽略收藏过滤', () => {
    const groups = build({
      models: all,
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      query: 'v4-pro',
    })
    expect(groups.flatMap((g) => g.children).map((c) => c.info.id)).toEqual(['deepseek-v4-pro'])
  })

  it('搜索时不截断每组上限', () => {
    const many = Array.from({ length: 12 }, (_, i) => model('deepseek', `m-${i}`))
    expect(build({ models: many, query: 'm-' })[0]?.children).toHaveLength(12)
  })

  it('没匹配上就没有分组,而不是空壳', () => {
    expect(build({ models: all, query: 'zzz' })).toEqual([])
  })

  it('空搜索词退回正常分组', () => {
    expect(build({ models: all, query: '   ' }).length).toBe(build({ models: all }).length)
  })
})

// 上下文窗口原来要悬停开第三层浮层才看得到。
describe('行尾的规格', () => {
  it('把上下文窗口按 K 显示在行尾', () => {
    expect(build({ models: [DS_CHAT] })[0]?.children[0]?.meta).toBe('64K')
  })

  it('外部 agent 没有上下文窗口就不显示', () => {
    expect(build({ models: [CODEX] })[0]?.children[0]?.meta).toBeUndefined()
  })
})

// chip 原来是 `codex-acp · GPT-5.6-Sol (medium) · 推理:高` 一路 · 拼下去,越拼越长。
describe('buildModelChip', () => {
  const base = { models: [CODEX], backendModel: null, thinkingLabel: '高', thinkingEnabled: true }

  it('外部 agent 用展示名而不是 id', () => {
    expect(buildModelChip({ ...base, currentModel: { provider: 'acp', id: 'codex-acp' } }).name).toBe(
      'Codex',
    )
  })

  it('后端报的模型作副标题', () => {
    const chip = buildModelChip({
      ...base,
      currentModel: { provider: 'acp', id: 'codex-acp' },
      backendModel: { id: 'gpt-5.6-sol[medium]', name: 'GPT-5.6-Sol (medium)' },
    })
    expect(chip.sub).toBe('GPT-5.6-Sol (medium)')
  })

  // Claude 不上报 models,那就不显示 —— 不能因为拿不到就编一个。
  it('后端不报模型时不显示副标题', () => {
    expect(buildModelChip({ ...base, currentModel: { provider: 'acp', id: 'claude-acp' } }).sub)
      .toBeUndefined()
  })

  it('推理关闭时不显示徽标', () => {
    const chip = buildModelChip({
      ...base,
      currentModel: { provider: 'deepseek', id: 'deepseek-chat' },
      thinkingEnabled: false,
    })
    expect(chip.badge).toBeUndefined()
  })

  it('没有当前模型时显示占位', () => {
    expect(buildModelChip({ ...base, currentModel: null }).name).toBe('默认模型')
  })

  it('pi 的模型直接用 id', () => {
    expect(
      buildModelChip({ ...base, models: [DS_CHAT], currentModel: { provider: 'deepseek', id: 'deepseek-chat' } }).name,
    ).toBe('deepseek-chat')
  })
})

describe('servedByLabel', () => {
  const gateway = [
    { routes: [{ profile_id: 'deepseek', display_name: 'DeepSeek 官方' }, { profile_id: 'cf', display_name: 'Cloudflare Agent' }] },
  ]
  const current = { provider: 'pi-studio', id: 'deepseek-flash' }
  const served = { provider: 'pi-studio', modelId: 'deepseek-flash', profileId: 'cf' }

  it('names the route by its display name', () => {
    expect(servedByLabel(served, current, gateway)).toBe('最近由 Cloudflare Agent 回复')
  })

  it('falls back to the route id and shows an aliased upstream model', () => {
    expect(servedByLabel({ ...served, profileId: 'unknown', upstreamModel: 'deepseek-v4-flash' }, current, gateway)).toBe(
      '最近由 unknown(上游 deepseek-v4-flash) 回复',
    )
    expect(servedByLabel({ ...served, upstreamModel: 'deepseek-flash' }, current, gateway)).toBe('最近由 Cloudflare Agent 回复')
  })

  it('hides a record taken under another model', () => {
    expect(servedByLabel(served, { provider: 'pi-studio', id: 'gpt-6-sol' }, gateway)).toBeNull()
    expect(servedByLabel(null, current, gateway)).toBeNull()
    expect(servedByLabel(served, null, gateway)).toBeNull()
  })
})

describe('served-by route only (tooltip row already labelled)', () => {
  it('returns the route name without the sentence around it', async () => {
    const { servedByRoute, servedByLabel } = await import('./model-menu')
    const servedBy = { provider: 'pi-studio', modelId: 'gpt-6-sol', profileId: 'heilovehei' }
    const current = { provider: 'pi-studio', id: 'gpt-6-sol' }
    const keys = [{ routes: [{ profile_id: 'heilovehei', display_name: 'heilovehei' }] }]
    expect(servedByRoute(servedBy, current, keys)).toBe('heilovehei')
    expect(servedByLabel(servedBy, current, keys)).toBe('最近由 heilovehei 回复')
    expect(servedByRoute(servedBy, { provider: 'pi-studio', id: 'other' }, keys)).toBeNull()
  })
})
