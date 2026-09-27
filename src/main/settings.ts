import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import {
  buildGatewayProviderConfigs,
  type LlmProviderProfile,
} from './llm-gateway'
import {
  parseFavoriteModelRoutes,
  type ModelRoute,
} from '../shared/model-route'
import {
  createDefaultSettingsForm,
  type SettingsForm,
  type Workspace,
} from '../shared/contracts'
import { parseAllowedHostList } from '../shared/sandbox-hosts'
import {
  migrateDeepSeekFavoriteModels,
} from '../shared/deepseek-profile'
import {
  migrateDirectFavoritesToGateway,
  migrateDirectSelectedRoute,
} from '../shared/direct-provider-retirement'

export type { Workspace } from '../shared/contracts'

export type SettingsData = SettingsForm & {
  favoriteModelRoutes: ModelRoute[]
  selectedModelRoute: ModelRoute | null
  recentWorkspaces: Workspace[]
}

const DEFAULTS: SettingsData = {
  ...createDefaultSettingsForm(),
  favoriteModelRoutes: [],
  selectedModelRoute: null,
  recentWorkspaces: [],
}

const MAX_RECENT_WORKSPACES = 10
const DEEPSEEK_FAVORITES_MIGRATION_KEY = 'deepSeekFavoriteModelsMigrated'
const DIRECT_RETIREMENT_MIGRATION_KEY = 'directProviderRetired'
/** 退役前那个唯一的直连 provider;搬迁读老配置时的兜底值。 */
const DEFAULT_DIRECT_PROVIDER = 'openai'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readRaw(): Record<string, unknown> {
  const p = settingsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeRaw(data: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function decryptField(raw: Record<string, unknown>, plainKey: string, encKey: string): string {
  if (raw[encKey] && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(raw[encKey] as string, 'base64'))
    } catch {
      return ''
    }
  }
  return typeof raw[plainKey] === 'string' ? (raw[plainKey] as string) : ''
}

function encryptField(
  raw: Record<string, unknown>,
  plainKey: string,
  encKey: string,
  value: string,
): void {
  if (safeStorage.isEncryptionAvailable() && value) {
    raw[encKey] = safeStorage.encryptString(value).toString('base64')
    delete raw[plainKey]
  } else {
    raw[plainKey] = value
    delete raw[encKey]
  }
}

export function loadSettings(): SettingsData {
  const raw = readRaw()
  const legacyImageProviderKeys = [
    'imageProviderMode',
    'imageSecondaryBaseUrl',
    'imageSecondaryKey',
    'imageSecondaryKeyEncrypted',
  ]
  if (legacyImageProviderKeys.some((key) => key in raw)) {
    for (const key of legacyImageProviderKeys) delete raw[key]
    writeRaw(raw)
  }
  const selectedModelRoute = raw.selectedModelRoute as Partial<ModelRoute> | undefined

  return {
    favoriteModels: (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
    favoriteModelRoutes: parseFavoriteModelRoutes(
      (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
      DEFAULT_DIRECT_PROVIDER,
    ),
    selectedModelRoute:
      typeof selectedModelRoute?.provider === 'string' &&
      typeof selectedModelRoute?.model === 'string' &&
      selectedModelRoute.provider.trim() &&
      selectedModelRoute.model.trim()
        ? { provider: selectedModelRoute.provider.trim(), model: selectedModelRoute.model.trim() }
        : null,
    tavilyApiKey: decryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted'),
    sandboxEnabled:
      typeof raw.sandboxEnabled === 'boolean' ? raw.sandboxEnabled : DEFAULTS.sandboxEnabled,
    sandboxAllowedHosts: parseAllowedHostList(raw.sandboxAllowedHosts),
    subagentsEnabled:
      typeof raw.subagentsEnabled === 'boolean' ? raw.subagentsEnabled : DEFAULTS.subagentsEnabled,
    remoteEnabled:
      typeof raw.remoteEnabled === 'boolean' ? raw.remoteEnabled : DEFAULTS.remoteEnabled,
    feishuWebhookUrl: (raw.feishuWebhookUrl as string) ?? DEFAULTS.feishuWebhookUrl,
    feishuSecret: decryptField(raw, 'feishuSecret', 'feishuSecretEncrypted'),
    feishuAppId: (raw.feishuAppId as string) ?? DEFAULTS.feishuAppId,
    feishuAppSecret: decryptField(raw, 'feishuAppSecret', 'feishuAppSecretEncrypted'),
    feishuChatId: (raw.feishuChatId as string) ?? DEFAULTS.feishuChatId,
    imageEngine:
      raw.imageEngine === 'openai' || raw.imageEngine === 'gemini' || raw.imageEngine === 'grok'
        ? raw.imageEngine
        : DEFAULTS.imageEngine,
    cloudImageRelay: (raw.cloudImageRelay as string) ?? DEFAULTS.cloudImageRelay,
    cloudImageKey: decryptField(raw, 'cloudImageKey', 'cloudImageKeyEncrypted'),
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? (raw.recentWorkspaces as Workspace[])
      : DEFAULTS.recentWorkspaces,
  }
}

export function saveSettings(settings: SettingsForm): void {
  const raw = readRaw()

  encryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted', settings.tavilyApiKey)
  encryptField(raw, 'feishuSecret', 'feishuSecretEncrypted', settings.feishuSecret)
  encryptField(raw, 'feishuAppSecret', 'feishuAppSecretEncrypted', settings.feishuAppSecret)
  encryptField(raw, 'cloudImageKey', 'cloudImageKeyEncrypted', settings.cloudImageKey)
  raw.favoriteModels = settings.favoriteModels
  delete raw.securityGuardEnabled
  raw.sandboxEnabled = settings.sandboxEnabled
  raw.sandboxAllowedHosts = settings.sandboxAllowedHosts ?? []
  raw.subagentsEnabled = settings.subagentsEnabled
  raw.remoteEnabled = settings.remoteEnabled
  raw.feishuWebhookUrl = settings.feishuWebhookUrl
  raw.feishuAppId = settings.feishuAppId
  raw.feishuChatId = settings.feishuChatId
  raw.imageEngine = settings.imageEngine
  raw.cloudImageRelay = settings.cloudImageRelay

  writeRaw(raw)
}

/** 远程控制开关即时持久化(设置页开关一键生效,不必等整体保存)。 */
export function saveRemoteEnabled(enabled: boolean): void {
  const raw = readRaw()
  raw.remoteEnabled = enabled
  writeRaw(raw)
}

export function addRecentWorkspace(path: string): Workspace[] {
  const current = loadSettings().recentWorkspaces.filter((w) => w.path !== path)
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const next = [{ path, name, lastOpenedAt: new Date().toISOString() }, ...current].slice(
    0,
    MAX_RECENT_WORKSPACES,
  )
  const raw = readRaw()
  raw.recentWorkspaces = next
  writeRaw(raw)
  return next
}

export function saveSelectedModelRoute(provider: string, model: string): void {
  const raw = readRaw()
  raw.selectedModelRoute = { provider: provider.trim(), model: model.trim() }
  writeRaw(raw)
}

export function migrateOfficialDeepSeekFavorites(enabledModels: string[]): boolean {
  const raw = readRaw()
  if (raw[DEEPSEEK_FAVORITES_MIGRATION_KEY] === true) return false

  const current =
    typeof raw.favoriteModels === 'string' ? raw.favoriteModels : DEFAULTS.favoriteModels
  const next = migrateDeepSeekFavoriteModels({
    favoriteModels: current,
    legacyProvider: (raw.provider as string) ?? DEFAULT_DIRECT_PROVIDER,
    enabledModels,
  })

  raw[DEEPSEEK_FAVORITES_MIGRATION_KEY] = true
  if (next !== current) raw.favoriteModels = next
  writeRaw(raw)
  return next !== current
}

/**
 * 直连 provider 退役的一次性搬迁:收藏项和当前选中线路从 `openai::X` 挪到真正供这个
 * 模型的网关 profile 上。
 *
 * 有意直接读 raw 里的 provider / model 而不走 loadSettings():这两个字段本身就是要被
 * 退役的,搬迁得在它们从 SettingsForm 里消失之后仍然能读到老值。
 */
export function migrateDirectProviderRetirement(gatewayProfiles: LlmProviderProfile[]): boolean {
  const raw = readRaw()
  if (raw[DIRECT_RETIREMENT_MIGRATION_KEY] === true) return false
  if (gatewayProfiles.length === 0) return false

  const directProvider = (raw.provider as string)?.trim() || DEFAULT_DIRECT_PROVIDER
  const directModel = (raw.model as string)?.trim() ?? ''
  const currentFavorites =
    typeof raw.favoriteModels === 'string' ? raw.favoriteModels : DEFAULTS.favoriteModels

  const nextFavorites = migrateDirectFavoritesToGateway({
    favoriteModels: currentFavorites,
    directProvider,
    gatewayProfiles,
  })

  const selected = raw.selectedModelRoute as Partial<ModelRoute> | undefined
  const nextSelected = migrateDirectSelectedRoute({
    selected:
      typeof selected?.provider === 'string' && typeof selected?.model === 'string'
        ? { provider: selected.provider.trim(), model: selected.model.trim() }
        : null,
    directProvider,
    directModel,
    gatewayProfiles,
  })

  const favoritesChanged = nextFavorites !== currentFavorites
  const selectedChanged =
    JSON.stringify(nextSelected) !== JSON.stringify(raw.selectedModelRoute ?? null)

  raw[DIRECT_RETIREMENT_MIGRATION_KEY] = true
  if (favoritesChanged) raw.favoriteModels = nextFavorites
  if (selectedChanged) {
    if (nextSelected) raw.selectedModelRoute = nextSelected
    else delete raw.selectedModelRoute
  }
  writeRaw(raw)
  return favoritesChanged || selectedChanged
}

export function removeRecentWorkspace(path: string): Workspace[] {
  const next = loadSettings().recentWorkspaces.filter((w) => w.path !== path)
  const raw = readRaw()
  raw.recentWorkspaces = next
  writeRaw(raw)
  return next
}

/**
 * pi's config (auth.json, models.json) normally lives at ~/.pi/agent — global
 * and shared with any other `pi` CLI install the user has. Point the spawned
 * subprocess at an app-private directory instead via PI_CODING_AGENT_DIR, so
 * pi-studio's third-party-gateway override below never leaks into / conflicts
 * with the user's own pi setup.
 */
export function agentConfigDir(): string {
  return join(app.getPath('userData'), 'pi-agent')
}

/**
 * 把云端网关的 provider 列表投影成 pi 的 models.json。
 *
 * 直连 provider 退役后这里只剩网关一条路:不再有 baseUrl 覆写、不再有自定义模型 id
 * (那是给内置 registry 补模型用的,网关 profile 自带完整模型列表),Helicone 那套
 * 包装也一并去掉 —— 它是靠改写直连 provider 条目实现的,没有直连就无处可挂,而且
 * 中转自己的 chat_logs 已经在记全量请求响应了。
 */
export function writeModelsOverride(
  gatewayRelay: string,
  gatewayProfiles: LlmProviderProfile[],
): void {
  const dir = agentConfigDir()
  mkdirSync(dir, { recursive: true })
  const modelsPath = join(dir, 'models.json')

  const providers: Record<string, unknown> = gatewayRelay.trim()
    ? buildGatewayProviderConfigs(gatewayRelay, gatewayProfiles)
    : {}

  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8')
}
