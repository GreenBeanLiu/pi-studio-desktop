import { BrowserWindow, Notification } from 'electron'
import { existsSync } from 'fs'
import { loadChannels, sendToChannel } from './channels'
import { appendAppLog, normalizeError } from './app-log'
import {
  WorkflowCancelledError,
  broadcast,
  cancelPendingReviews,
  throwIfWorkflowCancelled,
} from './routine-runtime'
import { createRoutineNodeRegistry, pathStamp, type AgentSession, type RunContext } from './routine-steps'
import { MAX_RUNS_KEPT, getRoutineDatabase, saveStore } from './routine-store'
import type { RoutineExecutionContext } from './routine-scheduler'
import type { RoutineRunEventType } from './routine-database'
import type { RoutineNodeMap, RoutineStepType } from './routine-schema'
import type { Routine, RoutineRun, RoutineStepProgress, RoutineStepResult } from './routines'

/**
 * 例程的 run engine:一次运行的整个生命周期(逐节点执行、进度广播、事件 journal、终态投影、
 * 兜底通知、强制关闭的围栏)。
 *
 * 从 routines.ts 抽出来(2026-09-19)。它持有的三份跨 IPC 共享的状态在这里导出,由
 * registerRoutines(routines.ts)读写:liveStepProgress(状态快照)、activeRunForceCleanups
 * (强制清理句柄)、forcedClosedRunIds(终态围栏)。存储走 routine-store,取消/广播/审核
 * 队列走 routine-runtime。Routine 等类型 type-only import。
 */

/** 取消宽限期已到、被强制关闭的运行:它已经写过唯一的终态投影,后续清理不能再写第二份。 */
export const forcedClosedRunIds = new Set<string>()
/** runId → 强制清理回调(杀 agent 进程、取消挂起的审核)。 */
export const activeRunForceCleanups = new Map<string, () => Promise<void>>()
/** 运行中工作流的最新节点状态;页面切换靠 routines:state 恢复这份快照。 */
export const liveStepProgress = new Map<string, Map<string, RoutineStepProgress>>()

class WorkflowExecutionFailedError extends Error {
  constructor(
    readonly status: 'error' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowExecutionFailedError'
  }
}

export async function executeRoutine(
  store: { routines: Routine[]; runs: RoutineRun[] },
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
    getRoutineDatabase()?.appendRoutineRunEvent({
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
  getRoutineDatabase()?.pruneRoutineRunEvents(MAX_RUNS_KEPT)

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
