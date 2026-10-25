import type { GatewayModelEntry, LlmProviderProfile } from '../../../shared/contracts'
import type { ModelInfo } from '../../../shared/ipc/contract'
import {
  buildGatewayModel,
  buildModelKeyConfig,
  PI_CUSTOM_MODEL_DEFAULTS,
  type PiCustomModelConfig,
} from '../../../shared/gateway-model'
import { GATEWAY_MODEL_PROVIDER } from '../../../shared/model-route'

// 和主进程写进 Pi models.json 的是同一份推断(云端 metadata → DeepSeek 种子 → 名字启发式),
// 缺的字段再按 Pi 自己的默认值补，切过去之后选择器显示不会变。
function toModelInfo(
  provider: string,
  model: PiCustomModelConfig,
  endpoint: { baseUrl?: string; api?: string },
): ModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? PI_CUSTOM_MODEL_DEFAULTS.contextWindow,
    maxTokens: model.maxTokens ?? PI_CUSTOM_MODEL_DEFAULTS.maxTokens,
    reasoning: model.reasoning ?? PI_CUSTOM_MODEL_DEFAULTS.reasoning,
    input: model.input ?? [...PI_CUSTOM_MODEL_DEFAULTS.input],
    cost: model.cost,
    ...endpoint,
  }
}

/** Runtime registry snapshots can lag behind cloud profile updates. Keep its
 * metadata where present, and fill missing routes from the synced catalog.
 *
 * 网关给了模型键(T3.1)就只补 `pi-studio` 组 —— 旧的按线路 provider 不再进选择器，
 * 运行时列表在主进程那边已经滤过了，这里不能再从线路配置把它们补回来。 */
export function mergeAvailableModelInfo(
  runtimeModels: readonly ModelInfo[],
  profiles: readonly LlmProviderProfile[],
  gatewayModels: readonly GatewayModelEntry[] = [],
): ModelInfo[] {
  if (gatewayModels.length > 0) {
    const merged = new Map(runtimeModels.map((model) => [`${model.provider}::${model.id}`, model]))
    for (const entry of gatewayModels) {
      const key = `${GATEWAY_MODEL_PROVIDER}::${entry.key}`
      if (!merged.has(key)) merged.set(key, toModelInfo(GATEWAY_MODEL_PROVIDER, buildModelKeyConfig(entry), {}))
    }
    return [...merged.values()]
  }

  const byProvider = new Map(profiles.map((profile) => [profile.id, profile]))
  const merged = new Map(
    runtimeModels
      .filter((model) => {
        const profile = byProvider.get(model.provider)
        return !profile || (profile.enabled && !profile.unavailable_models?.includes(model.id))
      })
      .map((model) => [`${model.provider}::${model.id}`, model]),
  )
  for (const profile of profiles) {
    if (!profile.enabled) continue
    const unavailable = new Set(profile.unavailable_models ?? [])
    for (const id of profile.models) {
      const key = `${profile.id}::${id}`
      if (unavailable.has(id) || merged.has(key)) continue
      merged.set(
        key,
        toModelInfo(profile.id, buildGatewayModel(profile, id), { baseUrl: profile.base_url, api: profile.api_type }),
      )
    }
  }
  return [...merged.values()]
}

/**
 * 设置页「实际使用模型」的选项:网关登记的模型键(`pi-studio::<键>`),
 * 外加已经在收藏里、但不是模型键的条目(T3.2 映射不到的旧 `线路::模型`)——
 * 不列出来的话多选框会把它们显示成裸值，用户也删不掉。
 */
export function buildFavoriteModelOptions(
  gatewayModels: readonly GatewayModelEntry[],
  favorites: readonly string[],
): Array<{ value: string; label: string }> {
  const options = gatewayModels.map((entry) => ({
    value: `${GATEWAY_MODEL_PROVIDER}::${entry.key}`,
    label: entry.key,
  }))
  const known = new Set(options.map((option) => option.value))
  for (const route of favorites) {
    if (known.has(route)) continue
    known.add(route)
    options.push({ value: route, label: `${route}(未登记，切换器里不显示)` })
  }
  return options
}
