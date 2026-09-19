import type { RoutineArtifactFormat } from './routine-artifact'
import type { AppIconPlatform } from './app-icon-spec'
import type { RoutineImageAsset } from './routine-assets'
import { isRoutineStepComplete } from './routine-step-validation'
import type {
  ImageGenSize as SharedImageGenSize,
  RoutineStepType as SharedRoutineStepType,
} from '../shared/ipc/contract'

/**
 * 例程节点的类型与输入/输出 schema。
 *
 * 从 routines.ts 抽出来(2026-09-19):这一块是纯类型 + 纯校验,不碰 electron、存储或执行,
 * 是那个 1573 行文件里最独立的一段。routineStepSchema / stepProductSchema 由 routines.ts
 * 继续 re-export,老的 `import ... from './routines'` 不用改。
 */

export type RoutineStepType = SharedRoutineStepType

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  /** agent / imagegen:提示词(支持 {{…}} 变量) */
  prompt?: string
  /** imagegen:引擎(本地 ComfyUI 已移除,老数据里的 'comfy' 运行时回退云端) */
  engine?: 'openai' | 'comfy'
  /** notify:目标渠道 id */
  channelId?: string
  /** notify:消息模板(支持 {{…}} 变量),空则默认发上一步输出 */
  message?: string
  /** export:工作区内的相对产物路径;没有扩展名时按 format 自动补全 */
  path?: string
  /** export:Markdown 原文或公众号 HTML 片段 */
  format?: RoutineArtifactFormat
  /** model3d:图生 3D 服务商 */
  provider?: 'tripo' | 'hi3d'
  /**
   * model3d:输入图的模板(默认 {{prev.imageUrl}});解析成 URL 走图生 3D,否则用 prompt 文生 3D。
   * app-icon:母图。imagegen:可选参考图,留空即文生图。
   */
  imageRef?: string
  /** imagegen:输出尺寸,留空走服务端默认 */
  size?: SharedImageGenSize
  /** app-icon:导出包内显示的应用名称(支持 {{…}} 变量) */
  appName?: string
  /** app-icon:需要导出的目标平台 */
  platforms?: AppIconPlatform[]
  /** app-icon:需要不透明底图的平台使用的品牌背景色 */
  backgroundColor?: string
  /** app-icon:同一个工作流最多保留几次生成;留空或 <=0 就一直堆着 */
  keepHistory?: number
  /** dressup:人物图与服装图，支持模板、工作区相对路径、data URL 或公网 URL */
  personRef?: string
  garmentRef?: string
}

/** 每个节点跑完后的产物,供后续节点用 {{…}} 引用 */
export type StepProduct = {
  output: string
  imageUrl?: string
  imageDataUrl?: string
  artifactPath?: string
  images?: RoutineImageAsset[]
}

export type RoutineNodeMap = {
  [K in RoutineStepType]: {
    input: RoutineStep & { type: K }
    output: StepProduct
  }
}

export function routineStepSchema<K extends RoutineStepType>(type: K): { parse: (value: unknown) => RoutineStep & { type: K } } {
  return {
    parse: (value) => {
      if (!value || typeof value !== 'object') {
        throw new Error(`工作流节点输入与定义不匹配: ${type}`)
      }
      const step = value as Partial<RoutineStep>
      const optionalStrings: Array<keyof RoutineStep> = [
        'prompt',
        'channelId',
        'message',
        'path',
        'imageRef',
        'appName',
        'backgroundColor',
        'personRef',
        'garmentRef',
      ]
      const typedOptionalsValid = optionalStrings.every(
        (key) => step[key] === undefined || typeof step[key] === 'string',
      )
      const platformsValid =
        step.platforms === undefined ||
        (Array.isArray(step.platforms) &&
          step.platforms.every((platform) => ['android', 'ios', 'macos', 'windows'].includes(platform)))
      if (
        step.type !== type ||
        typeof step.id !== 'string' ||
        !step.id ||
        typeof step.name !== 'string' ||
        !typedOptionalsValid ||
        !platformsValid ||
        (step.engine !== undefined && !['openai', 'comfy'].includes(step.engine)) ||
        (step.size !== undefined &&
          !['256x256', '512x512', '1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024', 'auto'].includes(
            step.size,
          )) ||
        (step.provider !== undefined && !['tripo', 'hi3d'].includes(step.provider)) ||
        (step.format !== undefined && !['html', 'markdown'].includes(step.format)) ||
        !isRoutineStepComplete(step as RoutineStep)
      ) {
        throw new Error(`工作流节点输入无效: ${type}`)
      }
      return step as RoutineStep & { type: K }
    },
  }
}

export const stepProductSchema = {
  parse: (value: unknown): StepProduct => {
    if (!value || typeof value !== 'object') {
      throw new Error('工作流节点没有返回有效的 StepProduct')
    }
    const product = value as Partial<StepProduct>
    const optionalStringsValid = [product.imageUrl, product.imageDataUrl, product.artifactPath].every(
      (field) => field === undefined || typeof field === 'string',
    )
    const imagesValid =
      product.images === undefined ||
      (Array.isArray(product.images) &&
        product.images.every(
          (image) =>
            !!image &&
            typeof image.id === 'string' &&
            image.kind === 'image' &&
            ['folder', 'generated'].includes(image.source) &&
            typeof image.name === 'string' &&
            ['cover', 'inline', 'reference'].includes(image.role) &&
            typeof image.uri === 'string',
        ))
    if (typeof product.output !== 'string' || !optionalStringsValid || !imagesValid) {
      throw new Error('工作流节点没有返回有效的 StepProduct')
    }
    return product as StepProduct
  },
}

export function routineNodeSchemas<K extends RoutineStepType>(type: K) {
  return { inputSchema: routineStepSchema(type), outputSchema: stepProductSchema }
}
