import type { GatewayModelEntry, LlmModelMetadata, LlmProviderProfile } from './contracts'
import deepSeekCatalog from './contracts/model-catalog-v1-deepseek.json'

// 主进程(写 Pi 的 models.json)和渲染层(运行时快照没跟上时补模型列表)共用同一份
// 网关模型推断，两边各写一份就会出现同一个模型在选择器里能力不一致。

export type PiCustomModelConfig = {
  id: string
  name: string
} & Omit<LlmModelMetadata, 'name'>

/** 云端 catalog 可下发模型能力；这里的模型名判断只作为旧 catalog 的兜底。 */
export function isGatewayReasoningModel(id: string): boolean {
  const s = id.toLowerCase()
  if (/non-reasoning|composer|fast|build|image|embed|whisper|tts/.test(s)) return false
  return /grok-4|grok-[5-9]|gpt-5|gpt-[6-9]|^o[1-9]|reasoning|deepseek-(?:r|v4)|glm.*think|qwq/.test(s)
}

function modelFromMetadata(id: string, metadata: LlmModelMetadata): PiCustomModelConfig {
  const { name, ...rest } = metadata
  return { id, name: name?.trim() || id, ...rest }
}

/**
 * model-catalog/v1 的 DeepSeek 种子(逐字节镜像自 pi-studio-control-plane
 * docs/contracts/fixtures/model-catalog-v1-deepseek.json)。运行时的真源是云端 profile 的
 * model_metadata(`/llm/catalog`),这份只在 catalog 没给 metadata 时兜底;价格不再写在代码里。
 */
function deepSeekSeed(id: string): (typeof deepSeekCatalog.models)[keyof typeof deepSeekCatalog.models] | null {
  const wanted = id.toLowerCase()
  for (const [model, entry] of Object.entries(deepSeekCatalog.models)) {
    if (model === wanted || entry.aliases.some((alias) => alias.toLowerCase() === wanted)) return entry
  }
  return null
}

/** DeepSeek 别名对应的现名(`deepseek-v4-flash` → `deepseek-flash`);不是 DeepSeek 模型返回 null。 */
export function deepSeekCanonicalModel(id: string): string | null {
  const wanted = id.toLowerCase()
  for (const [model, entry] of Object.entries(deepSeekCatalog.models)) {
    if (model === wanted || entry.aliases.some((alias) => alias.toLowerCase() === wanted)) return model
  }
  return null
}

export function buildGatewayModel(profile: LlmProviderProfile, id: string): PiCustomModelConfig {
  return buildModelConfig(id, profile.model_metadata?.[id], profile.id === 'deepseek')
}

/** 按模型键注册(T3.1):能力只认模型键自己的 metadata,缺了照同一套兜底。DeepSeek 种子按名字/别名认。 */
export function buildModelKeyConfig(entry: GatewayModelEntry): PiCustomModelConfig {
  const metadata = entry.metadata && Object.keys(entry.metadata).length > 0 ? entry.metadata : undefined
  return buildModelConfig(entry.key, metadata, true)
}

function buildModelConfig(
  id: string,
  metadata: LlmModelMetadata | undefined,
  allowDeepSeekSeed: boolean,
): PiCustomModelConfig {
  if (metadata) return modelFromMetadata(id, metadata)

  // 种子先于名字启发式:deepseek-flash 这个现名不长 "v4" 字样,靠正则猜会把它当成非推理模型。
  const seed = allowDeepSeekSeed ? deepSeekSeed(id) : null
  if (seed) {
    const isPro = id.toLowerCase() === 'deepseek-v4-pro'
    return {
      id,
      name: isPro ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash',
      reasoning: seed.reasoning,
      input: ['text'],
      cost: { ...seed.cost },
      contextWindow: seed.contextWindow,
      maxTokens: seed.maxTokens,
      thinkingLevelMap: {
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
      },
    }
  }
  const reasoning = isGatewayReasoningModel(id)
  if (!reasoning) return { id, name: id }
  return { id, name: id, reasoning: true, compat: { supportsReasoningEffort: true } }
}

/**
 * Pi 对 models.json 里没写的字段用的默认值，镜像 pi-coding-agent
 * core/provider-composer.js。渲染层补出来的条目要和 Pi 真正注册后的一致。
 */
export const PI_CUSTOM_MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  reasoning: false,
  input: ['text'] as Array<'text' | 'image'>,
} as const
