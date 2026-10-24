import type { LlmProviderProfile } from '../../../shared/contracts'
import type { ModelInfo } from '../../../shared/ipc/contract'
import { buildGatewayModel, PI_CUSTOM_MODEL_DEFAULTS } from '../../../shared/gateway-model'

export function buildAvailableModelRoutes(
  profiles: readonly LlmProviderProfile[],
  discoveredRoutes: readonly string[],
): string[] {
  return [...new Set([
    ...profiles
      .filter((profile) => profile.enabled)
      .flatMap((profile) => profile.models.map((model) => `${profile.id}::${model.trim()}`)),
    ...discoveredRoutes,
  ])]
}

/** Runtime registry snapshots can lag behind cloud profile updates. Keep its
 * metadata where present, and fill missing routes from the synced profiles. */
export function mergeAvailableModelInfo(
  runtimeModels: readonly ModelInfo[],
  profiles: readonly LlmProviderProfile[],
): ModelInfo[] {
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
      // 和主进程写进 Pi models.json 的是同一份推断(云端 metadata → DeepSeek 种子 → 名字
      // 启发式),缺的字段再按 Pi 自己的默认值补，切过去之后选择器显示不会变。
      const model = buildGatewayModel(profile, id)
      merged.set(key, {
        provider: profile.id,
        id,
        name: model.name,
        contextWindow: model.contextWindow ?? PI_CUSTOM_MODEL_DEFAULTS.contextWindow,
        maxTokens: model.maxTokens ?? PI_CUSTOM_MODEL_DEFAULTS.maxTokens,
        reasoning: model.reasoning ?? PI_CUSTOM_MODEL_DEFAULTS.reasoning,
        input: model.input ?? [...PI_CUSTOM_MODEL_DEFAULTS.input],
        cost: model.cost,
        baseUrl: profile.base_url,
        api: profile.api_type,
      })
    }
  }
  return [...merged.values()]
}
