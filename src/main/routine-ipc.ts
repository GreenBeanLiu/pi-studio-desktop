import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { appendAppLog, normalizeError } from './app-log'
import { remoteControl } from './remote-control'
import { parseRoutineSave } from '../shared/ipc/validators'
import { isRoutineStepComplete } from './routine-step-validation'
import { queueRoutineCloudSync, routineSyncOrigin } from './routine-cloud-sync'
import { RoutineScheduler, dueSlotKey } from './routine-scheduler'
import {
  MAX_RUNS_KEPT,
  getRoutineDatabase,
  initRoutineStorage,
  loadStore,
  normalizeStep,
  saveStore,
} from './routine-store'
import { cancelPendingReviews, pendingReviews, respondToReview } from './routine-runtime'
import { activeRunForceCleanups, executeRoutine, forcedClosedRunIds, liveStepProgress } from './routine-runner'
import type { Routine, RoutineRun } from './routines'
import type { RoutineStep } from './routine-schema'

/**
 * 例程的启动接线:IPC handler、RoutineScheduler、以及挂到 remoteControl 的 routine/review host。
 *
 * 从 routines.ts 抽出来(2026-09-19),是最后一刀 —— 现在 routines.ts 只剩类型和
 * scheduleLabel。这里持有 `store` 和 `scheduler` 这两个闭包态;执行走 routine-runner,
 * 存储走 routine-store,审核/取消走 routine-runtime。
 */

const MAX_CONCURRENT = 2
/** 发给手机的运行历史条数和每条正文长度 —— 一帧 WebSocket 装得下,手机上也看得完 */
const REMOTE_RUNS_KEPT = 30
const REMOTE_RUN_SUMMARY_CHARS = 600

const stepIsComplete = isRoutineStepComplete

export function registerRoutines(): void {
  initRoutineStorage()
  const store = loadStore()
  const db = getRoutineDatabase()
  const interrupted = db?.interruptOpenRoutineRuns() ?? []
  const recovered = db?.recoverMissingRoutineRuns(store.runs) ?? []
  if (recovered.length > 0 && db) {
    store.runs = [...recovered, ...store.runs]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_RUNS_KEPT)
    db.save(store)
    db.pruneRoutineRunEvents(MAX_RUNS_KEPT)
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
      const terminal = getRoutineDatabase()?.cancelOpenRoutineRun(runId, routine.id)
      const recovered = terminal
        ? getRoutineDatabase()?.recoverMissingRoutineRuns(store.runs).find((run) => run.id === runId)
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
      getRoutineDatabase()?.pruneRoutineRunEvents(MAX_RUNS_KEPT)
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
