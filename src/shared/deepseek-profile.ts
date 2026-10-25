import {
  favoriteRouteKey,
  formatFavoriteModelRoutes,
  parseFavoriteModelRoutes,
} from './model-route'

export const DEEPSEEK_PROFILE_ID = 'deepseek'
export const DEEPSEEK_OFFICIAL_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const

export function migrateDeepSeekFavoriteModels(input: {
  favoriteModels: string
  legacyProvider: string
  enabledModels: string[]
}): string {
  if (!input.favoriteModels.trim()) return input.favoriteModels

  const enabled = new Set(input.enabledModels.map((model) => model.toLowerCase()))
  const routes = parseFavoriteModelRoutes(input.favoriteModels, input.legacyProvider)
  const seen = new Set(
    routes.map((route) => favoriteRouteKey(route.provider, route.model)),
  )

  for (const model of DEEPSEEK_OFFICIAL_MODELS) {
    if (!enabled.has(model.toLowerCase())) continue
    const key = favoriteRouteKey(DEEPSEEK_PROFILE_ID, model)
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider: DEEPSEEK_PROFILE_ID, model })
  }

  return formatFavoriteModelRoutes(routes)
}
