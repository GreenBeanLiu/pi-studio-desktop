import type {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  GrokImageAspectRatio,
  GrokImageResolution,
  ImageGenBackground,
  ImageGenEngine,
  ImageGenModeration,
  ImageGenOutputFormat,
  ImageGenProviderStyle,
  ImageGenQuality,
  ImageGenResponseFormat,
  ImageGenSize,
  ImageModel,
} from '../lib/api'

// 本地 ComfyUI 引擎已移除(2026-07-17):生图全走服务端
export type ImageModelDefinition = {
  key: ImageModel
  label: string
  description: string
  group: '云端模型'
  engine: ImageGenEngine
  cloudModel?: Exclude<ImageModel, 'gpt-image-2'>
  parameters: 'gpt' | 'grok' | 'nano'
  acceptsImage: boolean
  acceptsMask: boolean
}

export const IMAGE_MODELS: readonly ImageModelDefinition[] = [
  {
    key: 'gpt-image-2',
    label: 'GPT Image 2',
    description: '文生图 / 改图 / 蒙版',
    group: '云端模型',
    engine: 'openai',
    parameters: 'gpt',
    acceptsImage: true,
    acceptsMask: true,
  },
  // 2026-10-22:Nano Banana 2.1 经 APIMart(Ext 版,1K ¥0.09/张),顶替 10-20 下线的 Gemini 3 Pro。
  // 能吃参考图(电商换场景/换模特就靠它),不做蒙版;出图 ~50 秒。
  {
    key: 'nano-banana-2.1',
    label: 'Nano Banana 2.1',
    description: '文生图 / 改图 · 保留产品细节',
    group: '云端模型',
    engine: 'gemini',
    cloudModel: 'nano-banana-2.1',
    parameters: 'nano',
    acceptsImage: true,
    acceptsMask: false,
  },
  // 2026-09-05 恢复:grok 从 3A 搬到 heilovehei 的 grok 分组后重新可用。
  // 都不吃参考图(这家的 grok 只有文生图),出图 5-10 秒,比 gpt-image-2 的 ~29 秒快得多。
  {
    key: 'grok-imagine-image',
    label: 'Grok Image',
    description: '标准文生图 · 快',
    group: '云端模型',
    engine: 'grok',
    cloudModel: 'grok-imagine-image',
    parameters: 'grok',
    acceptsImage: false,
    acceptsMask: false,
  },
  {
    key: 'grok-imagine-image-quality',
    label: 'Grok Image 高质量',
    description: '高质量文生图',
    group: '云端模型',
    engine: 'grok',
    cloudModel: 'grok-imagine-image-quality',
    parameters: 'grok',
    acceptsImage: false,
    acceptsMask: false,
  },
  {
    key: 'grok-imagine-image-2.0',
    label: 'Grok Image 2.0',
    description: '新版文生图 · 会改写提示词',
    group: '云端模型',
    engine: 'grok',
    cloudModel: 'grok-imagine-image-2.0',
    parameters: 'grok',
    acceptsImage: false,
    acceptsMask: false,
  },
] as const

const MODEL_BY_KEY = new Map(IMAGE_MODELS.map((model) => [model.key, model]))

export function imageModel(key: ImageModel): ImageModelDefinition {
  const model = MODEL_BY_KEY.get(key)
  if (!model) throw new Error(`Unknown image model: ${key}`)
  return model
}

export function defaultImageModel(engine: string | undefined): ImageModel {
  if (engine === 'grok') return 'grok-imagine-image'
  return 'gpt-image-2'
}

export type ImageOutputSettings = {
  count: number
  size: ImageGenSize
  quality: ImageGenQuality
  background: ImageGenBackground
  outputFormat: ImageGenOutputFormat
  outputCompression: number
  moderation: ImageGenModeration
  responseFormat: ImageGenResponseFormat
  providerStyle: ImageGenProviderStyle
  requestUser: string
  advanced: boolean
  grokAspectRatio: GrokImageAspectRatio
  grokImageSize: GrokImageResolution
  nanoAspectRatio: GeminiImageAspectRatio
  nanoImageSize: GeminiImageResolution
}

export type ImageGenerationRequest = {
  prompt: string
  engine: ImageGenEngine
  batchId: string
  model?: ImageModelDefinition['cloudModel']
  referenceUrls?: string[]
  maskDataUrl?: string
  size?: ImageGenSize
  aspectRatio?: GrokImageAspectRatio | GeminiImageAspectRatio
  imageSize?: GrokImageResolution | GeminiImageResolution
  n: number
  quality?: ImageGenQuality
  background?: ImageGenBackground
  outputFormat?: ImageGenOutputFormat
  outputCompression?: number
  moderation?: ImageGenModeration
  responseFormat?: ImageGenResponseFormat
  providerStyle?: ImageGenProviderStyle
  user?: string
}

export function buildImageGenerationRequest(args: {
  modelKey: ImageModel
  prompt: string
  batchId: string
  referenceUrls?: string[]
  maskDataUrl?: string
  output: ImageOutputSettings
}): ImageGenerationRequest {
  const model = imageModel(args.modelKey)
  const references = model.acceptsImage ? args.referenceUrls : undefined
  const mask = model.acceptsMask ? args.maskDataUrl : undefined
  const prompt = args.prompt.trim() || (references?.length
    ? '基于输入图片生成一个高质量变体，保留主体与构图'
    : '')
  if (!prompt) throw new Error('请输入文字或上传图片')
  const n = mask ? 1 : Math.max(1, Math.min(4, args.output.count))

  const base: ImageGenerationRequest = {
    prompt,
    engine: model.engine,
    batchId: args.batchId,
    ...(model.cloudModel ? { model: model.cloudModel } : {}),
    ...(references?.length ? { referenceUrls: references } : {}),
    ...(mask ? { maskDataUrl: mask } : {}),
    n,
  }

  if (model.parameters === 'gpt') {
    return {
      ...base,
      size: args.output.size,
      quality: args.output.quality,
      ...(args.output.advanced ? {
        background: args.output.background,
        outputFormat: args.output.outputFormat,
        ...(args.output.outputFormat !== 'png' ? { outputCompression: args.output.outputCompression } : {}),
        moderation: args.output.moderation,
        responseFormat: args.output.responseFormat,
        providerStyle: args.output.providerStyle,
        ...(args.output.requestUser.trim() ? { user: args.output.requestUser.trim() } : {}),
      } : {}),
    }
  }
  if (model.parameters === 'grok') {
    return {
      ...base,
      aspectRatio: args.output.grokAspectRatio,
      imageSize: args.output.grokImageSize,
    }
  }
  if (model.parameters === 'nano') {
    return {
      ...base,
      aspectRatio: args.output.nanoAspectRatio,
      imageSize: args.output.nanoImageSize,
    }
  }
  return base
}
