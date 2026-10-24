import { getCloudConnection, type CloudConnection } from './cloud-connection'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  createLlmProfile,
  createImageAgentToken,
  createLlmSessionToken,
  deleteLlmProfile,
  fetchLlmCatalog,
  fetchLlmProviderHealth,
  listLlmProfiles,
  refreshLlmProfileModels,
  probeLlmModel,
  updateLlmProfile,
  type LlmCatalog,
  type LlmProviderHealth,
  type LlmProviderProfile,
} from './llm-gateway'
import {
  agentConfigDir,
  migrateOfficialDeepSeekFavorites,
  writeModelsOverride,
  migrateDirectProviderRetirement,
} from './settings'
import type { LlmModelMetadata, LlmProfileSavePayload, ModelCatalogView } from '../shared/contracts'
import { DEEPSEEK_PROFILE_ID } from '../shared/deepseek-profile'

type ModelProjection = {
  gatewayRelay: string
  gatewayProfiles: LlmProviderProfile[]
}

export type ModelCatalogDependencies = {
  getConnection: () => CloudConnection
  fetchCatalog: (relay: string, appKey: string) => Promise<LlmCatalog>
  createSessionToken: typeof createLlmSessionToken
  createImageAgentToken: typeof createImageAgentToken
  listProfiles: typeof listLlmProfiles
  createProfile: typeof createLlmProfile
  updateProfile: typeof updateLlmProfile
  deleteProfile: typeof deleteLlmProfile
  refreshProfileModels: typeof refreshLlmProfileModels
  probeModel: typeof probeLlmModel
  providerHealth: typeof fetchLlmProviderHealth
  projectModels: (projection: ModelProjection) => void
  loadCachedProfiles: () => LlmProviderProfile[]
  saveCachedProfiles: (profiles: LlmProviderProfile[]) => void
  migrateOfficialDeepSeekFavorites: (profiles: LlmProviderProfile[]) => boolean
  migrateDirectProviderRetirement: (profiles: LlmProviderProfile[]) => boolean
}

export type ModelCatalogSync = {
  profiles: LlmProviderProfile[]
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
    providerLabels: Object.fromEntries(
      profiles.map((profile) => [profile.id, profile.display_name]),
    ),
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
    createSessionToken: createLlmSessionToken,
    createImageAgentToken,
    listProfiles: listLlmProfiles,
    createProfile: createLlmProfile,
    updateProfile: updateLlmProfile,
    deleteProfile: deleteLlmProfile,
    refreshProfileModels: refreshLlmProfileModels,
    probeModel: probeLlmModel,
    providerHealth: fetchLlmProviderHealth,
    projectModels: (projection) =>
      writeModelsOverride(projection.gatewayRelay, projection.gatewayProfiles),
    loadCachedProfiles: loadCatalogCache,
    saveCachedProfiles: saveCatalogCache,
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

  private project(connection: CloudConnection, gatewayProfiles: LlmProviderProfile[]): void {
    this.dependencies.projectModels({
      gatewayRelay: connection.relay,
      gatewayProfiles,
    })
  }

  private async loadAndProject(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<LlmProviderProfile[]> {
    const profiles = (await this.fetchAndCacheProfiles(connection)).filter(
      (profile) => profile.enabled && profile.models.length > 0,
    )
    this.project(connection, profiles)
    return profiles
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

  private loadCachedAndProject(connection: CloudConnection): LlmProviderProfile[] {
    const profiles = validProfiles(this.dependencies.loadCachedProfiles())
      .filter((profile) => profile.enabled && profile.models.length > 0)
    this.runConfigMigrationsAndNotify(profiles)
    this.project(connection, profiles)
    return profiles
  }

  async sync(): Promise<ModelCatalogSync> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [])
      return { profiles: [] }
    }
    try {
      return { profiles: await this.loadAndProject(connection) }
    } catch (error) {
      return {
        profiles: this.loadCachedAndProject(connection),
        warning: errorMessage(error),
      }
    }
  }

  async prepareRuntime(): Promise<ModelCatalogRuntime> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [])
      return { profiles: [], chatToken: '', imageToken: '' }
    }
    const [catalogResult, sessionResult, imageResult] = await Promise.allSettled([
      this.loadAndProject(connection),
      this.dependencies.createSessionToken(connection.relay, connection.key),
      this.dependencies.createImageAgentToken(connection.relay, connection.key),
    ])
    const warnings: string[] = []
    const profiles =
      catalogResult.status === 'fulfilled'
        ? catalogResult.value
        : this.loadCachedAndProject(connection)
    if (catalogResult.status === 'rejected') warnings.push(errorMessage(catalogResult.reason))
    if (sessionResult.status === 'rejected') warnings.push(errorMessage(sessionResult.reason))
    if (sessionResult.status === 'rejected') this.project(connection, [])
    // 出图票换不到不拦聊天:image_gen 那一个工具报未配置,其余照常。但要留下痕迹,
    // 不然"生图突然不能用了"查不到源头。
    if (imageResult.status === 'rejected') warnings.push(`image agent token: ${errorMessage(imageResult.reason)}`)
    return {
      profiles: sessionResult.status === 'fulfilled' ? profiles : [],
      chatToken: sessionResult.status === 'fulfilled' ? sessionResult.value.token : '',
      imageToken: imageResult.status === 'fulfilled' ? imageResult.value.token : '',
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    }
  }

  async listProfiles(): Promise<LlmProviderProfile[]> {
    const connection = this.requireConnection()
    return this.dependencies.listProfiles(connection.relay, connection.key)
  }

  async loadProviderLabels(): Promise<ModelCatalogView> {
    const connection = this.dependencies.getConnection()
    let profiles: LlmProviderProfile[]
    if (!connection.available) {
      profiles = validProfiles(this.dependencies.loadCachedProfiles())
      if (profiles.length === 0) {
        throw new Error(connection.error || 'Pi Studio cloud service is not configured')
      }
    } else {
      try {
        profiles = await this.fetchAndCacheProfiles(connection)
      } catch (error) {
        profiles = validProfiles(this.dependencies.loadCachedProfiles())
        if (profiles.length === 0) throw error
      }
    }
    return providerLabelView(profiles)
  }

  loadCachedProviderLabels(): ModelCatalogView {
    return providerLabelView(validProfiles(this.dependencies.loadCachedProfiles()))
  }

  private async mutateAndPublish<T>(mutation: () => Promise<T>): Promise<{
    value: T
    warning?: string
  }> {
    const value = await mutation()
    const sync = await this.sync()
    this.onChanged?.()
    return { value, warning: sync.warning }
  }

  async saveProfile(
    payload: LlmProfileSavePayload,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      payload.create
        ? this.dependencies.createProfile(connection.relay, connection.key, payload.profile)
        : this.dependencies.updateProfile(connection.relay, connection.key, payload.profile),
    )
    return { profile: result.value, warning: result.warning }
  }

  async deleteProfile(id: string): Promise<{ warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      this.dependencies.deleteProfile(connection.relay, connection.key, id),
    )
    return { warning: result.warning }
  }

  async refreshProfileModels(
    id: string,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      this.dependencies.refreshProfileModels(connection.relay, connection.key, id),
    )
    return { profile: result.value, warning: result.warning }
  }

  async verifyDiscoveredModels(
    id: string,
  ): Promise<{
    models: string[]
    verifiedModels: string[]
    rejectedModels: string[]
    unverifiedModels: string[]
    warning?: string
  }> {
    const connection = this.requireConnection()
    const profile = (await this.dependencies.listProfiles(connection.relay, connection.key))
      .find((item) => item.id === id && item.enabled)
    if (!profile) throw new Error('找不到已启用的模型线路')

    // 先让服务端剔除明确不可用的旧模型，并取回上游新发现项；新模型逐个临时登记，
    // 只有最小 chat 请求成功才加入。已配置的模型只在上游明确说"模型不存在"时才删:
    // key 失效、限流、5xx、超时、参数不兼容都只算没测出来，原样保留。
    const refreshed = await this.dependencies.refreshProfileModels(connection.relay, connection.key, id)
    const configuredModels = [...new Set(refreshed.models)]
    const verifiedModels: string[] = []
    const rejectedModels: string[] = []
    const unverifiedModels: string[] = []
    const candidates = [...new Set([...configuredModels, ...(refreshed.new_models ?? [])])]
    const { token } = await this.dependencies.createSessionToken(connection.relay, connection.key)
    let nextModels = configuredModels

    try {
      for (const model of candidates) {
        // New discoveries must be temporarily added so the gateway can route the probe.
        if (!configuredModels.includes(model)) {
          await this.dependencies.updateProfile(connection.relay, connection.key, {
            id: profile.id,
            display_name: profile.display_name,
            base_url: profile.base_url ?? '',
            api_type: profile.api_type,
            api_key: '',
            models: [...configuredModels, model],
            enabled: profile.enabled,
            sort_order: profile.sort_order,
          })
        }
        const probe = await this.dependencies.probeModel(connection.relay, token, profile.id, model)
        if (probe === 'ok') verifiedModels.push(model)
        else if (probe === 'missing') rejectedModels.push(model)
        else unverifiedModels.push(model)
      }

      // 每个模型都被判"不存在"更像线路本身配错了(base_url、上游换了路径),不是模型
      // 全下架了;这时不动配置，让用户去看线路。
      if (configuredModels.length > 0 && rejectedModels.length === candidates.length) {
        throw new Error('所有模型都被上游判定为不存在，疑似线路配置有误，已保留原有模型列表')
      }

      nextModels = candidates.filter((model) =>
        verifiedModels.includes(model)
        || (unverifiedModels.includes(model) && configuredModels.includes(model)))
      await this.dependencies.updateProfile(connection.relay, connection.key, {
        id: profile.id,
        display_name: profile.display_name,
        base_url: profile.base_url ?? '',
        api_type: profile.api_type,
        api_key: '',
        models: nextModels,
        enabled: profile.enabled,
        sort_order: profile.sort_order,
      })
    } catch (error) {
      // A transport/token failure says nothing about model health. Restore the last
      // committed list before surfacing it so temporary staging never leaks.
      try {
        await this.dependencies.updateProfile(connection.relay, connection.key, {
          id: profile.id,
          display_name: profile.display_name,
          base_url: profile.base_url ?? '',
          api_type: profile.api_type,
          api_key: '',
          models: configuredModels,
          enabled: profile.enabled,
          sort_order: profile.sort_order,
        })
      } catch (restoreError) {
        throw new Error(
          `${(error as Error).message ?? String(error)}；恢复原模型列表也失败了：${(restoreError as Error).message ?? String(restoreError)}`,
        )
      }
      throw error
    }

    const sync = await this.sync()
    this.onChanged?.()
    return {
      models: nextModels,
      verifiedModels,
      rejectedModels,
      unverifiedModels,
      ...(sync.warning ? { warning: sync.warning } : {}),
    }
  }

  async providerHealth(id: string): Promise<LlmProviderHealth> {
    const connection = this.requireConnection()
    return this.dependencies.providerHealth(connection.relay, connection.key, id)
  }

  private requireConnection(): Extract<CloudConnection, { available: true }> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      throw new Error(connection.error || 'Pi Studio cloud service is not configured')
    }
    return connection
  }
}
