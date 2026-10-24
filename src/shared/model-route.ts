import { DEFAULT_MODEL_ROUTE } from './agent-defaults'
import { deepSeekCanonicalModel } from './gateway-model'

/**
 * 外部 ACP agent(Claude Code / Codex 等)在模型选择器里共用的 provider。
 *
 * 放在 shared 是因为 main 要用它投影目录、renderer 要用它把这一组单独对待:
 * ACP 是一小撮外部 agent,不该被「模型切换列表」那套收藏过滤掉。
 */
export const ACP_MODEL_PROVIDER = 'acp'

/** 这一组在界面上的名字。providerLabels 来自网关 profile,不会有 acp。 */
export const ACP_PROVIDER_LABEL = '外部 Agent (ACP)'

/**
 * 按模型键注册的那一个 provider(T3.1):请求打网关的 `/llm/v1/chat/completions`,线路由网关选。
 * 旧的按线路 provider 仍然注册(旧会话要能恢复),但不在选择器里出现。
 */
export const GATEWAY_MODEL_PROVIDER = 'pi-studio'
export const GATEWAY_MODEL_PROVIDER_LABEL = '模型'

export function isAcpModelRoute(provider: string): boolean {
  return provider === ACP_MODEL_PROVIDER
}

export type ModelRoute = {
  provider: string
  model: string
}

type ModelKeyEntry = { key: string; routes: Array<{ profile_id: string }> }

export type RuntimeModelRouteInput = {
  selected: ModelRoute | null
  gatewayProfiles: Array<{ id: string; models: string[] }>
  /** 网关 /llm/models 的模型键。为空(老网关、没登记)时退回旧的按线路选法。 */
  gatewayModels?: ModelKeyEntry[]
}

/**
 * 旧的 `线路::模型` 对应哪个模型键(T3.2,docs/model-routing-todo.md 里定稿的规则),依次:
 * ① 键名和模型名相同、且这条线路登记在这个键下;② 模型名是某个键的 DeepSeek 别名;
 * ③ 键名和模型名相同(登记在别的线路上 —— 收藏表达的是「要这个模型」)。都不中返回 null。
 * 已经是模型键 provider 或 ACP 的路由原样返回(或 null:键已不存在)。
 */
export function mapRouteToModelKey(route: ModelRoute, models: ModelKeyEntry[]): string | null {
  const byKey = new Map(models.map((entry) => [entry.key, entry]))
  if (route.provider === GATEWAY_MODEL_PROVIDER) return byKey.has(route.model) ? route.model : null
  if (isAcpModelRoute(route.provider)) return null
  const exact = byKey.get(route.model)
  if (exact?.routes.some((item) => item.profile_id === route.provider)) return exact.key
  const canonical = deepSeekCanonicalModel(route.model)
  if (canonical && canonical !== route.model && byKey.has(canonical)) return canonical
  return exact ? exact.key : null
}

export function favoriteRouteKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`.toLowerCase()
}

export function parseFavoriteModelRoutes(value: string, legacyProvider: string): ModelRoute[] {
  const routes: ModelRoute[] = []
  const seen = new Set<string>()
  for (const token of value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)) {
    const separator = token.indexOf('::')
    const provider = separator > 0 ? token.slice(0, separator).trim() : legacyProvider.trim()
    const model = separator > 0 ? token.slice(separator + 2).trim() : token
    if (!provider || !model) continue
    const key = favoriteRouteKey(provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider, model })
  }
  return routes
}

export function formatFavoriteModelRoutes(routes: ModelRoute[]): string {
  return routes.map((route) => `${route.provider}::${route.model}`).join(', ')
}

export function selectRuntimeModelRoute(input: RuntimeModelRouteInput): ModelRoute | null {
  const models = input.gatewayModels ?? []
  if (models.length > 0) {
    if (input.selected) {
      const key = mapRouteToModelKey(input.selected, models)
      if (key) return { provider: GATEWAY_MODEL_PROVIDER, model: key }
      // 映射不到但旧线路还在(比如没登记的 3A grok):尊重用户的选择，照旧走旧入口。
      const legacyOnOffer = input.gatewayProfiles.some(
        (profile) => profile.id === input.selected?.provider && profile.models.includes(input.selected.model),
      )
      if (legacyOnOffer) return input.selected
    }
    const defaultKey = mapRouteToModelKey({ ...DEFAULT_MODEL_ROUTE }, models)
    return { provider: GATEWAY_MODEL_PROVIDER, model: defaultKey ?? models[0].key }
  }

  if (input.selected) {
    const stillOnOffer = input.gatewayProfiles.some(
      (profile) =>
        profile.id === input.selected?.provider && profile.models.includes(input.selected.model),
    )
    if (stillOnOffer) return input.selected
  }

  const defaultProfile = input.gatewayProfiles.find(
    (profile) => profile.id === DEFAULT_MODEL_ROUTE.provider,
  )
  if (defaultProfile?.models.includes(DEFAULT_MODEL_ROUTE.model)) {
    return { ...DEFAULT_MODEL_ROUTE }
  }

  // 默认模型被服务端改名/下架时,宁可退到同一个 profile 的别的模型,也别甩到另一家
  // provider 去 —— 那个 profile 是特意选的默认。
  if (defaultProfile?.models.length) {
    return { provider: defaultProfile.id, model: defaultProfile.models[0] }
  }

  const firstProfile = input.gatewayProfiles.find((profile) => profile.models.length > 0)
  return firstProfile
    ? { provider: firstProfile.id, model: firstProfile.models[0] }
    : null
}

/**
 * 选择器(桌面和手机)能看到哪些模型(T3.1):网关给了模型键之后，只列 `pi-studio` 组和 ACP 组;
 * 旧的按线路 provider 还注册着(旧会话要能恢复),但不再列出 —— 除了当前正在用的那一个，
 * 不然看不出自己在用什么。网关还没有模型键(老网关、登记表为空)时原样全列。
 */
export function visibleSwitcherModels<T extends { provider: string; id: string }>(
  models: readonly T[],
  current: { provider: string; id: string } | null | undefined,
): T[] {
  if (!models.some((model) => model.provider === GATEWAY_MODEL_PROVIDER)) return [...models]
  return models.filter(
    (model) =>
      model.provider === GATEWAY_MODEL_PROVIDER ||
      isAcpModelRoute(model.provider) ||
      (current != null && model.provider === current.provider && model.id === current.id),
  )
}
