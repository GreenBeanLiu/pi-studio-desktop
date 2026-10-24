import type { LlmProviderProfile } from '../../../shared/contracts'
import type { ModelInfo } from '../../../shared/ipc/contract'

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
      const metadata = profile.model_metadata?.[id]
      merged.set(key, {
        provider: profile.id,
        id,
        name: metadata?.name,
        contextWindow: metadata?.contextWindow ?? 0,
        maxTokens: metadata?.maxTokens,
        reasoning: metadata?.reasoning ?? false,
        input: metadata?.input,
        cost: metadata?.cost,
        baseUrl: profile.base_url,
        api: profile.api_type,
      })
    }
  }
  return [...merged.values()]
}
