import type {
  LlmProfileWrite,
  LlmProviderHealth,
  LlmProviderProfile,
} from '../shared/contracts'
import { cloudFetch } from './cloud-fetch'
import { buildGatewayModel, type PiCustomModelConfig } from '../shared/gateway-model'

export type { LlmProfileWrite, LlmProviderHealth, LlmProviderProfile } from '../shared/contracts'
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
): Record<string, PiCustomProviderConfig> {
  const root = relay.trim().replace(/\/+$/, '')
  return Object.fromEntries(
    profiles
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
      ]),
  )
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

export function createLlmSessionToken(
  relay: string,
  appKey: string,
): Promise<{ token: string; expires_at: number; scope: 'llm:chat' }> {
  return gatewayJson(relay, appKey, '/llm/session-token', { method: 'POST' })
}

/**
 * 探测结果分三档。只有 missing 能拿来删模型:401/403(key 失效)、429、5xx、超时、
 * 参数不被接受(如不认 max_tokens)都只说明"这次没测出来",不说明模型不存在。
 */
export type LlmModelProbeResult = 'ok' | 'missing' | 'inconclusive'

const MODEL_MISSING_CODES = new Set(['model_not_found', 'invalid_model', 'model_not_exist', 'unknown_model'])
const MODEL_MISSING_MESSAGE =
  /\bmodel\b.*\b(not found|does not exist|doesn't exist|not exist)\b|\b(unknown|invalid|no such)\s+model\b|模型.*(不存在|未找到)/i

/** 上游/网关的错误体是否明确在说"这个模型不存在"。只认模型级的措辞,不认状态码。 */
export function isModelMissingError(error: unknown): boolean {
  if (typeof error === 'string') return MODEL_MISSING_MESSAGE.test(error)
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (typeof record.code === 'string' && MODEL_MISSING_CODES.has(record.code.toLowerCase())) return true
  for (const key of ['error', 'detail', 'message']) {
    const value = record[key]
    if (value !== undefined && isModelMissingError(value)) return true
  }
  return false
}

/** 用一次最小 chat 请求确认模型可用于聊天；调用可能产生少量上游费用。 */
export async function probeLlmModel(
  relay: string,
  token: string,
  provider: string,
  model: string,
): Promise<LlmModelProbeResult> {
  let response: Response
  try {
    response = await cloudFetch(
      `${relay.replace(/\/+$/, '')}/llm/v1/${encodeURIComponent(provider)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    )
  } catch (error) {
    // 单个模型慢到超时不代表它坏了，也不该中断整轮验证；连不上网关这类错误照旧抛出。
    if (error instanceof Error && error.name === 'TimeoutError') return 'inconclusive'
    throw error
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const body = payload && typeof payload === 'object' ? payload as { error?: unknown; choices?: unknown } : {}
  if (response.ok && !body.error && Array.isArray(body.choices) && body.choices.length > 0) return 'ok'
  // 401/403/429/5xx 一律不判死刑，哪怕错误体里碰巧提到 model。
  if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
    return 'inconclusive'
  }
  return isModelMissingError(payload) ? 'missing' : 'inconclusive'
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

export function createLlmProfile(
  relay: string,
  appKey: string,
  profile: LlmProfileWrite,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, '/llm/profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
  })
}

export function updateLlmProfile(
  relay: string,
  appKey: string,
  profile: LlmProfileWrite,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function deleteLlmProfile(relay: string, appKey: string, id: string): Promise<void> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function refreshLlmProfileModels(
  relay: string,
  appKey: string,
  id: string,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}/refresh-models`, {
    method: 'POST',
  })
}

export function fetchLlmProviderHealth(
  relay: string,
  appKey: string,
  id: string,
): Promise<LlmProviderHealth> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}/provider-health`)
}
