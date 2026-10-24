import type { LlmProviderProfile } from '../../../shared/contracts'

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
