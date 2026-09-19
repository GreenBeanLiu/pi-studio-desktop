import { randomUUID } from 'crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { loadSettings } from './settings'
import { PiRunTimeoutError, runPromptToSettled, type PiAgentRunHandle } from './pi-runtime'
import { runtimeHost } from './runtime-host'
import { describeDeniedApprovals } from './approval-gateway'
import { writeRoutineArtifact } from './routine-artifact'
import { prepareReviewedWebSearchExtension } from './web-search-extension'
import { prepareReviewedWorkspaceMemoryExtension } from './workspace-memory'
import { generateImage } from './image-gen'
import { cloud3dGenerate } from './model3d'
import { formatAppIconWarning, generateAppIconBundle } from './app-icon-bundle'
import { runDressupWorkflow } from './dressup'
import { sendToChannel, createFeishuDoc, createWechatDraft, type Channel } from './channels'
import { appendAppLog } from './app-log'
import { latestAssistantFailure, latestAssistantText, type AgentMessage } from './agent-message'
import { readRoutineMaterialFolder } from './routine-material-folder'
import { inferRoutineImageRole, selectWechatImageAssets } from './routine-assets'
import { cloudFetch } from './cloud-fetch'
import { RoutineNodeRegistry, type RoutineNodeContext } from './routine-node-registry'
import { routineNodeSchemas, type RoutineNodeMap, type RoutineStep, type StepProduct } from './routine-schema'
import {
  MAX_STEP_OUTPUT_CHARS,
  REVIEW_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  WorkflowCancelledError,
  broadcast,
  cancelPendingReviews,
  pendingReviews,
  throwIfWorkflowCancelled,
} from './routine-runtime'
import type { Routine, RoutineReviewRequest } from './routines'

/**
 * 例程的节点执行器:每个 step 就是一个 `run*Step`,以及它们共用的插值、取图、超时助手。
 *
 * 从 routines.ts 抽出来(2026-09-19)。这里只管「一个节点怎么跑」,不碰存储、调度、IPC
 * 和 run engine;取消信号/广播/审核队列在 routine-runtime.ts。Routine 是 type-only import
 * (routines.ts → routine-steps.ts 只有值依赖,运行时不成环)。
 */

export type RunContext = {
  routine: Routine
  triggerTime: string
  /** 可直接进文件名的时间戳:{{trigger.time}} 是本地化文本,带冒号和斜杠,进不了路径。 */
  triggerStamp: string
  products: Map<string, StepProduct> // key = step name
  prev?: StepProduct
}

/** YYYYMMDD-HHmmss,本地时区。Windows 也能当目录名。 */
export function pathStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 替换模板里的 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} /
 * {{routine.name}} / {{routine.workspace}} / {{routine.input}} / {{trigger.time}}。
 * 未知变量原样保留,让错误在结果里可见而不是被吞掉。
 */
function interpolate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token: string) => {
    if (token === 'prev.output') return ctx.prev?.output ?? whole
    if (token === 'prev.imageUrl') return ctx.prev?.imageUrl ?? whole
    if (token === 'routine.name') return ctx.routine.name
    if (token === 'routine.workspace') return ctx.routine.workspacePath
    if (token === 'routine.input') return ctx.routine.input ?? ''
    if (token === 'trigger.time') return ctx.triggerTime
    if (token === 'trigger.stamp') return ctx.triggerStamp
    if (token.startsWith('steps.')) {
      const rest = token.slice('steps.'.length)
      const dot = rest.lastIndexOf('.')
      if (dot <= 0) return whole
      const name = rest.slice(0, dot)
      const field = rest.slice(dot + 1)
      const product = ctx.products.get(name)
      if (!product) return whole
      if (field === 'output') return product.output
      if (field === 'imageUrl') return product.imageUrl ?? whole
    }
    return whole
  })
}

const hasPreviousProductReference = (text: string): boolean => /\{\{\s*(?:prev\.|steps\.)/.test(text)

/** agent 节点专属:RpcClient 只在第一次遇到 agent 节点时才拉起(纯生图/通知流程不需要 API Key) */
export type AgentSession = {
  client: PiAgentRunHandle | null
  startupCleanup: (() => Promise<void>) | null
}

async function ensureAgentClient(
  routine: Routine,
  session: AgentSession,
  signal: AbortSignal,
): Promise<NonNullable<AgentSession['client']>> {
  if (session.client) return session.client
  const settings = loadSettings()
  const extensions = [
    prepareReviewedWorkspaceMemoryExtension(),
    prepareReviewedWebSearchExtension(!!settings.tavilyApiKey),
  ].filter((extension): extension is string => extension !== null)
  const { client } = await runtimeHost.start('routine', routine.workspacePath, {
    extensions,
    signal,
    onOwned: (cleanup) => {
      session.startupCleanup = cleanup
    },
    audit: {
      routineId: routine.id,
      routine: routine.name,
    },
  })
  session.client = client
  session.startupCleanup = null
  return client
}

async function runAgentStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  session: AgentSession,
  markTimeout: () => void,
  signal: AbortSignal,
): Promise<StepProduct> {
  const client = await ensureAgentClient(routine, session, signal)
  throwIfWorkflowCancelled(signal)
  // The client outlives one step, so only this step's denials belong in its output.
  const deniedBefore = client.deniedApprovals().length
  const cancelAgent = (): void => {
    void client.cancel('workflow cancelled').catch(() => {})
  }
  signal.addEventListener('abort', cancelAgent, { once: true })
  let prompt = interpolate(step.prompt ?? '', ctx)
  // 兼容老流程:prompt 里没写变量时,自动把上一步输出接在后面
  if (!hasPreviousProductReference(step.prompt ?? '') && ctx.prev) {
    prompt = `${prompt}\n\nPrevious step result:\n${ctx.prev.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`
  }
  try {
    await runPromptToSettled(client, prompt, RUN_TIMEOUT_MS)
  } catch (err) {
    if (err instanceof PiRunTimeoutError) {
      markTimeout()
      throw new Error(`执行超时(${RUN_TIMEOUT_MS / 60000} 分钟)`, {
        cause: err,
      })
    }
    if (signal.aborted) throw new WorkflowCancelledError()
    throw err
  } finally {
    signal.removeEventListener('abort', cancelAgent)
  }
  throwIfWorkflowCancelled(signal)
  const messages = (await client.getMessages()) as AgentMessage[]
  const denials = client.deniedApprovals().slice(deniedBefore)
  if (denials.length > 0) {
    appendAppLog('warn', 'routine.approval', 'Denied approvals in an unattended routine step', {
      routineId: routine.id,
      step: step.name,
      denials,
    })
  }
  const denied = describeDeniedApprovals(denials)
  const text = latestAssistantText(messages)
  // 没有文本产出时不能塞个占位符糊弄过去。它会被当成这一步的正文往下走:审核节点
  // 拿它当 preview(于是弹出一屏没法审的东西),{{steps.X.output}} 也会把它原样插进
  // 后面的提示词 —— 表情包那条就是这样把「(no text output)」当策划案喂给生图的。
  // 审批被拒是例外:那段说明本身就是这一步的产出,留着。
  if (!text) {
    if (!denied) {
      // 上游报错时 pi 把原因写在消息的 errorMessage 里,光说「没有产出」
      // 会让人去查提示词,而真正的毛病可能是网关 502 或模型不存在。
      const failure = latestAssistantFailure(messages)
      throw new Error(
        failure
          ? `「${step.name}」没有产出任何文本:${failure}`
          : `「${step.name}」没有产出任何文本,后面的步骤拿不到可用的输入`,
      )
    }
    return { output: denied.slice(0, MAX_STEP_OUTPUT_CHARS) }
  }
  return {
    output: (denied ? `${text}\n\n${denied}` : text).slice(0, MAX_STEP_OUTPUT_CHARS),
  }
}

/**
 * 生图节点的参考图。留空就是文生图(不像 model3d/app-icon 那样默认吃上一步的图 ——
 * 那会让每个生图节点都悄悄变成改图)。已经是公网图就直接透传给云端,
 * 省掉「下载成 data URL 再上传回 R2」这一趟;工作区内的相对路径才需要读盘。
 */
export async function resolveImagegenReference(
  step: RoutineStep,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const raw = (step.imageRef ?? '').trim()
  if (!raw) return undefined
  const reference = interpolate(raw, ctx).trim()
  if (!reference) return undefined
  if (reference.includes('{{')) throw new Error(`生图节点的参考图没有解析出来: ${reference}`)
  if (/^https?:\/\//i.test(reference)) return [reference]
  return [await routineImageDataUrl(ctx.routine.workspacePath, reference, signal)]
}

async function runImagegenStep(step: RoutineStep, ctx: RunContext, signal: AbortSignal): Promise<StepProduct> {
  const prompt = interpolate(step.prompt ?? '', ctx)
  if (!prompt.trim()) throw new Error('生图节点的提示词为空')
  const referenceUrls = await resolveImagegenReference(step, ctx, signal)
  const result = await generateImage(
    {
      prompt,
      // 老 routine 数据可能还存着 'comfy':本地引擎已移除,统一回退云端
      engine: step.engine === 'comfy' || !step.engine ? 'openai' : step.engine,
      ...(referenceUrls ? { referenceUrls } : {}),
      ...(step.size ? { size: step.size } : {}),
      downloadResult: false,
    },
    signal,
  )
  if ('error' in result) throw new Error(result.error)
  const uri = result.publicUrl ?? result.dataUrl
  return {
    output: result.publicUrl ?? '(图片已生成,无公网链接)',
    ...(result.publicUrl ? { imageUrl: result.publicUrl } : {}),
    ...(!result.publicUrl && result.dataUrl ? { imageDataUrl: result.dataUrl } : {}),
    ...(uri
      ? {
          images: [
            {
              id: `generated:${step.id}`,
              kind: 'image' as const,
              source: 'generated' as const,
              name: step.name,
              role: inferRoutineImageRole(step.name),
              uri,
            },
          ],
        }
      : {}),
  }
}

async function runAppIconStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<StepProduct> {
  const source = interpolate((step.imageRef ?? '{{prev.imageUrl}}').trim(), ctx).trim()
  if (!source || source.includes('{{')) throw new Error('应用图标节点需要上游生图链接或工作区内的母图路径')
  const outputPath = interpolate(
    step.path?.trim() || '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}',
    ctx,
  )
  const result = await generateAppIconBundle(
    {
      source,
      workspacePath: routine.workspacePath,
      outputPath,
      appName: interpolate(step.appName?.trim() || '', ctx),
      backgroundColor: interpolate(step.backgroundColor?.trim() || '', ctx),
      platforms: step.platforms?.length
        ? step.platforms
        : ['android', 'ios', 'macos', 'windows'],
      keepHistory: step.keepHistory,
    },
    signal,
  )
  const cleaned = result.removedHistory.length
    ? `\n\n按保留上限清理了 ${result.removedHistory.length} 次历史生成: ${result.removedHistory.join('、')}`
    : ''
  return {
    output: `已生成 ${result.fileCount} 个应用图标资源文件: ${result.archivePath}${result.warnings.length ? `\n\n检测警告:\n${result.warnings.map((warning) => `- ${formatAppIconWarning(warning)}`).join('\n')}` : ''}${cleaned}`,
    artifactPath: result.archivePath,
  }
}

function runFolderInputStep(routine: Routine, step: RoutineStep, ctx: RunContext): StepProduct {
  const folderPath = interpolate(step.path?.trim() ?? '', ctx)
  if (!folderPath)
    return {
      output: '未配置本地素材文件夹，本次仅使用后续检索和生成内容。',
      images: [],
    }
  const materials = readRoutineMaterialFolder(routine.workspacePath, folderPath)
  const warnings = materials.warnings.length
    ? `\n\n## 读取提示\n${materials.warnings.map((warning) => `- ${warning}`).join('\n')}`
    : ''
  return {
    output: `${materials.text || '素材文件夹中没有可读取的文本。'}${warnings}`,
    images: materials.images,
  }
}

async function runExportStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<StepProduct> {
  const content = ctx.prev?.output ?? ''
  if (!content.trim()) throw new Error('导出节点没有可写入的上一步内容')
  const format = step.format ?? 'markdown'
  const requestedPath = interpolate(step.path?.trim() || `.pi-studio/articles/${Date.now()}-article`, ctx)
  throwIfWorkflowCancelled(signal)
  const artifact = writeRoutineArtifact(routine.workspacePath, requestedPath, format, content)
  return { output: artifact.path, artifactPath: artifact.path }
}

/** 图/文 → 3D 节点:有上游图(imageRef 默认 {{prev.imageUrl}})就图生 3D,否则用 prompt 文生 3D;glb 存进工作区。 */
async function runModel3dStep(step: RoutineStep, ctx: RunContext, signal: AbortSignal): Promise<StepProduct> {
  const prompt = interpolate(step.prompt ?? '', ctx).trim()
  const imageRef = interpolate((step.imageRef ?? '{{prev.imageUrl}}').trim(), ctx).trim()
  const imageUrl = /^https?:\/\//i.test(imageRef) ? imageRef : undefined
  if (!imageUrl && !prompt) throw new Error('3D 节点需要上游图片(imageRef)或文字提示词')
  const { modelUrl, thumbnailUrl } = await cloud3dGenerate(
    {
      ...(imageUrl ? { imageUrl } : { prompt }),
      provider: step.provider ?? 'tripo',
      options: { texture: true },
    },
    signal,
  )
  const dir = join(ctx.routine.workspacePath, '.pi-studio', 'models')
  mkdirSync(dir, { recursive: true })
  const safe =
    step.name
      .trim()
      .replace(/[^\w一-龥-]+/g, '_')
      .slice(0, 40) || 'model'
  const glbPath = join(dir, `${Date.now()}-${safe}.glb`)
  const res = await cloudFetch(modelUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  })
  if (!res.ok) throw new Error(`下载模型失败 HTTP ${res.status}`)
  writeFileSync(glbPath, Buffer.from(await res.arrayBuffer()))
  return {
    output: glbPath,
    artifactPath: glbPath,
    ...(thumbnailUrl ? { imageUrl: thumbnailUrl } : {}),
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

async function routineImageDataUrl(workspacePath: string, reference: string, signal: AbortSignal): Promise<string> {
  if (/^data:image\//i.test(reference)) return reference
  if (/^https?:\/\//i.test(reference)) {
    const response = await cloudFetch(reference, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    })
    if (!response.ok) throw new Error(`下载工作流图片失败 HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!contentType.startsWith('image/')) throw new Error('工作流图片 URL 没有返回图片')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 20 * 1024 * 1024) throw new Error('工作流图片超过 20MB')
    return `data:${contentType};base64,${bytes.toString('base64')}`
  }
  const root = resolve(workspacePath)
  const target = isAbsolute(reference) ? resolve(reference) : resolve(root, reference)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('工作流图片必须位于当前工作区内')
  }
  if (!existsSync(target)) throw new Error(`找不到工作流图片: ${reference}`)
  const mime = IMAGE_MIME_BY_EXTENSION[extname(target).toLowerCase()]
  if (!mime) throw new Error('工作流图片仅支持 PNG、JPG 或 WebP')
  const bytes = readFileSync(target)
  if (bytes.length > 20 * 1024 * 1024) throw new Error('工作流图片超过 20MB')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function runDressupStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<StepProduct> {
  const personRef = interpolate(step.personRef ?? '', ctx).trim()
  const garmentRef = interpolate(step.garmentRef ?? '', ctx).trim()
  if (!personRef || !garmentRef || personRef.includes('{{') || garmentRef.includes('{{')) {
    throw new Error('换装视频节点需要人物图和服装图')
  }
  const [personDataUrl, garmentDataUrl] = await Promise.all([
    routineImageDataUrl(routine.workspacePath, personRef, signal),
    routineImageDataUrl(routine.workspacePath, garmentRef, signal),
  ])
  const result = await runDressupWorkflow(
    {
      personDataUrl,
      garmentDataUrl,
      firstFrameDataUrl: personDataUrl,
      prompt: interpolate(step.prompt ?? '', ctx).trim() || undefined,
    },
    signal,
  )
  if ('error' in result) throw new Error(result.error)
  return {
    output: result.cloudVideoUrl ?? result.filePath ?? result.videoUrl,
    ...(result.filePath ? { artifactPath: result.filePath } : {}),
  }
}

async function runReviewStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<StepProduct> {
  throwIfWorkflowCancelled(signal)
  const reviewId = randomUUID()
  const previous = ctx.prev
  const request: RoutineReviewRequest = {
    reviewId,
    routineId: routine.id,
    routineName: routine.name,
    stepId: step.id,
    stepName: step.name,
    message: interpolate(step.message?.trim() || '请检查上一步生成的公众号草稿，确认后继续。', ctx),
    ...(previous?.artifactPath ? { artifactPath: previous.artifactPath } : {}),
    ...(previous?.imageUrl || previous?.imageDataUrl ? { imageUrl: previous.imageUrl ?? previous.imageDataUrl } : {}),
    preview: (previous?.output ?? '').slice(0, 8000),
  }

  return new Promise<StepProduct>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReviews.delete(reviewId)
      broadcast('routines:reviewCancelled', {
        reviewId,
        routineId: routine.id,
        reason: '人工审核超时，工作流已停止',
      })
      reject(new Error('人工审核超时，工作流已停止'))
    }, REVIEW_TIMEOUT_MS)
    pendingReviews.set(reviewId, {
      routineId: routine.id,
      request,
      timer,
      approve: () => {
        clearTimeout(timer)
        pendingReviews.delete(reviewId)
        resolve(previous ?? { output: '' })
      },
      reject: (error) => {
        clearTimeout(timer)
        pendingReviews.delete(reviewId)
        reject(error)
      },
    })
    if (signal.aborted) {
      cancelPendingReviews(routine.id, '工作流已取消')
      return
    }
    broadcast('routines:reviewRequested', request)
  })
}

async function runNotifyStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
  signal: AbortSignal,
): Promise<StepProduct> {
  const channel = channels.find((c) => c.id === step.channelId)
  if (!channel || channel.type === 'wechat-official')
    throw new Error('通知节点需要可发送的通知渠道,微信公众号渠道请使用草稿节点')
  const markdown = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  const imageUrls = [...ctx.products.values()].map((p) => p.imageUrl).filter((u): u is string => !!u)
  await sendToChannel(
    channel,
    {
      title: `${routine.name} · ${step.name}`,
      status: 'info',
      markdown,
      ...(imageUrls.length ? { imageUrls } : {}),
    },
    signal,
  )
  return { output: `已发送到「${channel.name}」` }
}

async function runFeishuDocStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
  signal: AbortSignal,
): Promise<StepProduct> {
  const channel =
    (step.channelId ? channels.find((c) => c.id === step.channelId) : undefined) ??
    channels.find((c) => c.type === 'feishu-app')
  if (!channel || channel.type !== 'feishu-app')
    throw new Error('存飞书文档需要一个「飞书应用」渠道(设置→通知渠道),且应用需开通 docx:document 权限')
  // 正文来源:默认上一步;模板里可用 step.message 指定,如 {{steps.写正文.output}}
  const content = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  if (!content.trim()) throw new Error('没有可写入飞书文档的正文内容')
  const title = interpolate(step.path?.trim() || `${routine.name} · {{trigger.time}}`, ctx)
  // 文章配图只来自 imagegen 节点，避免把其它节点/通知上下文中的图片带进文档。
  const imageUrls = routine.steps
    .filter((candidate) => candidate.type === 'imagegen')
    .map((candidate) => ctx.products.get(candidate.name))
    .filter((product): product is StepProduct => !!product)
    .map((product) => product.imageUrl ?? product.imageDataUrl)
    .filter((url): url is string => !!url)
  const { url } = await createFeishuDoc(channel, title, content, imageUrls, signal)
  return { output: `[打开飞书文档](${url})`, artifactPath: url }
}

async function runWechatDraftStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
  signal: AbortSignal,
): Promise<StepProduct> {
  const channel =
    (step.channelId ? channels.find((candidate) => candidate.id === step.channelId) : undefined) ??
    channels.find((candidate) => candidate.type === 'wechat-official')
  if (!channel || channel.type !== 'wechat-official')
    throw new Error('微信公众号草稿需要一个「微信公众号」渠道(设置→通知渠道)')
  const content = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  if (!content.trim()) throw new Error('没有可写入微信公众号草稿的正文内容')
  const title = interpolate(step.path?.trim() || `${routine.name} · {{trigger.time}}`, ctx)
  const assets = routine.steps
    .map((candidate) => ctx.products.get(candidate.name))
    .filter((product): product is StepProduct => !!product)
    .flatMap((product) => product.images ?? [])
  const selected = selectWechatImageAssets(assets)
  if (!selected.cover) throw new Error('微信公众号草稿至少需要一张素材图片或生成图片作为封面')
  const draft = await createWechatDraft(
    channel,
    title,
    content,
    {
      cover: selected.cover.uri,
      inline: selected.inline.map((asset) => asset.uri),
    },
    signal,
  )
  return {
    output: `微信公众号草稿已创建: ${draft.title}（media_id: ${draft.mediaId}）`,
    artifactPath: draft.mediaId,
  }
}

export type RoutineNodeDependencies = {
  routine: Routine
  runContext: RunContext
  channels: Channel[]
  session: AgentSession
  markTimeout: () => void
}

export function createRoutineNodeRegistry(
  dependencies: RoutineNodeDependencies,
): RoutineNodeRegistry<RoutineNodeMap, RoutineNodeContext> {
  const { routine, runContext, channels, session, markTimeout } = dependencies
  return new RoutineNodeRegistry<RoutineNodeMap, RoutineNodeContext>()
    .register({
      type: 'folder-input',
      ...routineNodeSchemas('folder-input'),
      presentation: { label: '素材文件夹', kind: 'source' },
      execute: (step) => runFolderInputStep(routine, step, runContext),
    })
    .register({
      type: 'imagegen',
      ...routineNodeSchemas('imagegen'),
      presentation: { label: '生成图片', kind: 'transform' },
      execute: (step, context) => runImagegenStep(step, runContext, context.signal),
    })
    .register({
      type: 'app-icon',
      ...routineNodeSchemas('app-icon'),
      presentation: { label: '应用图标', kind: 'sink' },
      execute: (step, context) => runAppIconStep(routine, step, runContext, context.signal),
    })
    .register({
      type: 'model3d',
      ...routineNodeSchemas('model3d'),
      presentation: { label: '生成 3D', kind: 'transform' },
      execute: (step, context) => runModel3dStep(step, runContext, context.signal),
    })
    .register({
      type: 'dressup',
      ...routineNodeSchemas('dressup'),
      presentation: { label: '换装视频', kind: 'transform' },
      execute: (step, context) => runDressupStep(routine, step, runContext, context.signal),
    })
    .register({
      type: 'notify',
      ...routineNodeSchemas('notify'),
      presentation: { label: '发送通知', kind: 'side-effect' },
      execute: (step, context) => runNotifyStep(routine, step, runContext, channels, context.signal),
    })
    .register({
      type: 'review',
      ...routineNodeSchemas('review'),
      presentation: { label: '人工审核', kind: 'wait' },
      execute: async (step, context) => {
        context.waiting('human-review')
        const product = await runReviewStep(routine, step, runContext, context.signal)
        context.resumed('human-review')
        return product
      },
    })
    .register({
      type: 'export',
      ...routineNodeSchemas('export'),
      presentation: { label: '导出文件', kind: 'sink' },
      execute: (step, context) => runExportStep(routine, step, runContext, context.signal),
    })
    .register({
      type: 'feishu-doc',
      ...routineNodeSchemas('feishu-doc'),
      presentation: { label: '飞书文档', kind: 'side-effect' },
      execute: (step, context) => runFeishuDocStep(routine, step, runContext, channels, context.signal),
    })
    .register({
      type: 'wechat-draft',
      ...routineNodeSchemas('wechat-draft'),
      presentation: { label: '微信草稿', kind: 'side-effect' },
      execute: (step, context) => runWechatDraftStep(routine, step, runContext, channels, context.signal),
    })
    .register({
      type: 'agent',
      ...routineNodeSchemas('agent'),
      presentation: { label: 'Agent', kind: 'transform' },
      execute: (step, context) => runAgentStep(routine, step, runContext, session, markTimeout, context.signal),
    })
}
