import { getCloudConnection, type CloudConnection } from './cloud-connection'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  createImageAgentToken,
  createLlmSessionToken,
  fetchLlmCatalog,
  fetchLlmModels,
  listLlmProfiles,
  type GatewayModelEntry,
  type LlmCatalog,
  type LlmProviderProfile,
} from './llm-gateway'
import {
  agentConfigDir,
  migrateOfficialDeepSeekFavorites,
  writeModelsOverride,
  migrateDirectProviderRetirement,
  migrateToModelKeys,
} from './settings'
import type { LlmModelMetadata, ModelCatalogView } from '../shared/contracts'
import { DEEPSEEK_PROFILE_ID } from '../shared/deepseek-profile'
import { GATEWAY_MODEL_PROVIDER, GATEWAY_MODEL_PROVIDER_LABEL } from '../shared/model-route'

type ModelProjection = {
  gatewayRelay: string
  gatewayProfiles: LlmProviderProfile[]
  gatewayModels: GatewayModelEntry[]
}

export type ModelCatalogDependencies = {
  getConnection: () => CloudConnection
  fetchCatalog: (relay: string, appKey: string) => Promise<LlmCatalog>
  /** 按模型键的目录(T3.1)。老网关没有这个口 —— 失败时退到缓存，再不行就是空表(只剩旧的按线路 provider)。 */
  fetchModels: (relay: string, appKey: string) => Promise<GatewayModelEntry[]>
  createSessionToken: typeof createLlmSessionToken
  createImageAgentToken: typeof createImageAgentToken
  listProfiles: typeof listLlmProfiles
  projectModels: (projection: ModelProjection) => void
  loadCachedProfiles: () => LlmProviderProfile[]
  saveCachedProfiles: (profiles: LlmProviderProfile[]) => void
  loadCachedModels: () => GatewayModelEntry[]
  saveCachedModels: (models: GatewayModelEntry[]) => void
  migrateToModelKeys: (models: GatewayModelEntry[]) => boolean
  migrateOfficialDeepSeekFavorites: (profiles: LlmProviderProfile[]) => boolean
  migrateDirectProviderRetirement: (profiles: LlmProviderProfile[]) => boolean
}

export type ModelCatalogSync = {
  profiles: LlmProviderProfile[]
  models: GatewayModelEntry[]
  warning?: string
}

export type ModelCatalogRuntime = ModelCatalogSync & {
  chatToken: string
  /** 出图票(scope imagegen:agent);换不到就是空串,image_gen 扩展会报未配置。 */
  imageToken: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerLabelView(profiles: LlmProviderProfile[]): ModelCatalogView {
  return {
    providerLabels: {
      ...Object.fromEntries(profiles.map((profile) => [profile.id, profile.display_name])),
      [GATEWAY_MODEL_PROVIDER]: GATEWAY_MODEL_PROVIDER_LABEL,
    },
  }
}

function catalogCachePath(): string {
  return join(agentConfigDir(), 'model-catalog-cache.json')
}

function validMetadataEntry(value: unknown): value is LlmModelMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Partial<LlmModelMetadata>
  if (metadata.name !== undefined && typeof metadata.name !== 'string') return false
  if (metadata.reasoning !== undefined && typeof metadata.reasoning !== 'boolean') return false
  if (metadata.contextWindow !== undefined && typeof metadata.contextWindow !== 'number') return false
  if (metadata.maxTokens !== undefined && typeof metadata.maxTokens !== 'number') return false
  if (metadata.input !== undefined) {
    if (!Array.isArray(metadata.input)) return false
    if (!metadata.input.every((item) => item === 'text' || item === 'image')) return false
  }
  return true
}

function validMetadataMap(value: unknown): value is Record<string, LlmModelMetadata> {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(validMetadataEntry)
}

function isLlmProviderProfile(value: unknown): value is LlmProviderProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<LlmProviderProfile>
  return (
    typeof profile.id === 'string' &&
    !!profile.id.trim() &&
    typeof profile.display_name === 'string' &&
    !!profile.display_name.trim() &&
    (profile.base_url === undefined || typeof profile.base_url === 'string') &&
    profile.api_type === 'openai-completions' &&
    Array.isArray(profile.models) &&
    profile.models.every((model) => typeof model === 'string' && !!model.trim()) &&
    validMetadataMap(profile.model_metadata) &&
    typeof profile.enabled === 'boolean' &&
    typeof profile.sort_order === 'number' &&
    Number.isFinite(profile.sort_order) &&
    typeof profile.has_key === 'boolean'
  )
}

function validProfiles(values: unknown[]): LlmProviderProfile[] {
  return values.filter(isLlmProviderProfile)
}

function isGatewayModelEntry(value: unknown): value is GatewayModelEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<GatewayModelEntry>
  return (
    typeof entry.key === 'string' &&
    !!entry.key.trim() &&
    !entry.key.includes('::') &&
    validMetadataEntry(entry.metadata ?? {}) &&
    Array.isArray(entry.routes) &&
    entry.routes.length > 0 &&
    entry.routes.every(
      (route) => typeof route?.profile_id === 'string' && typeof route?.display_name === 'string',
    )
  )
}

export function validGatewayModels(values: unknown): GatewayModelEntry[] {
  if (!Array.isArray(values)) return []
  return values.filter(isGatewayModelEntry).map((entry) => ({ ...entry, metadata: entry.metadata ?? {} }))
}

function modelCachePath(): string {
  return join(agentConfigDir(), 'model-keys-cache.json')
}

function loadModelCache(): GatewayModelEntry[] {
  const path = modelCachePath()
  if (!existsSync(path)) return []
  try {
    return validGatewayModels((JSON.parse(readFileSync(path, 'utf-8')) as { models?: unknown }).models)
  } catch {
    return []
  }
}

function saveModelCache(models: GatewayModelEntry[]): void {
  mkdirSync(agentConfigDir(), { recursive: true })
  writeFileSync(modelCachePath(), JSON.stringify({ models }, null, 2), 'utf-8')
}

function loadCatalogCache(): LlmProviderProfile[] {
  const path = catalogCachePath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { profiles?: unknown }
    if (!Array.isArray(parsed.profiles)) return []
    return validProfiles(parsed.profiles)
  } catch {
    return []
  }
}

function saveCatalogCache(profiles: LlmProviderProfile[]): void {
  const path = catalogCachePath()
  mkdirSync(agentConfigDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({ profiles }, null, 2), 'utf-8')
}

export function defaultModelCatalogDependencies(): ModelCatalogDependencies {
  return {
    getConnection: getCloudConnection,
    fetchCatalog: fetchLlmCatalog,
    fetchModels: async (relay, appKey) => validGatewayModels((await fetchLlmModels(relay, appKey)).models),
    createSessionToken: createLlmSessionToken,
    createImageAgentToken,
    listProfiles: listLlmProfiles,
    projectModels: (projection) =>
      writeModelsOverride(projection.gatewayRelay, projection.gatewayProfiles, projection.gatewayModels),
    loadCachedProfiles: loadCatalogCache,
    saveCachedProfiles: saveCatalogCache,
    loadCachedModels: loadModelCache,
    saveCachedModels: saveModelCache,
    migrateToModelKeys,
    migrateOfficialDeepSeekFavorites: (profiles) => {
      const deepSeek = profiles.find(
        (profile) =>
          profile.id === DEEPSEEK_PROFILE_ID &&
          profile.enabled &&
          profile.models.length > 0,
      )
      return deepSeek ? migrateOfficialDeepSeekFavorites(deepSeek.models) : false
    },
    migrateDirectProviderRetirement,
  }
}

/** Owns remote catalog refresh, Pi registry projection, fallback, and change publication. */
export class ModelCatalogCoordinator {
  constructor(
    private readonly dependencies = defaultModelCatalogDependencies(),
    private readonly onChanged?: () => void,
  ) {}

  /** 一次性配置搬迁,拿到真实 profile 列表才能跑(要照它判断模型归属)。 */
  private runConfigMigrationsAndNotify(profiles: LlmProviderProfile[]): void {
    if (!this.onChanged) return
    // 两个都得跑,别用 || 串起来 —— 那样前一个改动了后一个就被短路掉了。
    const deepSeekChanged = this.dependencies.migrateOfficialDeepSeekFavorites(profiles)
    const retirementChanged = this.dependencies.migrateDirectProviderRetirement(profiles)
    if (deepSeekChanged || retirementChanged) this.onChanged()
  }

  private project(
    connection: CloudConnection,
    gatewayProfiles: LlmProviderProfile[],
    gatewayModels: GatewayModelEntry[],
  ): void {
    this.dependencies.projectModels({
      gatewayRelay: connection.relay,
      gatewayProfiles,
      gatewayModels,
    })
  }

  /** 模型键目录拿不到不拦整条同步:退到缓存;老网关没有这个口就一直是空表。 */
  private async fetchAndCacheModels(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<GatewayModelEntry[]> {
    try {
      const models = await this.dependencies.fetchModels(connection.relay, connection.key)
      this.dependencies.saveCachedModels(models)
      return models
    } catch {
      return validGatewayModels(this.dependencies.loadCachedModels())
    }
  }

  private migrateModelKeys(models: GatewayModelEntry[]): void {
    if (!this.onChanged || models.length === 0) return
    if (this.dependencies.migrateToModelKeys(models)) this.onChanged()
  }

  private async loadAndProject(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<{ profiles: LlmProviderProfile[]; models: GatewayModelEntry[] }> {
    const [allProfiles, models] = await Promise.all([
      this.fetchAndCacheProfiles(connection),
      this.fetchAndCacheModels(connection),
    ])
    const profiles = allProfiles.filter((profile) => profile.enabled && profile.models.length > 0)
    this.migrateModelKeys(models)
    this.project(connection, profiles, models)
    return { profiles, models }
  }

  private async fetchAndCacheProfiles(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<LlmProviderProfile[]> {
    const catalog = await this.dependencies.fetchCatalog(connection.relay, connection.key)
    const profiles = validProfiles(catalog.providers)
    this.dependencies.saveCachedProfiles(profiles)
    this.runConfigMigrationsAndNotify(profiles)
    return profiles
  }

  private loadCachedAndProject(
    connection: CloudConnection,
  ): { profiles: LlmProviderProfile[]; models: GatewayModelEntry[] } {
    const profiles = validProfiles(this.dependencies.loadCachedProfiles())
      .filter((profile) => profile.enabled && profile.models.length > 0)
    const models = validGatewayModels(this.dependencies.loadCachedModels())
    this.runConfigMigrationsAndNotify(profiles)
    this.migrateModelKeys(models)
    this.project(connection, profiles, models)
    return { profiles, models }
  }

  async sync(): Promise<ModelCatalogSync> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [], [])
      return { profiles: [], models: [] }
    }
    try {
      return await this.loadAndProject(connection)
    } catch (error) {
      return {
        ...this.loadCachedAndProject(connection),
        warning: errorMessage(error),
      }
    }
  }

  async prepareRuntime(): Promise<ModelCatalogRuntime> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [], [])
      return { profiles: [], models: [], chatToken: '', imageToken: '' }
    }
    const [catalogResult, sessionResult, imageResult] = await Promise.allSettled([
      this.loadAndProject(connection),
      this.dependencies.createSessionToken(connection.relay, connection.key),
      this.dependencies.createImageAgentToken(connection.relay, connection.key),
    ])
    const warnings: string[] = []
    const catalog =
      catalogResult.status === 'fulfilled'
        ? catalogResult.value
        : this.loadCachedAndProject(connection)
    if (catalogResult.status === 'rejected') warnings.push(errorMessage(catalogResult.reason))
    if (sessionResult.status === 'rejected') warnings.push(errorMessage(sessionResult.reason))
    if (sessionResult.status === 'rejected') this.project(connection, [], [])
    // 出图票换不到不拦聊天:image_gen 那一个工具报未配置,其余照常。但要留下痕迹,
    // 不然"生图突然不能用了"查不到源头。
    if (imageResult.status === 'rejected') warnings.push(`image agent token: ${errorMessage(imageResult.reason)}`)
    return {
      profiles: sessionResult.status === 'fulfilled' ? catalog.profiles : [],
      models: sessionResult.status === 'fulfilled' ? catalog.models : [],
      chatToken: sessionResult.status === 'fulfilled' ? sessionResult.value.token : '',
      imageToken: imageResult.status === 'fulfilled' ? imageResult.value.token : '',
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    }
  }

  async listProfiles(): Promise<LlmProviderProfile[]> {
    const connection = this.requireConnection()
    return this.dependencies.listProfiles(connection.relay, connection.key)
  }

  /**
   * 启动时渲染层第一个调的就是它 —— 一次性配置搬迁都挂在这条路上(带 onChanged 的协调器只在 ipc 里有一个，
   * 它启动时不走 sync)。模型键搬迁在 0.19.0 漏挂了这里，装上后收藏一直没搬(0.19.1 修)。
   */
  async loadProviderLabels(): Promise<ModelCatalogView> {
    const connection = this.dependencies.getConnection()
    let profiles: LlmProviderProfile[]
    if (!connection.available) {
      profiles = validProfiles(this.dependencies.loadCachedProfiles())
      if (profiles.length === 0) {
        throw new Error(connection.error || 'Pi Studio cloud service is not configured')
      }
      this.migrateModelKeys(validGatewayModels(this.dependencies.loadCachedModels()))
    } else {
      const [profilesResult, models] = await Promise.all([
        this.fetchAndCacheProfiles(connection).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        this.fetchAndCacheModels(connection),
      ])
      if (profilesResult.ok) {
        profiles = profilesResult.value
      } else {
        profiles = validProfiles(this.dependencies.loadCachedProfiles())
        if (profiles.length === 0) throw profilesResult.error
      }
      this.migrateModelKeys(models)
    }
    return providerLabelView(profiles)
  }

  /** 最近一次同步到的模型键目录(选择器补条目、悬浮信息显示线路用)。不发网络请求。 */
  listCachedModels(): GatewayModelEntry[] {
    return validGatewayModels(this.dependencies.loadCachedModels())
  }

  loadCachedProviderLabels(): ModelCatalogView {
    return providerLabelView(validProfiles(this.dependencies.loadCachedProfiles()))
  }

  private requireConnection(): Extract<CloudConnection, { available: true }> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      throw new Error(connection.error || 'Pi Studio cloud service is not configured')
    }
    return connection
  }
}
