import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AppIconPlatform } from './app-icon-spec'
import { appendAppLog, normalizeError } from './app-log'
import { configureRoutineCloudOutbox, queueRoutineCloudSync } from './routine-cloud-sync'
import { RoutineDatabase, RoutineSqliteUnavailableError } from './routine-database'
import { JsonRoutineDeleteOutbox } from './routine-delete-outbox'
import type { Routine, RoutineRun, RoutineStep } from './routines'

/**
 * 例程的持久化:JSON 快照 + SQLite(RoutineDatabase),以及从 JSON 迁到 SQLite 的过渡。
 *
 * 从 routines.ts 抽出来(2026-09-19)。run engine(routine-runner.ts)和 IPC 都通过
 * `loadStore`/`saveStore`/`getRoutineDatabase()` 访问,不直接碰这两个实现。
 * Routine 走 type-only import。DB 未就绪(没装 better-sqlite3、首次启动失败)时回落 JSON。
 */

export type Store = { routines: Routine[]; runs: RoutineRun[] }

export const MAX_RUNS_KEPT = 100

const storePath = (): string => join(app.getPath('userData'), 'routines.json')
const databasePath = (): string => join(app.getPath('userData'), 'routines.sqlite3')
const deleteOutboxPath = (): string => join(app.getPath('userData'), 'cloud-sync-outbox.json')

let routineDatabase: RoutineDatabase | null = null
let jsonDeleteOutbox: JsonRoutineDeleteOutbox | null = null

/** 当前 SQLite 库;回落 JSON 或尚未初始化时为 null。 */
export function getRoutineDatabase(): RoutineDatabase | null {
  return routineDatabase
}

export function normalizeStep(step: Partial<RoutineStep>): RoutineStep {
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

export function loadStore(): Store {
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

export function saveStore(store: Store, deleted?: { origin: string; workflowId: string }): void {
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

/**
 * 打开 SQLite 并把历史 JSON 删除队列迁进来;SQLite 不可用就回落到 JSON delete outbox。
 * 由 registerRoutines 在启动时调用一次。
 */
export function initRoutineStorage(): void {
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
}
