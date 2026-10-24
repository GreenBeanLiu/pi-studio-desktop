import {
  GATEWAY_MODEL_PROVIDER,
  favoriteRouteKey,
  formatFavoriteModelRoutes,
  isAcpModelRoute,
  mapRouteToModelKey,
  parseFavoriteModelRoutes,
  type ModelRoute,
} from './model-route'

type ModelKeyEntry = { key: string; routes: Array<{ profile_id: string }> }

export type ModelKeyMigrationInput = {
  favoriteModels: string
  /** 老格式收藏(没写 `线路::`)按哪个 provider 理解。 */
  legacyProvider: string
  selected: ModelRoute | null
  models: ModelKeyEntry[]
}

export type ModelKeyMigrationResult = {
  favoriteModels: string
  selected: ModelRoute | null
  /** 映射不到模型键、原样留下的收藏(选择器里不再显示,只记日志)。 */
  unmapped: ModelRoute[]
}

/**
 * 收藏和当前选中从 `线路::模型` 搬到 `pi-studio::模型键`(T3.2)。规则见 mapRouteToModelKey。
 * 映射不到的不删:旧线路还注册着，用户哪天想回去还在;只是选择器不再列旧线路组。
 * ACP 路由原样保留。搬完去重(两个线路上的同一个模型会落到同一个键)。
 */
export function migrateRoutesToModelKeys(input: ModelKeyMigrationInput): ModelKeyMigrationResult {
  const unmapped: ModelRoute[] = []
  const next: ModelRoute[] = []
  const seen = new Set<string>()
  for (const route of parseFavoriteModelRoutes(input.favoriteModels, input.legacyProvider)) {
    let target = route
    if (!isAcpModelRoute(route.provider)) {
      const key = mapRouteToModelKey(route, input.models)
      if (key) target = { provider: GATEWAY_MODEL_PROVIDER, model: key }
      else if (route.provider !== GATEWAY_MODEL_PROVIDER) unmapped.push(route)
    }
    const dedupe = favoriteRouteKey(target.provider, target.model)
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    next.push(target)
  }

  let selected = input.selected
  if (selected && !isAcpModelRoute(selected.provider)) {
    const key = mapRouteToModelKey(selected, input.models)
    if (key) selected = { provider: GATEWAY_MODEL_PROVIDER, model: key }
  }

  return { favoriteModels: formatFavoriteModelRoutes(next), selected, unmapped }
}
