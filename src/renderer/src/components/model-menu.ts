import type { ModelInfo } from '../../../shared/ipc/contract'
import {
  ACP_PROVIDER_LABEL,
  GATEWAY_MODEL_PROVIDER,
  favoriteRouteKey,
  isAcpModelRoute,
  type ModelRoute,
} from '../../../shared/model-route'

export type ModelMenuEntry = {
  key: string
  label: string
  /** 行尾的弱化信息:上下文窗口。原来要悬停开第三层浮层才看得到。 */
  meta?: string
  info: ModelInfo
}

export type ModelMenuGroup = {
  type: 'group'
  label: string
  provider: string
  children: ModelMenuEntry[]
}

export type ModelMenuInput = {
  models: readonly ModelInfo[]
  favoriteModels: readonly ModelRoute[]
  providerLabels: Record<string, string>
  currentModel: { provider: string; id: string } | null
  /** 搜索词。非空时忽略收藏过滤和每组上限 —— 用户明确在找东西。 */
  query?: string
}

/** 每组在没配收藏时最多显示几个。registry 里的历史注册太多,全列会刷屏。 */
const FALLBACK_PER_PROVIDER = 8

function formatTokens(n?: number): string | undefined {
  if (!n) return undefined
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

function matches(model: ModelInfo, groupLabel: string, needle: string): boolean {
  const haystack = [model.id, model.name, model.provider, groupLabel]
    .filter((value): value is string => !!value)
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

function toEntry(model: ModelInfo, isAcpGroup: boolean): ModelMenuEntry {
  return {
    key: `${model.provider}::${model.id}`,
    // ACP 条目用 registry 给的展示名(Codex / Claude Agent),比 id 好认
    label: isAcpGroup ? (model.name ?? model.id) : model.id,
    meta: formatTokens(model.contextWindow),
    info: model,
  }
}

/**
 * 模型选择器的分组。
 *
 * 每条 provider 独立应用「模型切换列表」:选过的线路只显示明确选择的模型,还没选过的线路
 * 显示该组最新 8 个,避免一个 provider 的收藏把其他线路整组藏掉。
 *
 * 两个例外:搜索时和外部 agent 组,见下面。
 */
export function buildModelMenuGroups(input: ModelMenuInput): ModelMenuGroup[] {
  const needle = input.query?.trim().toLowerCase() ?? ''
  const searching = needle.length > 0
  const favSet = new Set(
    input.favoriteModels.map((route) => favoriteRouteKey(route.provider, route.model)),
  )
  const byProvider = new Map<string, ModelInfo[]>()
  for (const model of input.models) {
    const list = byProvider.get(model.provider) ?? []
    list.push(model)
    byProvider.set(model.provider, list)
  }
  return [...byProvider.entries()]
    .map(([provider, list]): ModelMenuGroup => {
      const isAcpGroup = isAcpModelRoute(provider)
      const label = isAcpGroup ? ACP_PROVIDER_LABEL : (input.providerLabels[provider] ?? provider)

      // 搜索时不过滤也不截断:用户明确在找东西,藏起来只会让他以为没有。
      if (searching) {
        return {
          type: 'group',
          label,
          provider,
          children: list.filter((m) => matches(m, label, needle)).map((m) => toEntry(m, isAcpGroup)),
        }
      }

      // 外部 agent 不参与收藏过滤:那套是给 registry 里成百上千个模型防刷屏用的,
      // ACP 一共就十来个,按它过滤会让整组消失 —— 用户配过收藏就再也看不到
      // Claude Code 和 Codex。
      if (isAcpGroup) {
        return { type: 'group', label, provider, children: list.map((m) => toEntry(m, true)) }
      }

      const providerFavorites = list.filter((model) =>
        favSet.has(favoriteRouteKey(model.provider, model.id)),
      )
      let shown = providerFavorites.length > 0
        ? providerFavorites
        : list.slice(-FALLBACK_PER_PROVIDER).reverse()
      // 当前在用的模型不在列表里也要能看见(否则不知道自己用的什么)
      if (input.currentModel && input.currentModel.provider === provider) {
        const current = list.find((model) => model.id === input.currentModel!.id)
        if (current && !shown.includes(current)) shown = [current, ...shown]
      }
      return { type: 'group', label, provider, children: shown.map((m) => toEntry(m, false)) }
    })
    .filter((group) => group.children.length > 0)
}

/** chip 上显示什么。原来是一串 `·` 拼接,越拼越长。 */
export type ModelChipView = {
  /** 主标题:agent 名或模型 id。 */
  name: string
  /** 副标题:外部 agent 实际在跑的模型,pi 会话没有。 */
  sub?: string
  /** 推理档,做成小徽标。 */
  badge?: string
}

export function buildModelChip(input: {
  currentModel: { provider: string; id: string } | null
  models: readonly ModelInfo[]
  backendModel: { id: string; name?: string } | null
  thinkingLabel: string
  thinkingEnabled: boolean
}): ModelChipView {
  const { currentModel } = input
  if (!currentModel) return { name: '默认模型' }
  const known = input.models.find(
    (model) => model.provider === currentModel.provider && model.id === currentModel.id,
  )
  const name = isAcpModelRoute(currentModel.provider)
    ? (known?.name ?? currentModel.id)
    : currentModel.id
  return {
    name,
    // 后端自己报的模型才显示。问模型本人不可信 —— 它只知道训练时的身份。
    sub: input.backendModel ? (input.backendModel.name ?? input.backendModel.id) : undefined,
    badge: input.thinkingEnabled ? input.thinkingLabel : undefined,
  }
}

/**
 * 按模型键的条目走哪几条线路，给悬浮信息用:「heilovehei → Cloudflare Agent(故障时按顺序切换)」。
 * 不是模型键 provider 的条目、或目录里没有它，返回 null(调用方照旧显示服务商和接入点)。
 */
export function modelRouteSummary(
  model: Pick<ModelInfo, 'provider' | 'id'>,
  gatewayModels: ReadonlyArray<{ key: string; routes: ReadonlyArray<{ display_name: string }> }>,
): string | null {
  if (model.provider !== GATEWAY_MODEL_PROVIDER) return null
  const entry = gatewayModels.find((item) => item.key === model.id)
  if (!entry || entry.routes.length === 0) return null
  const names = entry.routes.map((route) => route.display_name)
  return names.length > 1 ? `${names.join(' → ')}(故障时按顺序切换)` : names[0]
}
