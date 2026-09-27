import type { ModelRoute } from './model-route'

export type ImageEngine = '' | 'openai' | 'gemini' | 'grok'

export type Workspace = {
  path: string
  name: string
  lastOpenedAt: string
}

export type LlmModelMetadata = {
  name?: string
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Partial<
    Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>
  >
  compat?: {
    supportsDeveloperRole?: boolean
    supportsReasoningEffort?: boolean
    requiresReasoningContentOnAssistantMessages?: boolean
    thinkingFormat?: 'deepseek'
  }
}

export type LlmProviderProfile = {
  id: string
  display_name: string
  base_url?: string
  api_type: 'openai-completions'
  models: string[]
  model_metadata?: Record<string, LlmModelMetadata>
  enabled: boolean
  sort_order: number
  has_key: boolean
  /** 探活确认调不通、刷新时被剔除的模型(仅刷新响应里带)。 */
  unavailable_models?: string[]
  /** 上游有、但本线路还没配上的模型;刷新只报不加,由用户决定(仅刷新响应里带)。 */
  new_models?: string[]
}

export type LlmProviderRouteStats = {
  requestCount: number
  successCount: number
  failureCount: number
  failedAttemptCount: number
  lastRequestAt?: string | null
  lastStatus?: number | null
  lastError?: string | null
}

export type LlmProviderRecentFailure = {
  at?: string
  model?: string
  routeId?: string
  status?: number
  message?: string
}

export type LlmProviderHealthState = {
  requestCount: number
  failedAttemptCount: number
  lastRequestAt?: string | null
  lastRouteId?: string | null
  lastStatus?: number | null
  lastError?: string | null
  routeStats: Record<string, LlmProviderRouteStats>
  recentFailures: LlmProviderRecentFailure[]
}

export type LlmProviderHealth =
  | {
      id: string
      display_name: string
      base_url?: string
      supported: true
      ok: boolean
      advertisedModels: string[]
      upstreams: Array<{ id?: string; baseUrl?: string }>
      modelRoutes: Record<string, string[]>
      modelMetadata: Record<string, LlmModelMetadata>
      state: LlmProviderHealthState
    }
  | {
      id: string
      display_name: string
      supported: false
      ok: false
      status_code: number
      error: string
    }

export type LlmProfileWrite = {
  id: string
  display_name: string
  base_url: string
  api_type: 'openai-completions'
  api_key: string
  models: string[]
  enabled: boolean
  sort_order: number
}

export type LlmProfileSavePayload =
  | { create: true; profile: LlmProfileWrite }
  | { create: false; profile: LlmProfileWrite }

export type SettingsForm = {
  favoriteModels: string
  tavilyApiKey: string
  sandboxEnabled: boolean
  /** 沙箱出站白名单的额外域名(内置名单之外)。可选:旧端不发送时按空处理。 */
  sandboxAllowedHosts?: string[]
  subagentsEnabled: boolean
  remoteEnabled: boolean
  feishuWebhookUrl: string
  feishuSecret: string
  feishuAppId: string
  feishuAppSecret: string
  feishuChatId: string
  imageEngine: ImageEngine
  cloudImageRelay: string
  cloudImageKey: string
}

export type SettingsView = SettingsForm & {
  favoriteModelRoutes: ModelRoute[]
  selectedModelRoute: ModelRoute | null
  cloudImageKeyConfigured: boolean
  modelAccessConfigured: boolean
  recentWorkspaces: Workspace[]
}

export type SettingsSaveInput = SettingsForm & {
  clearCloudImageKey?: boolean
}

export type ModelCatalogView = {
  providerLabels: Record<string, string>
}

export function createDefaultSettingsForm(): SettingsForm {
  return {
    favoriteModels: '',
    tavilyApiKey: '',
    sandboxEnabled: false,
    sandboxAllowedHosts: [],
    subagentsEnabled: true,
    remoteEnabled: false,
    feishuWebhookUrl: '',
    feishuSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuChatId: '',
    imageEngine: '',
    cloudImageRelay: '',
    cloudImageKey: '',
  }
}

export function createDefaultSettingsView(): SettingsView {
  return {
    ...createDefaultSettingsForm(),
    favoriteModelRoutes: [],
    selectedModelRoute: null,
    cloudImageKeyConfigured: false,
    modelAccessConfigured: false,
    recentWorkspaces: [],
  }
}
