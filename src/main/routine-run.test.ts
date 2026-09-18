import { describe, expect, it } from 'vitest'
import { RoutineDisposeTimeoutError, RoutineRunHandle } from './routine-run'

describe('RoutineRunHandle', () => {
  it('returns a closed failed result instead of rejecting', async () => {
    const failure = new Error('node failed')
    const handle = new RoutineRunHandle(async () => {
      throw failure
    })

    await expect(handle.result).resolves.toEqual({
      state: 'failed',
      error: failure,
    })
    expect(handle.state()).toBe('failed')
  })

  it('owns cancellation and waits for cleanup on dispose', async () => {
    let cleaned = false
    const handle = new RoutineRunHandle(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              cleaned = true
              resolve()
            },
            { once: true },
          )
        }),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    await handle.dispose()

    expect(cleaned).toBe(true)
    expect(await handle.result).toEqual({ state: 'cancelled' })
    expect(handle.state()).toBe('cancelled')
  })

  it('logically terminates and closes the result when an executor ignores cancellation', async () => {
    let forceCleaned = false
    const handle = new RoutineRunHandle(
      () => new Promise<void>(() => {}),
      5,
      async () => {
        forceCleaned = true
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(handle.state()).toBe('cancelled')
    await expect(handle.result).resolves.toEqual({
      state: 'cancelled',
      error: expect.any(RoutineDisposeTimeoutError),
    })
    await expect(handle.cleanup).resolves.toBeUndefined()
    expect(forceCleaned).toBe(true)
  })

  it('retains ownership when forced cleanup cannot be verified', async () => {
    const cleanupFailure = new Error('process still alive')
    let reported: unknown
    let settled = false
    const handle = new RoutineRunHandle(
      () => new Promise<void>(() => {}),
      5,
      async () => { throw cleanupFailure },
      (error) => { reported = error },
    )
    void handle.result.then(() => { settled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))

    handle.cancel()
    await new Promise<void>((resolve) => setTimeout(resolve, 15))

    expect(reported).toBe(cleanupFailure)
    expect(handle.state()).toBe('cancelling')
    expect(settled).toBe(false)
  })

  it('lets forced cleanup own settlement when the executor exits during cleanup', async () => {
    let resolveExecution!: () => void
    let resolveCleanup!: () => void
    const execution = new Promise<void>((resolve) => { resolveExecution = resolve })
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve })
    const handle = new RoutineRunHandle(() => execution, 5, () => cleanup)
    let settled = false
    void handle.result.then(() => { settled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))

    handle.cancel()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    resolveExecution()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(settled).toBe(false)
    expect(handle.state()).toBe('cancelling')
    resolveCleanup()
    await expect(handle.result).resolves.toEqual({
      state: 'cancelled',
      error: expect.any(RoutineDisposeTimeoutError),
    })
  })
})
