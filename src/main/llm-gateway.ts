import type { GatewayModelEntry, LlmProviderProfile } from '../shared/contracts'
import { cloudFetch } from './cloud-fetch'
import { buildGatewayModel, buildModelKeyConfig, type PiCustomModelConfig } from '../shared/gateway-model'
import { GATEWAY_MODEL_PROVIDER } from '../shared/model-route'

export type { GatewayModelEntry, LlmProviderProfile } from '../shared/contracts'
export { isGatewayReasoningModel, type PiCustomModelConfig } from '../shared/gateway-model'

export type LlmCatalog = { providers: LlmProviderProfile[] }

export function listEnabledLlmRoutes(catalog: LlmCatalog): string[] {
  return catalog.providers
    .filter((profile) => profile.enabled)
    .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name))
    .flatMap((profile) =>
      profile.models
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) => `${profile.id}::${model}`),
    )
}

export type PiCustomProviderConfig = {
  baseUrl: string
  api: 'openai-completions'
  apiKey: '$PI_STUDIO_LLM_KEY'
  models: PiCustomModelConfig[]
}

export function buildGatewayProviderConfigs(
  relay: string,
  profiles: LlmProviderProfile[],
  models: GatewayModelEntry[] = [],
): Record<string, PiCustomProviderConfig> {
  const root = relay.trim().replace(/\/+$/, '')
  // 按模型键的 provider 放最前;旧的按线路 provider 留着给旧会话恢复用(选择器里不显示)。
  const modelKeyProvider: Array<[string, PiCustomProviderConfig]> =
    models.length > 0
      ? [[
          GATEWAY_MODEL_PROVIDER,
          {
            baseUrl: `${root}/llm/v1`,
            api: 'openai-completions' as const,
            apiKey: '$PI_STUDIO_LLM_KEY' as const,
            models: models.map(buildModelKeyConfig),
          },
        ]]
      : []
  return Object.fromEntries([
    ...modelKeyProvider,
    ...profiles
      .filter((profile) => profile.enabled && profile.models.length > 0)
      .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name))
      .map((profile) => [
        profile.id,
        {
          baseUrl: `${root}/llm/v1/${encodeURIComponent(profile.id)}`,
          api: 'openai-completions' as const,
          apiKey: '$PI_STUDIO_LLM_KEY' as const,
          models: profile.models.map((id) => buildGatewayModel(profile, id)),
        },
      ] as [string, PiCustomProviderConfig]),
  ])
}

async function gatewayJson<T>(
  relay: string,
  appKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await cloudFetch(`${relay.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': appKey,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as { detail?: string }
      if (payload.detail) detail = payload.detail
    } catch {
      // Keep the stable status fallback; never copy an HTML error page into the UI.
    }
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function fetchLlmCatalog(relay: string, appKey: string): Promise<LlmCatalog> {
  return gatewayJson(relay, appKey, '/llm/catalog')
}

/** 按模型键的目录(llm-models/v1,网关 T1.2)。老网关没有这个口时返回 404,调用方当空列表处理。 */
export function fetchLlmModels(relay: string, appKey: string): Promise<{ contract: string; models: GatewayModelEntry[] }> {
  return gatewayJson(relay, appKey, '/llm/models')
}

export function createLlmSessionToken(
  relay: string,
  appKey: string,
): Promise<{ token: string; expires_at: number; scope: 'llm:chat' }> {
  return gatewayJson(relay, appKey, '/llm/session-token', { method: 'POST' })
}

/**
 * 给 agent 子进程换一张只能出图的票。子进程不该拿 appKey 本身 —— 那把 key 在后端
 * 是管理员(能改 provider 的 base_url、签 chat token、读日志),而 image_gen 扩展
 * 只需要 POST /imagegen 和 /imagegen/reference。票一天作废,每次 spawn 都换新。
 */
export function createImageAgentToken(
  relay: string,
  appKey: string,
): Promise<{ token: string; expires_at: number; scope: 'imagegen:agent' }> {
  return gatewayJson(relay, appKey, '/imagegen/agent-token', { method: 'POST' })
}

export function listLlmProfiles(relay: string, appKey: string): Promise<LlmProviderProfile[]> {
  return gatewayJson(relay, appKey, '/llm/profiles')
}
