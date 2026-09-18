import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { loadSettings } from './settings'
import { PiRunTimeoutError, runPromptToSettled, type PiAgentRunHandle } from './pi-runtime'
import { runtimeHost } from './runtime-host'
import { describeDeniedApprovals } from './approval-gateway'
import { writeRoutineArtifact, type RoutineArtifactFormat } from './routine-artifact'
import { prepareReviewedWebSearchExtension } from './web-search-extension'
import { prepareReviewedWorkspaceMemoryExtension } from './workspace-memory'
import { generateImage } from './image-gen'
import { cloud3dGenerate } from './model3d'
import { formatAppIconWarning, generateAppIconBundle } from './app-icon-bundle'
import { runDressupWorkflow } from './dressup'
import type { AppIconPlatform } from './app-icon-spec'
import { loadChannels, sendToChannel, createFeishuDoc, createWechatDraft, type Channel } from './channels'
import { appendAppLog, normalizeError } from './app-log'
import { remoteControl } from './remote-control'
import { parseRoutineSave } from '../shared/ipc/validators'
import { isRoutineStepComplete } from './routine-step-validation'
import { latestAssistantFailure, latestAssistantText, type AgentMessage } from './agent-message'
import type {
  ImageGenSize as SharedImageGenSize,
  RoutineStepType as SharedRoutineStepType,
} from '../shared/ipc/contract'
import { readRoutineMaterialFolder } from './routine-material-folder'
import { inferRoutineImageRole, selectWechatImageAssets, type RoutineImageAsset } from './routine-assets'
import { configureRoutineCloudOutbox, queueRoutineCloudSync, routineSyncOrigin } from './routine-cloud-sync'
import { RoutineDatabase, RoutineSqliteUnavailableError } from './routine-database'
import type { RoutineRunEventType } from './routine-database'
import { JsonRoutineDeleteOutbox } from './routine-delete-outbox'
import { RoutineNodeRegistry } from './routine-node-registry'
import {
  RoutineScheduler,
  dueSlotKey,
  type RoutineExecutionContext,
  type SchedulableSchedule,
} from './routine-scheduler'
import type { RoutineNodeContext } from './routine-node-registry'
import { cloudFetch } from './cloud-fetch'

/**
 * 例行任务(Routines):定时执行一条由类型化节点组成的流水线。
 * 节点类型:agent(pi 会话) / imagegen(生图) / review(人工审核) / export(工作区产物) / notify(推送到某个通知渠道)。
 * 节点间用 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} 传值。
 * agent 节点每次 run spawn 一个全新 RpcClient 子进程(独立 session),跑完即弃 ——
 * 绝不打扰用户当前打开的聊天会话。
 */

export type RoutineSchedule = SchedulableSchedule

export type RoutineNotify = 'always' | 'error' | 'never'

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

export type Routine = {
  id: string
  name: string
  /** 本次运行的固定选题/Brief,支持 {{…}} 变量。 */
  input?: string
  /** Retained only to migrate previously saved single-step routines. */
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  /** 兜底汇总通知发到哪个渠道;空 = 渠道列表第一个 */
  notifyChannelId?: string
  /** 每步跑完就把该步产出推到 notifyChannelId(在飞书/手机上跟进,替代 App 内小预览) */
  pushEachStep?: boolean
  createdAt: number
  lastRunAt?: number
  /** 上次触发的时间槽(防止同一槽位重复触发,也让错过的槽当天补跑) */
  lastSlotKey?: string
}

export type RoutineStepResult = {
  id: string
  name: string
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'skipped'
  /** 该步骤的文本产物(截断) */
  summary: string
  /** imagegen 节点的公网图片链接 */
  imageUrl?: string
  /** export 节点写出的工作区文件 */
  artifactPath?: string
  durationMs: number
}

export type RoutineReviewRequest = {
  reviewId: string
  routineId: string
  routineName: string
  stepId: string
  stepName: string
  message: string
  artifactPath?: string
  imageUrl?: string
  preview: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'interrupted'
  triggerSource?: 'manual' | 'schedule'
  /** 各步骤产物拼接(截断) */
  summary: string
  steps?: RoutineStepResult[]
  error?: string
}

/** 执行过程中广播给渲染进程的单步进度(流程图实时高亮用) */
export type RoutineStepProgress = {
  routineId: string
  stepId: string
  stepIndex: number
  totalSteps: number
  status: 'running' | 'ok' | 'error' | 'timeout' | 'cancelled'
}

type Store = { routines: Routine[]; runs: RoutineRun[] }

const RUN_TIMEOUT_MS = 20 * 60 * 1000
const MAX_RUNS_KEPT = 100
const MAX_CONCURRENT = 2
const MAX_STEP_OUTPUT_CHARS = 60_000
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000
/** 发给手机的运行历史条数和每条正文长度 —— 一帧 WebSocket 装得下,手机上也看得完 */
const REMOTE_RUNS_KEPT = 30
const REMOTE_RUN_SUMMARY_CHARS = 600

const storePath = (): string => join(app.getPath('userData'), 'routines.json')
const databasePath = (): string => join(app.getPath('userData'), 'routines.sqlite3')
const deleteOutboxPath = (): string => join(app.getPath('userData'), 'cloud-sync-outbox.json')
let routineDatabase: RoutineDatabase | null = null
let jsonDeleteOutbox: JsonRoutineDeleteOutbox | null = null

type PendingReview = {
  routineId: string
  // 手机可能在广播之后才连上来(锁屏、切后台、换网),没有原始请求就补不回去
  request: RoutineReviewRequest
  approve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pendingReviews = new Map<string, PendingReview>()
const forcedClosedRunIds = new Set<string>()
const activeRunForceCleanups = new Map<string, () => Promise<void>>()

class WorkflowCancelledError extends Error {
  constructor() {
    super('工作流已取消')
    this.name = 'WorkflowCancelledError'
  }
}

class WorkflowExecutionFailedError extends Error {
  constructor(
    readonly status: 'error' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowExecutionFailedError'
  }
}

function throwIfWorkflowCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkflowCancelledError()
}
// 保留当前运行中工作流的最新节点状态。页面切换会卸载 RoutinesPage，
// 回来时通过 routines:state 恢复这份快照，而不是等下一次事件广播。
const liveStepProgress = new Map<string, Map<string, RoutineStepProgress>>()

/** 桌面和手机走同一条路:审核只能应一次,谁先点谁生效。 */
function respondToReview(
  reviewId: string,
  decision: 'approve' | 'reject',
  comment?: string,
): { ok: true } | { error: string } {
  const pending = pendingReviews.get(reviewId)
  if (!pending) return { error: '审核请求已过期或工作流已结束' }
  if (decision === 'approve') pending.approve()
  else pending.reject(new Error(comment?.trim() || '人工审核拒绝'))
  return { ok: true }
}

function cancelPendingReviews(routineId: string, reason: string): void {
  for (const [reviewId, pending] of pendingReviews) {
    if (pending.routineId !== routineId) continue
    broadcast('routines:reviewCancelled', { reviewId, routineId, reason })
    pending.reject(new Error(reason))
    pendingReviews.delete(reviewId)
  }
}

function normalizeStep(step: Partial<RoutineStep>): RoutineStep {
  const platforms = Array.isArray(step.platforms)
    ? step.platforms.filter(
        (platform): platform is AppIconPlatform =>
          platform === 'android' || platform === 'ios' || platform === 'macos' || platform === 'windows',
      )
    : undefined
  return {
    id: step.id || randomUUID(),
    name: step.name ?? '',
    type: step.type ?? 'agent',
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
    ...(step.engine !== undefined ? { engine: step.engine } : {}),
    ...(step.channelId !== undefined ? { channelId: step.channelId } : {}),
    ...(step.message !== undefined ? { message: step.message } : {}),
    ...(step.path !== undefined ? { path: step.path } : {}),
    ...(step.format !== undefined ? { format: step.format } : {}),
    ...(step.provider !== undefined ? { provider: step.provider } : {}),
    ...(step.imageRef !== undefined ? { imageRef: step.imageRef } : {}),
    ...(step.size !== undefined ? { size: step.size } : {}),
    ...(typeof step.appName === 'string' ? { appName: step.appName } : {}),
    ...(platforms !== undefined ? { platforms } : {}),
    ...(typeof step.backgroundColor === 'string' ? { backgroundColor: step.backgroundColor } : {}),
    ...(typeof step.personRef === 'string' ? { personRef: step.personRef } : {}),
    ...(typeof step.garmentRef === 'string' ? { garmentRef: step.garmentRef } : {}),
  }
}

function loadStore(): Store {
  if (routineDatabase) return routineDatabase.load()
  try {
    if (existsSync(storePath())) {
      const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<Store>
      const routines = (raw.routines ?? []).map((routine) => {
        const current = routine as Routine
        const steps =
          Array.isArray(current.steps) && current.steps.length > 0
            ? current.steps.map(normalizeStep)
            : [normalizeStep({ name: '步骤 1', prompt: current.prompt ?? '' })]
        return { ...current, steps }
      })
      return { routines, runs: raw.runs ?? [] }
    }
  } catch (err) {
    appendAppLog('warn', 'routines.load', 'Failed to load routines store', normalizeError(err))
  }
  return { routines: [], runs: [] }
}

function saveStore(store: Store, deleted?: { origin: string; workflowId: string }): void {
  if (routineDatabase) {
    routineDatabase.save(store, deleted)
  } else {
    if (deleted) jsonDeleteOutbox?.commitDelete(store, deleted.origin, deleted.workflowId)
    else {
      jsonDeleteOutbox?.assertReady()
      writeStoreSnapshot(store)
    }
  }
  queueRoutineCloudSync(store)
}

function writeStoreSnapshot(store: Store): void {
  const target = storePath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(store, null, 2), 'utf8')
  renameSync(temporary, target)
}

export function scheduleLabel(s: RoutineSchedule): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.type) {
    case 'manual':
      return '按需（手动）'
    case 'interval':
      return `每 ${s.minutes} 分钟`
    case 'hourly':
      return `每小时 ${s.minute} 分`
    case 'daily':
      return `每天 ${s.time}`
    case 'weekly':
      return `${days[s.day] ?? '?'} ${s.time}`
  }
}

// ── 变量插值 ─────────────────────────────────────────────────────

/** 每个节点跑完后的产物,供后续节点用 {{…}} 引用 */
type StepProduct = {
  output: string
  imageUrl?: string
  imageDataUrl?: string
  artifactPath?: string
  images?: RoutineImageAsset[]
}

type RoutineNodeMap = {
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

function routineNodeSchemas<K extends RoutineStepType>(type: K) {
  return { inputSchema: routineStepSchema(type), outputSchema: stepProductSchema }
}

type RunContext = {
  routine: Routine
  triggerTime: string
  /** 可直接进文件名的时间戳:{{trigger.time}} 是本地化文本,带冒号和斜杠,进不了路径。 */
  triggerStamp: string
  products: Map<string, StepProduct> // key = step name
  prev?: StepProduct
}

/** YYYYMMDD-HHmmss,本地时区。Windows 也能当目录名。 */
function pathStamp(date: Date): string {
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

// ── 执行器 ───────────────────────────────────────────────────────

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  // 手机也是一块屏。人工审核节点尤其要出去 —— 它是阻塞式的,没人应就超时把整条
  // 工作流拖死,而人多半不在电脑前。
  remoteControl.forwardHostEvent(channel, payload)
}

/** agent 节点专属:RpcClient 只在第一次遇到 agent 节点时才拉起(纯生图/通知流程不需要 API Key) */
type AgentSession = {
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

type RoutineNodeDependencies = {
  routine: Routine
  runContext: RunContext
  channels: Channel[]
  session: AgentSession
  markTimeout: () => void
}

function createRoutineNodeRegistry(
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

async function executeRoutine(
  store: Store,
  routine: Routine,
  triggerSource: 'manual' | 'schedule',
  execution: RoutineExecutionContext,
): Promise<void> {
  const { signal, runId, startedAt } = execution
  let status: RoutineRun['status'] = 'ok'
  let timedOut = false
  let errorMsg: string | undefined
  const stepResults: RoutineStepResult[] = routine.steps.map((step) => ({
    id: step.id,
    name: step.name,
    status: 'skipped',
    summary: '',
    durationMs: 0,
  }))

  const stepProgress = (stepIndex: number, s: RoutineStepProgress['status']): void => {
    const progress = {
      routineId: routine.id,
      stepId: routine.steps[stepIndex].id,
      stepIndex,
      totalSteps: routine.steps.length,
      status: s,
    } satisfies RoutineStepProgress
    const routineProgress = liveStepProgress.get(routine.id) ?? new Map<string, RoutineStepProgress>()
    routineProgress.set(progress.stepId, progress)
    liveStepProgress.set(routine.id, routineProgress)
    broadcast('routines:stepProgress', progress)
  }

  const session: AgentSession = { client: null, startupCleanup: null }
  activeRunForceCleanups.set(runId, async () => {
    cancelPendingReviews(routine.id, '工作流取消宽限期已到，运行已强制关闭')
    if (session.client) await session.client.forceDispose()
    else await session.startupCleanup?.()
  })
  const channels = loadChannels()
  // 每步推送目标:开了 pushEachStep 就用兜底通知那个渠道(或第一个非本地渠道)
  const pushChannel = routine.pushEachStep
    ? (channels.find((c) => c.id === routine.notifyChannelId && c.type !== 'wechat-official') ??
      channels.find((c) => c.type !== 'local' && c.type !== 'wechat-official'))
    : undefined
  const triggeredAt = new Date()
  const ctx: RunContext = {
    routine,
    triggerTime: triggeredAt.toLocaleString(),
    triggerStamp: pathStamp(triggeredAt),
    products: new Map(),
  }
  const journal = (type: RoutineRunEventType, stepId: string | null, payload: Record<string, unknown>): void => {
    routineDatabase?.appendRoutineRunEvent({
      runId,
      workflowId: routine.id,
      type,
      stepId,
      payload,
    })
  }
  journal('run.started', null, {
    routineName: routine.name,
    triggerSource,
    workspacePath: routine.workspacePath,
    stepCount: routine.steps.length,
  })

  const nodes = createRoutineNodeRegistry({
    routine,
    runContext: ctx,
    channels,
    session,
    markTimeout: () => {
      timedOut = true
    },
  })
  const cancelRun = (): void => {
    cancelPendingReviews(routine.id, '工作流已取消')
    void session.client?.cancel('workflow cancelled').catch(() => {})
  }
  signal.addEventListener('abort', cancelRun, { once: true })

  try {
    if (!existsSync(routine.workspacePath)) {
      throw new Error(`工作区不存在: ${routine.workspacePath}`)
    }
    try {
      for (const [index, step] of routine.steps.entries()) {
        throwIfWorkflowCancelled(signal)
        const stepStartedAt = Date.now()
        stepProgress(index, 'running')
        journal('step.started', step.id, {
          position: index,
          name: step.name,
          type: step.type,
          inputRefs: {
            previousStep: ctx.prev ? (routine.steps[index - 1]?.id ?? null) : null,
          },
        })
        try {
          const product = await nodes.execute(step.type, step as RoutineNodeMap[RoutineStepType]['input'], {
            signal,
            waiting: (reason) => {
              execution.waiting()
              journal('run.waiting', step.id, { reason })
            },
            resumed: (reason) => {
              execution.resumed()
              journal('run.running', step.id, { resumedBy: reason })
            },
          })
          throwIfWorkflowCancelled(signal)
          ctx.products.set(step.name, product)
          ctx.prev = product
          stepResults[index] = {
            id: step.id,
            name: step.name,
            status: 'ok',
            summary: product.output.slice(0, 4000),
            ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
            ...(product.artifactPath ? { artifactPath: product.artifactPath } : {}),
            durationMs: Date.now() - stepStartedAt,
          }
          stepProgress(index, 'ok')
          journal('step.completed', step.id, {
            position: index,
            durationMs: Date.now() - stepStartedAt,
            outputSummary: product.output.slice(0, 4000),
            artifactPath: product.artifactPath ?? null,
            imageUrl: product.imageUrl ?? null,
          })
          // 每步推送:跑完就把这步产出推到飞书(替代 App 内小预览)
          if (pushChannel && step.type !== 'notify') {
            void sendToChannel(
              pushChannel,
              {
                title: `${routine.name} · ${index + 1}. ${step.name}`,
                status: 'info',
                markdown: product.output.slice(0, 3000),
                ...(product.imageUrl ? { imageUrls: [product.imageUrl] } : {}),
              },
              signal,
            ).catch((err) =>
              appendAppLog('warn', 'routines.pushStep', 'Per-step push failed', {
                routine: routine.name,
                step: step.name,
                error: normalizeError(err),
              }),
            )
          }
        } catch (err) {
          if (forcedClosedRunIds.has(runId)) throw err
          if (err instanceof Error && err.message === '人工审核超时，工作流已停止') timedOut = true
          const cancelled = signal.aborted || err instanceof WorkflowCancelledError
          const failStatus = cancelled ? ('cancelled' as const) : timedOut ? ('timeout' as const) : ('error' as const)
          stepResults[index] = {
            id: step.id,
            name: step.name,
            status: failStatus,
            summary: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - stepStartedAt,
          }
          stepProgress(index, failStatus)
          journal('step.failed', step.id, {
            position: index,
            status: failStatus,
            durationMs: Date.now() - stepStartedAt,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
      }
    } finally {
      signal.removeEventListener('abort', cancelRun)
      await session.client?.dispose().catch(() => {})
    }
  } catch (err) {
    status = signal.aborted || err instanceof WorkflowCancelledError ? 'cancelled' : timedOut ? 'timeout' : 'error'
    errorMsg = err instanceof Error ? err.message : String(err)
    appendAppLog('error', 'routines.run', 'Routine run failed', {
      routine: routine.name,
      error: normalizeError(err),
    })
  }

  // A cancellation grace timeout already wrote the one authoritative terminal projection.
  // The fenced cleanup may arrive much later and must not emit a second terminal or touch live UI state.
  if (forcedClosedRunIds.delete(runId)) {
    activeRunForceCleanups.delete(runId)
    return
  }

  const summary =
    stepResults
      .filter((s) => s.status !== 'skipped')
      .map((s, i) => `Step ${i + 1} - ${s.name}\n${s.summary}`)
      .join('\n\n')
      .slice(0, 4000) || '(no output)'

  const run: RoutineRun = {
    id: runId,
    routineId: routine.id,
    routineName: routine.name,
    startedAt,
    endedAt: Date.now(),
    status,
    triggerSource,
    summary,
    steps: stepResults,
    error: errorMsg,
  }
  journal(
    status === 'ok'
      ? 'run.completed'
      : status === 'timeout'
        ? 'run.timed_out'
        : status === 'cancelled'
          ? 'run.cancelled'
          : 'run.failed',
    null,
    {
      status,
      durationMs: run.endedAt - run.startedAt,
      summary,
      error: errorMsg ?? null,
    },
  )
  liveStepProgress.delete(routine.id)
  store.runs = [run, ...store.runs].slice(0, MAX_RUNS_KEPT)
  saveStore(store)
  routineDatabase?.pruneRoutineRunEvents(MAX_RUNS_KEPT)

  // 兜底汇总通知(notify 节点之外的保险):本地弹窗 + 默认渠道一张卡片
  const shouldNotify = routine.notify === 'always' || (routine.notify === 'error' && status !== 'ok')
  if (shouldNotify) {
    if (Notification.isSupported()) {
      new Notification({
        title: `例行任务${status === 'ok' ? '完成' : '失败'}: ${routine.name}`,
        body: (errorMsg ?? summary).slice(0, 150),
      }).show()
    }
    const target =
      channels.find((c) => c.id === routine.notifyChannelId && c.type !== 'wechat-official') ??
      channels.find((c) => c.type !== 'local' && c.type !== 'wechat-official')
    if (target) {
      const statusText =
        status === 'ok' ? '完成' : status === 'timeout' ? '超时' : status === 'cancelled' ? '已取消' : '失败'
      const durationS = Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))
      const stepsMd = stepResults
        .map((s, i) => {
          const icon = s.status === 'ok' ? '✅' : s.status === 'skipped' ? '⏭' : '❌'
          const body = s.status === 'skipped' ? '(未执行)' : s.summary.slice(0, 300)
          return `${icon} **${i + 1}. ${s.name}**\n${body}`
        })
        .join('\n')
      const imageUrls = stepResults.map((s) => s.imageUrl).filter((u): u is string => !!u)
      sendToChannel(target, {
        title: `${status === 'ok' ? '✅' : '❌'} 例行任务${statusText}:${routine.name}`,
        status: status === 'cancelled' ? 'error' : status,
        markdown: `**工作区** ${routine.workspacePath} · **耗时** ${durationS}s${errorMsg ? `\n**错误** ${errorMsg.slice(0, 500)}` : ''}\n---\n${stepsMd}`,
        ...(imageUrls.length ? { imageUrls } : {}),
      }).catch((err) => {
        appendAppLog('error', 'routines.notify', 'Run summary notify failed', {
          routine: routine.name,
          channel: target.name,
          error: normalizeError(err),
        })
      })
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('routines:runFinished', run)
    if (shouldNotify && !win.isFocused()) {
      win.flashFrame(true)
      win.once('focus', () => win.flashFrame(false))
    }
  }
  activeRunForceCleanups.delete(runId)
  if (status === 'error' || status === 'timeout') {
    throw new WorkflowExecutionFailedError(status, errorMsg ?? `工作流${status === 'timeout' ? '超时' : '失败'}`)
  }
}

// ── 注册 ─────────────────────────────────────────────────────────

const stepIsComplete = isRoutineStepComplete

export function registerRoutines(): void {
  jsonDeleteOutbox = new JsonRoutineDeleteOutbox(deleteOutboxPath(), storePath())
  const databaseAlreadyExists = existsSync(databasePath())
  try {
    routineDatabase = new RoutineDatabase(databasePath(), storePath())
    try {
      const legacyDeletes = jsonDeleteOutbox.readAll()
      routineDatabase.importRoutineDeletes(legacyDeletes)
      if (legacyDeletes.length > 0) jsonDeleteOutbox.archiveAndClear()
    } catch (error) {
      appendAppLog(
        'error',
        'routines.database',
        'Failed to import the legacy cloud delete outbox',
        normalizeError(error),
      )
    }
    configureRoutineCloudOutbox(routineDatabase)
    app.once('will-quit', () => {
      routineDatabase?.close()
      routineDatabase = null
    })
  } catch (error) {
    routineDatabase?.close()
    routineDatabase = null
    if (!(error instanceof RoutineSqliteUnavailableError) || databaseAlreadyExists || existsSync(databasePath())) {
      throw error
    }
    configureRoutineCloudOutbox(jsonDeleteOutbox)
    appendAppLog(
      'error',
      'routines.database',
      'Failed to initialize SQLite; using legacy JSON storage',
      normalizeError(error),
    )
  }
  const store = loadStore()
  const interrupted = routineDatabase?.interruptOpenRoutineRuns() ?? []
  const recovered = routineDatabase?.recoverMissingRoutineRuns(store.runs) ?? []
  if (recovered.length > 0 && routineDatabase) {
    store.runs = [...recovered, ...store.runs]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_RUNS_KEPT)
    routineDatabase.save(store)
    routineDatabase.pruneRoutineRunEvents(MAX_RUNS_KEPT)
    appendAppLog('warn', 'routines.recovery', 'Recovered workflow runs from the durable journal', {
      runIds: recovered.map((run) => run.id),
      interruptedRunIds: interrupted.map((event) => event.runId),
    })
  }
  queueRoutineCloudSync(store)
  const runTriggerSources = new Map<string, 'manual' | 'schedule'>()
  const scheduler = new RoutineScheduler<Routine>({
    maxConcurrent: MAX_CONCURRENT,
    clock: () => new Date(),
    execute: (routine, execution) => {
      const triggerSource = triggerSources.get(routine.id) ?? 'schedule'
      triggerSources.delete(routine.id)
      runTriggerSources.set(execution.runId, triggerSource)
      return executeRoutine(store, routine, triggerSource, execution).finally(() => {
        activeRunForceCleanups.delete(execution.runId)
      })
    },
    forceCleanup: async (_routine, runId) => {
      // Fence the run before killing resources: process exit can settle execute() in the next microtask.
      forcedClosedRunIds.add(runId)
      await activeRunForceCleanups.get(runId)?.()
      activeRunForceCleanups.delete(runId)
    },
    onExecutionError: (error, routine) => {
      appendAppLog('error', 'routines.scheduler', 'Routine execution escaped the scheduler', {
        routine: routine.name,
        error: normalizeError(error),
      })
    },
    onCancellationTimeout: (routine, runId, startedAt) => {
      cancelPendingReviews(routine.id, '工作流取消宽限期已到，运行已强制关闭')
      const terminal = routineDatabase?.cancelOpenRoutineRun(runId, routine.id)
      const recovered = terminal
        ? routineDatabase?.recoverMissingRoutineRuns(store.runs).find((run) => run.id === runId)
        : undefined
      const run: RoutineRun = recovered ?? {
        id: runId,
        routineId: routine.id,
        routineName: routine.name,
        startedAt,
        endedAt: Date.now(),
        status: 'cancelled',
        triggerSource: runTriggerSources.get(runId) ?? 'schedule',
        summary: '工作流未在取消宽限期内退出，已强制关闭。',
        error: 'workflow cancellation grace period expired',
      }
      liveStepProgress.delete(routine.id)
      store.runs = [run, ...store.runs.filter((candidate) => candidate.id !== run.id)].slice(0, MAX_RUNS_KEPT)
      saveStore(store)
      routineDatabase?.pruneRoutineRunEvents(MAX_RUNS_KEPT)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('routines:runFinished', run)
      }
    },
    onExecutionSettled: (_routine, runId) => {
      runTriggerSources.delete(runId)
    },
  })

  const triggerSources = new Map<string, 'manual' | 'schedule'>()

  setInterval(() => {
    const scheduled = scheduler.tick(store.routines)
    if (scheduled.length > 0) saveStore(store)
  }, 30_000)

  ipcMain.handle('routines:list', () => ({
    routines: store.routines,
    runs: store.runs,
  }))

  ipcMain.handle('routines:save', (_e, payload: unknown) => {
    // 只放行已知字段:原来直接 Object.assign(existing, routine),
    // renderer 传什么并什么,未知字段会被持久化并同步上云
    const routine = parseRoutineSave(payload)
    const steps = (routine.steps as Partial<RoutineStep>[]).map(normalizeStep).filter(stepIsComplete)
    if (steps.length === 0) throw new Error('Workflow needs at least one complete step')
    const existing = routine.id ? store.routines.find((r) => r.id === routine.id) : undefined
    if (existing) {
      Object.assign(existing, { ...routine, steps })
    } else {
      const fresh = {
        enabled: true,
        createdAt: Date.now(),
        ...routine,
        steps,
        id: randomUUID(),
      } as Routine
      // 新任务从下一个周期开始:把"当前已过的槽"标记为已消费,
      // 否则 23:00 建一个"每天 09:00"的任务会立刻触发一次
      fresh.lastSlotKey = dueSlotKey(fresh, new Date()) ?? undefined
      if (fresh.schedule.type === 'interval') fresh.lastRunAt = Date.now()
      store.routines.push(fresh)
    }
    saveStore(store)
    return store.routines
  })

  ipcMain.handle('routines:delete', (_e, id: string) => {
    const nextRoutines = store.routines.filter((routine) => routine.id !== id)
    saveStore({ ...store, routines: nextRoutines }, { origin: routineSyncOrigin(), workflowId: id })
    store.routines = nextRoutines
    scheduler.cancel(id)
    cancelPendingReviews(id, '工作流已删除，审核请求已取消')
    return store.routines
  })

  ipcMain.handle('routines:toggle', (_e, id: string, enabled: boolean) => {
    setRoutineEnabled(id, enabled)
    return store.routines
  })

  // 手机和桌面共用。失败带上 code —— 「不存在」「正在跑」「到并发上限了」在手机上
  // 该给三种不同的提示,光靠一句中文字符串区分不了。
  const runRoutineNow = (id: string): { ok: true } | { error: string; code: string } => {
    const r = store.routines.find((x) => x.id === id)
    if (!r) return { error: '任务不存在', code: 'ROUTINE_NOT_FOUND' }
    if (scheduler.has(r.id)) return { error: '该任务正在执行或排队', code: 'ROUTINE_BUSY' }
    if (!scheduler.hasCapacity()) {
      return { error: `最多同时执行 ${MAX_CONCURRENT} 个任务`, code: 'ROUTINE_LIMIT' }
    }
    r.lastRunAt = Date.now()
    triggerSources.set(r.id, 'manual')
    saveStore(store)
    scheduler.enqueue(r)
    return { ok: true }
  }

  const setRoutineEnabled = (
    id: string,
    enabled: boolean,
  ): { ok: true } | { error: string; code: string } => {
    const r = store.routines.find((x) => x.id === id)
    if (!r) return { error: '任务不存在', code: 'ROUTINE_NOT_FOUND' }
    r.enabled = enabled
    if (!enabled) {
      scheduler.cancel(id)
      cancelPendingReviews(id, '工作流已停用，审核请求已取消')
    }
    saveStore(store)
    return { ok: true }
  }

  ipcMain.handle('routines:runNow', (_e, id: string) => runRoutineNow(id))

  ipcMain.handle('routines:cancel', (_e, id: string) => {
    const cancelled = scheduler.cancel(id)
    if (cancelled) cancelPendingReviews(id, '工作流已取消')
    return cancelled ? { ok: true as const } : { error: '任务未在执行或排队' }
  })

  ipcMain.handle('routines:state', () => ({
    ...scheduler.getState(),
    progress: [...liveStepProgress.values()].flatMap((steps) => [...steps.values()]),
    pendingReviews: [...pendingReviews.values()].map((pending) => pending.request),
  }))

  ipcMain.handle(
    'routines:reviewRespond',
    (_e, reviewId: string, decision: 'approve' | 'reject', comment?: string) =>
      respondToReview(reviewId, decision, comment),
  )

  // review 节点是阻塞式的,超时就把整条工作流拖死 —— 人在不在电脑前不该决定它的生死
  remoteControl.setReviewHost({
    list: () => [...pendingReviews.values()].map((pending) => pending.request),
    respond: respondToReview,
  })

  remoteControl.setRoutineHost({
    list: () => ({
      routines: store.routines.map((routine) => ({
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        stepCount: routine.steps.length,
        schedule: routine.schedule,
        workspacePath: routine.workspacePath,
        createdAt: routine.createdAt,
        ...(routine.lastRunAt ? { lastRunAt: routine.lastRunAt } : {}),
      })),
      // 手机上只回看最近这些;每步产物(steps)一律不带,那才是 store 的大头
      runs: store.runs.slice(-REMOTE_RUNS_KEPT).reverse().map((run) => ({
        id: run.id,
        routineId: run.routineId,
        routineName: run.routineName,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        ...(run.triggerSource ? { triggerSource: run.triggerSource } : {}),
        summary: run.summary.slice(0, REMOTE_RUN_SUMMARY_CHARS),
        ...(run.error ? { error: run.error.slice(0, REMOTE_RUN_SUMMARY_CHARS) } : {}),
      })),
      ...scheduler.getState(),
      progress: [...liveStepProgress.values()].flatMap((steps) => [...steps.values()]),
    }),
    run: runRoutineNow,
    toggle: setRoutineEnabled,
  })
}
