import { dirname } from 'path'
import { piClientManager } from './pi-client'
import { listSessions } from './pi-sessions'
import { appendAppLog, normalizeError } from './app-log'
import { ModelCatalogCoordinator } from './model-catalog'
import { LOCAL_FILE_MAX_BYTES } from './local-file-tools'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  ImageGenHistoryItem,
  RoutineReviewRequest,
  RoutineRun,
  SessionProjectionChanges,
  SessionProjectionSnapshot,
} from '../shared/ipc/contract'
import type { RoutineSchedule, RoutineStepProgress } from './routines'
import type { Workspace } from '../shared/contracts'
import type { WorkspaceInventoryItem } from './workspace-inventory'
import {
  executeLocalToolOperation,
  LOCAL_TOOL_HANDLERS,
  LOCAL_TOOL_PROTOCOL,
} from './tool-gateway'
import type { ToolReceiptLedger } from './tool-receipts'

/**
 * controller 指令的分发层:把手机(controller)发来的一条命令,翻成对 piClientManager
 * 和各个桌面 host 的调用,并把结果按 protocol 回帧。
 *
 * 从 remote-control.ts 抽出来(2026-09-19):那里同时管 WebSocket transport、心跳/重连、
 * 29 条命令的分发和 host projection,一个文件 884 行。这里只保留「指令 → 动作」,
 * transport 和连接状态仍在 RemoteControlManager。改一条指令只需要动这个文件。
 */

export type ProjectionProvider = {
  snapshot: () => SessionProjectionSnapshot
  changes: (sessionId: string | null, afterSeq: number) => SessionProjectionChanges
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cachedProviderLabels(): Record<string, string> {
  try {
    return new ModelCatalogCoordinator().loadCachedProviderLabels().providerLabels
  } catch {
    return {}
  }
}

function withProviderLabel<T extends { provider: string }>(
  model: T,
  providerLabels: Record<string, string>,
): T & { providerLabel?: string } {
  const providerLabel = providerLabels[model.provider]
  return { ...model, ...(providerLabel ? { providerLabel } : {}) }
}

/**
 * 手机据此隐藏这台桌面还不支持的功能。指令是一条条加上去的,靠 UNKNOWN_COMMAND
 * 一个个试出来,只能在用户点下去之后才发现「这个按钮在这台电脑上没用」。
 *
 * 改动指令表时这里要一起改 —— 有回归测试盯着,漏了会红。
 */
export const SUPPORTED_COMMANDS = [
  'capabilities',
  'prompt',
  'executeToolOperation',
  'toolOperationReceipt',
  'steer',
  'followUp',
  'abort',
  'newSession',
  'getState',
  'getMessages',
  'getAvailableModels',
  'setModel',
  'getWorkspace',
  'listWorkspaces',
  'workspaceInventory',
  'openWorkspace',
  'listRoutines',
  'runRoutine',
  'toggleRoutine',
  'imageGenHealth',
  'imageGenerate',
  'imageGenHistory',
  'klingVideoHealth',
  'klingVideoStart',
  'listVideoJobs',
  'listPendingReviews',
  'respondReview',
  'switchSession',
  'renameSession',
  'listSessions',
] as const

/** hostEvent 会用到的 channel。手机认不出的一律丢掉。 */
export const HOST_EVENT_CHANNELS = [
  'video:job',
  'routines:stepProgress',
  'routines:runFinished',
  'routines:reviewRequested',
  'routines:reviewCancelled',
] as const

/**
 * 开工作区的实际逻辑在 ipc.ts(要拉 runtime 配置、装扩展、挂一堆事件回调),
 * 这里只拿注入进来的入口用 —— remote-control 反向 import ipc 会成环。
 */
export type RemoteWorkspaceHost = {
  list: () => { current: string | null; recent: Workspace[] }
  open: (path: string) => Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }>
  inventory?: () => Promise<WorkspaceInventoryItem[]>
}

/**
 * 发给手机的工作流摘要。**不能**把 store 原样搬过去:一次运行的 steps 里每步产物
 * 上限 60_000 字,还留着最近 100 次运行,整个 store 是几十 MB 级别的,塞进一帧
 * WebSocket 既慢又没用 —— 手机上要看的就是「叫什么、开没开、上次跑得怎么样」。
 */
export type RemoteRoutineSummary = {
  id: string
  name: string
  enabled: boolean
  stepCount: number
  schedule: RoutineSchedule
  workspacePath: string
  createdAt: number
  lastRunAt?: number
}

export type RemoteRoutineRunSummary = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  /** 跟 RoutineRun 共用一套终态,免得工作流新增状态时手机这边悄悄漏掉一个。 */
  status: RoutineRun['status']
  triggerSource?: 'manual' | 'schedule'
  summary: string
  error?: string
}

export type RemoteRoutineHost = {
  list: () => {
    routines: RemoteRoutineSummary[]
    runs: RemoteRoutineRunSummary[]
    runningIds: string[]
    queuedIds: string[]
    progress: RoutineStepProgress[]
  }
  run: (id: string) => { ok: true } | { error: string; code: string }
  toggle: (id: string, enabled: boolean) => { ok: true } | { error: string; code: string }
}

/**
 * 生图。注意结果**只回 R2 公网链接**:桌面的 ImageGenResult 还带一个 dataUrl(整张图
 * 的 base64,一张几 MB),那个绝不能进 WebSocket 帧 —— 手机自己去 CDN 拉图就行。
 */
export type RemoteImageHost = {
  health: () => Promise<{ ok: boolean; model: string }>
  generate: (payload: {
    prompt: string
    model?: string
    n?: number
    size?: string
    aspectRatio?: string
    referenceUrls?: string[]
  }) => Promise<{ urls: string[] } | { error: string }>
  history: (limit: number) => Promise<ImageGenHistoryItem[] | { error: string }>
}

/**
 * 可灵文生视频。一次生成 5~20 分钟 —— 不能像生图那样挂一条长请求等着,手机切个后台
 * 或者换个网就断了,结果就丢了。所以发起即返回一个 job,进度和结果走 hostEvent 推;
 * 手机重连后用 list 把还在跑的和刚跑完的补回来。
 */
export type RemoteVideoJob = {
  id: string
  prompt: string
  duration: number
  aspectRatio: string
  mode: string
  status: 'running' | 'done' | 'error'
  /** submitting / running / uploading —— 来自云端 SSE */
  stage?: string
  videoUrl?: string
  durationSec?: number | null
  error?: string
  createdAt: number
}

export type RemoteVideoHost = {
  health: () => Promise<{ ok: boolean; model: string }>
  list: () => RemoteVideoJob[]
  /** 立刻返回 job(status=running),真正的生成在后台跑。 */
  start: (payload: {
    prompt: string
    duration?: number
    aspectRatio?: string
    mode?: string
  }) => RemoteVideoJob
}

/** 同理由 routines.ts 注入:pendingReviews 归它管,反向 import 会成环。 */
export type RemoteReviewHost = {
  list: () => RoutineReviewRequest[]
  respond: (
    reviewId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ) => { ok: true } | { error: string }
}

/**
 * 分发一条 controller 指令时需要的一切。由 RemoteControlManager 在每条消息到达时组装:
 * reply/replyError 是回帧,receipts/projection 和五个 host 是当前挂着的能力,缺了就用
 * 各自的错误信息 fail closed。
 */
export type RemoteCommandContext = {
  reply: (id: unknown, data?: unknown) => void
  replyError: (id: unknown, message: string, code?: string) => void
  receipts: ToolReceiptLedger | null
  projection: ProjectionProvider | null
  toolGatewayManifest: () => Record<string, unknown>
  workspaceHost: RemoteWorkspaceHost | null
  routineHost: RemoteRoutineHost | null
  imageHost: RemoteImageHost | null
  videoHost: RemoteVideoHost | null
  reviewHost: RemoteReviewHost | null
}

function requireHost<T>(host: T | null, message: string): T {
  if (!host) throw new Error(message)
  return host
}

export async function dispatchControllerCommand(
  type: string,
  msg: Record<string, unknown>,
  ctx: RemoteCommandContext,
): Promise<void> {
  switch (type) {
    case 'capabilities':
      ctx.reply(msg.id, {
        commands: [...SUPPORTED_COMMANDS],
        hostEvents: [...HOST_EVENT_CHANNELS],
        localTools: Object.keys(LOCAL_TOOL_HANDLERS),
        localFileMaxBytes: LOCAL_FILE_MAX_BYTES,
        toolProtocol: LOCAL_TOOL_PROTOCOL,
        toolGateway: ctx.toolGatewayManifest(),
      })
      break
    case 'prompt':
      await piClientManager.prompt(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
      ctx.reply(msg.id)
      break
    case 'executeToolOperation': {
      // 先记账再执行:回执写不进盘就不做 —— 做了没账,控制面断线后就永远不知道这条写落地没有。
      const operationId = String(msg.operationId ?? msg.operation_id ?? '').trim()
      const ledger = operationId ? ctx.receipts : null
      if (ledger) {
        try {
          ledger.recordDispatch(msg)
        } catch (error) {
          ctx.replyError(msg.id, `tool receipt ledger is unavailable: ${errMsg(error)}`, 'RECEIPT_UNAVAILABLE')
          break
        }
      }
      const result = await executeLocalToolOperation(msg)
      if (ledger) {
        try {
          ledger.recordSettled(
            operationId,
            'error' in result ? { ok: false, error: result.error, code: result.code } : { ok: true, result: result.result },
          )
        } catch (error) {
          appendAppLog('warn', 'tool.receipt', `failed to record the settled receipt for ${operationId}`, normalizeError(error))
        }
      }
      if ('error' in result) {
        ctx.replyError(msg.id, result.error, result.code)
        break
      }
      ctx.reply(msg.id, result)
      break
    }
    case 'toolOperationReceipt': {
      if (!ctx.receipts) {
        ctx.replyError(msg.id, 'this desktop does not keep tool operation receipts', 'RECEIPTS_UNAVAILABLE')
        break
      }
      const operationId = String(msg.operationId ?? msg.operation_id ?? '').trim()
      if (!operationId) {
        ctx.replyError(msg.id, 'operationId is required', 'INVALID_TOOL_OPERATION')
        break
      }
      ctx.reply(msg.id, ctx.receipts.lookup(operationId))
      break
    }
    case 'steer':
      await piClientManager.steer(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
      ctx.reply(msg.id)
      break
    case 'followUp':
      await piClientManager.followUp(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
      ctx.reply(msg.id)
      break
    case 'abort':
      await piClientManager.abort()
      ctx.reply(msg.id)
      break
    case 'newSession':
      ctx.reply(msg.id, await piClientManager.newSession())
      break
    case 'getState':
      {
        const state = await piClientManager.getState()
        ctx.reply(
          msg.id,
          state?.model
            ? {
                ...state,
                model: withProviderLabel(state.model, cachedProviderLabels()),
              }
            : state,
        )
      }
      break
    case 'getMessages':
      ctx.reply(msg.id, await piClientManager.getMessages())
      break
    case 'getSessionProjection':
      if (!ctx.projection) throw new Error('session projection is unavailable')
      ctx.reply(msg.id, ctx.projection.snapshot())
      break
    case 'getSessionChanges': {
      if (!ctx.projection) throw new Error('session projection is unavailable')
      if (msg.sessionId !== null && typeof msg.sessionId !== 'string') {
        throw new Error('sessionId must be a string or null')
      }
      const sessionId = msg.sessionId
      const afterSeq = Number(msg.afterSeq)
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new Error('afterSeq must be a non-negative safe integer')
      }
      ctx.reply(msg.id, ctx.projection.changes(sessionId, afterSeq))
      break
    }
    case 'getAvailableModels':
      {
        const models = await piClientManager.getAvailableModels()
        const providerLabels = cachedProviderLabels()
        ctx.reply(
          msg.id,
          models.map((model) => withProviderLabel(model, providerLabels)),
        )
      }
      break
    case 'setModel': {
      const provider = String(msg.provider ?? '').trim()
      const model = String(msg.model ?? '').trim()
      if (!provider || !model) throw new Error('provider and model are required')
      const state = await piClientManager.getState()
      if (state?.isStreaming) {
        ctx.replyError(
          msg.id,
          'cannot switch model while agent is running',
          'MODEL_SWITCH_WHILE_RUNNING',
        )
        break
      }
      const selected = await piClientManager.setModel(provider, model)
      ctx.reply(msg.id, selected)
      break
    }
    case 'getWorkspace':
      ctx.reply(msg.id, { workspacePath: piClientManager.getWorkspacePath() })
      break
    // 桌面冷启动后没人点「打开工作区」的话,上面每条指令都会抛 NO_WORKSPACE,
    // 而人不在电脑前 —— 这两条是手机自己把工作区开起来的唯一出路。
    case 'listWorkspaces':
      ctx.reply(msg.id, requireHost(ctx.workspaceHost, 'workspace control is unavailable').list())
      break
    case 'workspaceInventory': {
      const inventory = requireHost(ctx.workspaceHost, 'workspace control is unavailable').inventory
      if (!inventory) throw new Error('workspace inventory is unavailable')
      ctx.reply(msg.id, await inventory())
      break
    }
    case 'klingVideoHealth':
      ctx.reply(msg.id, await requireHost(ctx.videoHost, 'video generation is unavailable').health())
      break
    case 'listVideoJobs':
      ctx.reply(msg.id, requireHost(ctx.videoHost, 'video generation is unavailable').list())
      break
    case 'klingVideoStart': {
      const prompt = String(msg.prompt ?? '').trim()
      if (!prompt) {
        ctx.replyError(msg.id, 'prompt is required', 'INVALID_PROMPT')
        break
      }
      // 立刻回 job,不等生成 —— 进度和结果稍后走 video:job 事件推过来
      ctx.reply(
        msg.id,
        requireHost(ctx.videoHost, 'video generation is unavailable').start({
          prompt,
          ...(typeof msg.duration === 'number' ? { duration: msg.duration } : {}),
          ...(typeof msg.aspectRatio === 'string' ? { aspectRatio: msg.aspectRatio } : {}),
          ...(typeof msg.mode === 'string' ? { mode: msg.mode } : {}),
        }),
      )
      break
    }
    case 'imageGenHealth':
      ctx.reply(msg.id, await requireHost(ctx.imageHost, 'image generation is unavailable').health())
      break
    case 'imageGenerate': {
      const prompt = String(msg.prompt ?? '').trim()
      if (!prompt) {
        ctx.replyError(msg.id, 'prompt is required', 'INVALID_PROMPT')
        break
      }
      const references = Array.isArray(msg.referenceUrls)
        ? msg.referenceUrls.filter((item): item is string => typeof item === 'string')
        : undefined
      const result = await requireHost(ctx.imageHost, 'image generation is unavailable').generate({
        prompt,
        ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
        ...(typeof msg.n === 'number' ? { n: msg.n } : {}),
        ...(typeof msg.size === 'string' ? { size: msg.size } : {}),
        ...(typeof msg.aspectRatio === 'string' ? { aspectRatio: msg.aspectRatio } : {}),
        ...(references?.length ? { referenceUrls: references } : {}),
      })
      if ('error' in result) {
        ctx.replyError(msg.id, result.error, 'IMAGE_GEN_FAILED')
        break
      }
      // 只挑 urls,不整个透传 —— ImageGenResult 里还有个几 MB 的 dataUrl,
      // 哪天有人把原始结果塞进来,这一行是最后一道闸
      ctx.reply(msg.id, { urls: result.urls })
      break
    }
    case 'imageGenHistory': {
      const limit = typeof msg.limit === 'number' ? msg.limit : 40
      const history = await requireHost(ctx.imageHost, 'image generation is unavailable').history(limit)
      if ('error' in history) {
        ctx.replyError(msg.id, history.error, 'IMAGE_HISTORY_FAILED')
        break
      }
      ctx.reply(msg.id, history)
      break
    }
    // 工作流不依赖工作区(store 在 userData,agent 节点自己按需拉 RpcClient),
    // 所以这几条在桌面没开工作目录时照样可用。
    case 'listRoutines':
      ctx.reply(msg.id, requireHost(ctx.routineHost, 'routine control is unavailable').list())
      break
    case 'runRoutine':
    case 'toggleRoutine': {
      const routineId = String(msg.routineId ?? '').trim()
      if (!routineId) {
        ctx.replyError(msg.id, 'routineId is required', 'INVALID_ROUTINE')
        break
      }
      const host = requireHost(ctx.routineHost, 'routine control is unavailable')
      const result =
        type === 'runRoutine'
          ? host.run(routineId)
          : host.toggle(routineId, msg.enabled !== false)
      if ('error' in result) {
        ctx.replyError(msg.id, result.error, result.code)
        break
      }
      ctx.reply(msg.id)
      break
    }
    // reviewRequested 是广播,手机当时不在线就永远收不到。重连后靠这条补齐,
    // 否则一个还剩十几分钟才超时的审核在手机上是隐形的。
    case 'listPendingReviews':
      ctx.reply(msg.id, requireHost(ctx.reviewHost, 'review control is unavailable').list())
      break
    case 'respondReview': {
      const reviewId = String(msg.reviewId ?? '').trim()
      const decision = String(msg.decision ?? '')
      if (!reviewId || (decision !== 'approve' && decision !== 'reject')) {
        ctx.replyError(msg.id, 'reviewId and a valid decision are required', 'INVALID_REVIEW')
        break
      }
      const comment = msg.comment === undefined ? undefined : String(msg.comment)
      const result = requireHost(ctx.reviewHost, 'review control is unavailable').respond(reviewId, decision, comment)
      // 桌面上先点了、或者已经超时 —— 手机要能分辨出「这条已经没了」而不是失败重试
      if ('error' in result) {
        ctx.replyError(msg.id, result.error, 'REVIEW_GONE')
        break
      }
      ctx.reply(msg.id)
      break
    }
    case 'openWorkspace': {
      const path = String(msg.path ?? '').trim()
      if (!path) {
        ctx.replyError(msg.id, 'workspace path is required', 'INVALID_PATH')
        break
      }
      const result = await requireHost(ctx.workspaceHost, 'workspace control is unavailable').open(path)
      if ('error' in result) {
        ctx.replyError(msg.id, result.error, 'OPEN_WORKSPACE_FAILED')
        break
      }
      ctx.reply(msg.id, { workspacePath: path, recent: result.recentWorkspaces })
      break
    }
    case 'switchSession':
      ctx.reply(msg.id, await piClientManager.switchSession(String(msg.path ?? '')))
      break
    // 只能重命名当前会话:pi 的 set_session_name 作用于活动会话(桌面端同理)
    case 'renameSession': {
      const name = String(msg.name ?? '').trim()
      if (!name) {
        ctx.replyError(msg.id, 'session name is required', 'INVALID_NAME')
        break
      }
      await piClientManager.setSessionName(name)
      ctx.reply(msg.id)
      break
    }
    // 会话列表只能由桌面提供:RpcClient 没有 list API,是扫 sessions 目录扫出来的
    // (同 ipc.ts 的 'sessions:list')。列表按当前工作区 cwd 过滤。
    case 'listSessions': {
      const cwd = piClientManager.getWorkspacePath()
      const state = await piClientManager.getState()
      ctx.reply(
        msg.id,
        cwd && state.sessionFile ? await listSessions(dirname(state.sessionFile), cwd) : [],
      )
      break
    }
    default:
      ctx.replyError(msg.id, `unknown command: ${type}`, 'UNKNOWN_COMMAND')
      break
  }
}
