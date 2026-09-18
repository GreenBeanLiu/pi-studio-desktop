import { RoutineDisposeTimeoutError, RoutineRunHandle } from './routine-run'
import { randomUUID } from 'crypto'

export type SchedulableSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

export type SchedulableRoutine = {
  id: string
  enabled: boolean
  schedule: SchedulableSchedule
  lastRunAt?: number
  lastSlotKey?: string
}

export type RoutineSchedulerState = {
  runningIds: string[]
  waitingIds: string[]
  cancellingIds: string[]
  queuedIds: string[]
}

export type RoutineExecutionContext = {
  runId: string
  startedAt: number
  signal: AbortSignal
  waiting: () => void
  resumed: () => void
}

type RoutineSchedulerOptions<T extends SchedulableRoutine> = {
  maxConcurrent: number
  cancelGraceMs?: number
  clock: () => Date
  execute: (routine: T, context: RoutineExecutionContext) => Promise<void>
  forceCleanup: (routine: T, runId: string) => Promise<void>
  onExecutionError?: (error: unknown, routine: T) => void
  onCancellationTimeout?: (routine: T, runId: string, startedAt: number) => void
  onExecutionSettled?: (routine: T, runId: string) => void
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function dueSlotKey(routine: Pick<SchedulableRoutine, 'schedule' | 'lastRunAt'>, now: Date): string | null {
  const schedule = routine.schedule
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  switch (schedule.type) {
    case 'manual':
      // 按需触发:永不自动跑,只能手动「运行」
      return null
    case 'interval': {
      const lastRunAt = routine.lastRunAt ?? 0
      return now.getTime() - lastRunAt >= schedule.minutes * 60_000 ? `interval-${now.getTime()}` : null
    }
    case 'hourly': {
      if (now.getMinutes() < schedule.minute) return null
      return `${today} ${pad(now.getHours())}h`
    }
    case 'daily': {
      if (hhmm < schedule.time) return null
      return today
    }
    case 'weekly': {
      if (now.getDay() !== schedule.day || hhmm < schedule.time) return null
      return `${today} w`
    }
  }
}

export class RoutineScheduler<T extends SchedulableRoutine> {
  private readonly maxConcurrent: number
  private readonly cancelGraceMs: number
  private readonly clock: () => Date
  private readonly execute: (routine: T, context: RoutineExecutionContext) => Promise<void>
  private readonly forceCleanup: (routine: T, runId: string) => Promise<void>
  private readonly onExecutionError?: (error: unknown, routine: T) => void
  private readonly onCancellationTimeout?: (routine: T, runId: string, startedAt: number) => void
  private readonly onExecutionSettled?: (routine: T, runId: string) => void
  private readonly running = new Map<string, { routine: T; handle: RoutineRunHandle }>()
  private readonly queue: T[] = []

  constructor(options: RoutineSchedulerOptions<T>) {
    this.maxConcurrent = options.maxConcurrent
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000
    this.clock = options.clock
    this.execute = options.execute
    this.forceCleanup = options.forceCleanup
    this.onExecutionError = options.onExecutionError
    this.onCancellationTimeout = options.onCancellationTimeout
    this.onExecutionSettled = options.onExecutionSettled
  }

  tick(routines: readonly T[]): T[] {
    const now = this.clock()
    const scheduled: T[] = []

    for (const routine of routines) {
      if (!routine.enabled || this.has(routine.id)) continue
      const slot = dueSlotKey(routine, now)
      if (!slot) continue
      if (routine.schedule.type !== 'interval' && routine.lastSlotKey === slot) continue

      routine.lastSlotKey = slot
      routine.lastRunAt = now.getTime()
      this.enqueue(routine)
      scheduled.push(routine)
    }

    return scheduled
  }

  enqueue(routine: T): 'running' | 'queued' | 'duplicate' {
    if (this.has(routine.id)) return 'duplicate'

    this.queue.push(routine)
    this.drain()
    return this.running.has(routine.id) ? 'running' : 'queued'
  }

  has(id: string): boolean {
    return this.running.has(id) || this.queue.some((routine) => routine.id === id)
  }

  cancel(id: string): boolean {
    const index = this.queue.findIndex((routine) => routine.id === id)
    if (index !== -1) {
      this.queue.splice(index, 1)
      return true
    }
    const active = this.running.get(id)
    if (!active) return false
    active.handle.cancel()
    return true
  }

  hasCapacity(): boolean {
    return this.running.size < this.maxConcurrent
  }

  getState(): RoutineSchedulerState {
    return {
      runningIds: [...this.running.keys()],
      waitingIds: [...this.running].filter(([, active]) => active.handle.state() === 'waiting').map(([id]) => id),
      cancellingIds: [...this.running].filter(([, active]) => active.handle.state() === 'cancelling').map(([id]) => id),
      queuedIds: this.queue.map((routine) => routine.id),
    }
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const routine = this.queue.shift()!
      if (!routine.enabled) continue
      const runId = randomUUID()
      const startedAt = Date.now()
      const handle = new RoutineRunHandle(
        (signal) =>
          this.execute(routine, {
            runId,
            startedAt,
            signal,
            waiting: () => handle.waiting(),
            resumed: () => handle.resumed(),
          }),
        this.cancelGraceMs,
        () => this.forceCleanup(routine, runId),
        (error) => {
          try {
            this.onExecutionError?.(error, routine)
          } catch {
            // Reporting cannot release ownership of a run whose cleanup failed.
          }
        },
      )
      this.running.set(routine.id, { routine, handle })

      void handle.result
        .then((result) => {
          if (result.state === 'cancelled' && result.error instanceof RoutineDisposeTimeoutError) {
            try {
              this.onCancellationTimeout?.(routine, runId, startedAt)
            } catch (error) {
              this.onExecutionError?.(error, routine)
            }
            return
          }
          if (result.state !== 'failed') return
          try {
            this.onExecutionError?.(result.error, routine)
          } catch {
            // Error reporting must not prevent the next queued routine from starting.
          }
        })
        .finally(() => {
          try {
            this.onExecutionSettled?.(routine, runId)
          } catch (error) {
            try {
              this.onExecutionError?.(error, routine)
            } catch {
              // Settlement cleanup cannot block releasing this verified ownership.
            }
          }
          this.running.delete(routine.id)
          this.drain()
        })
    }
  }
}
