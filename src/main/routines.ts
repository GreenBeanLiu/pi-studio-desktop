import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AppIconPlatform } from './app-icon-spec'
import { loadChannels, sendToChannel } from './channels'
import { appendAppLog, normalizeError } from './app-log'
import { remoteControl } from './remote-control'
import { parseRoutineSave } from '../shared/ipc/validators'
import { isRoutineStepComplete } from './routine-step-validation'
import { configureRoutineCloudOutbox, queueRoutineCloudSync, routineSyncOrigin } from './routine-cloud-sync'
import { RoutineDatabase, RoutineSqliteUnavailableError } from './routine-database'
import type { RoutineRunEventType } from './routine-database'
import { JsonRoutineDeleteOutbox } from './routine-delete-outbox'
import {
  RoutineScheduler,
  dueSlotKey,
  type RoutineExecutionContext,
  type SchedulableSchedule,
} from './routine-scheduler'
import type { RoutineNodeMap, RoutineStep, RoutineStepType } from './routine-schema'
import {
  WorkflowCancelledError,
  broadcast,
  cancelPendingReviews,
  pendingReviews,
  respondToReview,
  throwIfWorkflowCancelled,
} from './routine-runtime'
import {
  createRoutineNodeRegistry,
  pathStamp,
  type AgentSession,
  type RunContext,
} from './routine-steps'

// 节点 schema / 执行器 / 共享运行时状态分别挪到了 routine-schema.ts、routine-steps.ts、
// routine-runtime.ts;老的 `from './routines'` 路径继续有效。
export { resolveImagegenReference } from './routine-steps'
export { routineStepSchema, stepProductSchema } from './routine-schema'
export type { RoutineStep, RoutineStepType } from './routine-schema'

/**
 * 例行任务(Routines):定时执行一条由类型化节点组成的流水线。
 * 节点类型:agent(pi 会话) / imagegen(生图) / review(人工审核) / export(工作区产物) / notify(推送到某个通知渠道)。
 * 节点间用 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} 传值。
 * agent 节点每次 run spawn 一个全新 RpcClient 子进程(独立 session),跑完即弃 ——
 * 绝不打扰用户当前打开的聊天会话。
 */

export type RoutineSchedule = SchedulableSchedule

export type RoutineNotify = 'always' | 'error' | 'never'

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

const MAX_RUNS_KEPT = 100
const MAX_CONCURRENT = 2
/** 发给手机的运行历史条数和每条正文长度 —— 一帧 WebSocket 装得下,手机上也看得完 */
const REMOTE_RUNS_KEPT = 30
const REMOTE_RUN_SUMMARY_CHARS = 600

const storePath = (): string => join(app.getPath('userData'), 'routines.json')
const databasePath = (): string => join(app.getPath('userData'), 'routines.sqlite3')
const deleteOutboxPath = (): string => join(app.getPath('userData'), 'cloud-sync-outbox.json')
let routineDatabase: RoutineDatabase | null = null
let jsonDeleteOutbox: JsonRoutineDeleteOutbox | null = null

const forcedClosedRunIds = new Set<string>()
const activeRunForceCleanups = new Map<string, () => Promise<void>>()

class WorkflowExecutionFailedError extends Error {
  constructor(
    readonly status: 'error' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowExecutionFailedError'
  }
}

// 保留当前运行中工作流的最新节点状态。页面切换会卸载 RoutinesPage，
// 回来时通过 routines:state 恢复这份快照，而不是等下一次事件广播。
const liveStepProgress = new Map<string, Map<string, RoutineStepProgress>>()

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
