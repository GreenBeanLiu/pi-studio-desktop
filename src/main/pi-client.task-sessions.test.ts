import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

// 进程池和 ACP 目录换成桩:这里测的是会话层怎么开、绑、收任务会话,不起真进程。
const pool = vi.hoisted(() => ({
  host: null as null | { handleRuntimeEvent: (entry: unknown, event: PiRuntimeEvent) => void; onEntryRemoved: (entry: unknown) => void },
  launch: { cwd: '/ws' } as unknown,
  entries: [] as Array<Record<string, unknown>>,
  stopEntry: vi.fn(),
  spawn: vi.fn(),
  spawnAcp: vi.fn(),
}))

function fakeEntry(kind: 'pi' | 'acp'): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    client: {
      send: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      respondExtensionUi: vi.fn(),
      ...(kind === 'acp' ? { setPermissionMode: vi.fn().mockResolvedValue(undefined) } : {}),
    },
    pi: kind === 'pi' ? {} : null,
    acp: kind === 'acp' ? { agentId: 'codex-acp', agentName: 'Codex' } : null,
    firstMessage: null,
    job: { id: `job-${pool.entries.length}`, observeRun: vi.fn(), isRunActive: () => false, startedRunAt: () => null, touch: vi.fn() },
    sessionFile: null,
    sessionId: `sess-${pool.entries.length}`,
    pendingUi: [],
    outstandingUi: new Map(),
    subagentJobs: new Map(),
    status: { observe: vi.fn(), loopDetected: vi.fn() },
    loopGuard: { observe: () => null },
  }
  pool.entries.push(entry)
  return entry
}

vi.mock('./pi-agent-pool', () => ({
  AgentPool: class {
    constructor(host: typeof pool.host) {
      pool.host = host
    }
    launchContext() {
      return pool.launch
    }
    spawn = pool.spawn
    spawnAcp = pool.spawnAcp
    stopEntry = pool.stopEntry
  },
}))
vi.mock('./acp-registry', () => ({
  AcpRegistry: class {
    load = async () => [{ id: 'codex-acp', name: 'Codex' }, { id: 'claude-acp', name: 'Claude Agent' }]
  },
}))
vi.mock('./acp-launch-spec', () => ({ resolveAcpLaunchSpec: () => ({ ok: true, spec: { command: 'npx', args: [] } }) }))
vi.mock('./acp-session-store', () => ({ AcpSessionStore: class { upsert = vi.fn() }, acpRecordToSessionInfo: vi.fn() }))
vi.mock('./settings', () => ({ agentConfigDir: () => '/tmp/pi-agent', saveSelectedModelRoute: vi.fn() }))
vi.mock('./run-profile', () => ({ runProfileCompiler: { compile: vi.fn() } }))
vi.mock('./pi-process', () => ({ loadRpcClient: vi.fn() }))
vi.mock('./app-log', () => ({ appendAppLog: vi.fn(), normalizeError: (err: unknown) => err }))

const { piClientManager } = await import('./pi-client')

describe('control-plane task sessions', () => {
  const events: Array<{ taskId: string; type: string }> = []

  beforeEach(() => {
    pool.entries.length = 0
    pool.launch = { cwd: '/ws' }
    events.length = 0
    pool.spawn.mockReset().mockImplementation(async () => fakeEntry('pi'))
    pool.spawnAcp.mockReset().mockImplementation(async () => fakeEntry('acp'))
    pool.stopEntry.mockReset().mockImplementation(async (entry: unknown) => pool.host?.onEntryRemoved(entry))
    piClientManager.setTaskEventListener((taskId, event) => events.push({ taskId, type: event.type }))
  })

  it('runs an external agent in its own session, in the requested mode, without touching the active one', async () => {
    const result = await piClientManager.startTask({ taskId: 't1', agent: 'codex-acp', prompt: 'fix it', permissionMode: 'read-only' })

    expect(result).toEqual({ sessionId: 'sess-0', agent: 'codex-acp' })
    const entry = pool.entries[0] as { task: { taskId: string }; client: Record<string, ReturnType<typeof vi.fn>> }
    expect(pool.spawnAcp).toHaveBeenCalledWith('codex-acp', 'Codex', { command: 'npx', args: [] })
    expect(entry.task.taskId).toBe('t1')
    expect(entry.client.setPermissionMode).toHaveBeenCalledWith('read-only')
    expect(entry.client.send).toHaveBeenCalledWith('fix it')
    // 前台会话没变:任务会话从没被激活
    expect(piClientManager.getActiveSessionIdentity()).toBeNull()
  })

  it('forwards the task events and stops the process once the run settles', async () => {
    await piClientManager.startTask({ taskId: 't-settle', agent: 'pi', prompt: 'hi' })
    const entry = pool.entries[0]

    pool.host!.handleRuntimeEvent(entry, { type: 'agent_start' } as PiRuntimeEvent)
    pool.host!.handleRuntimeEvent(entry, { type: 'agent_settled' } as PiRuntimeEvent)

    expect(events).toEqual([{ taskId: 't-settle', type: 'agent_start' }, { taskId: 't-settle', type: 'agent_settled' }])
    expect(pool.stopEntry).toHaveBeenCalledWith(entry, 'task settled')
    expect(await piClientManager.cancelTask('t-settle')).toBe(false)
  })

  it('cancels a running task: stops the turn, then the process', async () => {
    await piClientManager.startTask({ taskId: 't2', agent: 'claude-acp', prompt: 'go' })
    const entry = pool.entries[0] as { client: Record<string, ReturnType<typeof vi.fn>> }

    expect(await piClientManager.cancelTask('t2')).toBe(true)
    expect(entry.client.cancel).toHaveBeenCalledWith('task cancelled')
    expect(pool.stopEntry).toHaveBeenCalledWith(entry, 'task cancelled')
  })

  it('cleans up a session that failed to start and lets the same task retry', async () => {
    pool.spawnAcp.mockImplementationOnce(async () => {
      const entry = fakeEntry('acp')
      ;(entry.client as Record<string, ReturnType<typeof vi.fn>>).setPermissionMode.mockRejectedValue(new Error('该 agent 没有「yolo」这个权限模式'))
      return entry
    })

    await expect(
      piClientManager.startTask({ taskId: 't3', agent: 'codex-acp', prompt: 'go', permissionMode: 'yolo' }),
    ).rejects.toThrow('yolo')
    expect(pool.stopEntry).toHaveBeenCalledWith(pool.entries[0], 'task failed to start')
    await expect(piClientManager.startTask({ taskId: 't3', agent: 'codex-acp', prompt: 'go' })).resolves.toBeTruthy()
  })

  it('refuses what it cannot honour instead of guessing', async () => {
    await expect(piClientManager.startTask({ taskId: 'x', agent: 'pi', prompt: 'go', permissionMode: 'plan' })).rejects.toThrow('沙箱')
    await expect(
      piClientManager.startTask({ taskId: 'x', agent: 'gemini-cli' as never, prompt: 'go' }),
    ).rejects.toThrow('不认识')
    await piClientManager.startTask({ taskId: 'dup', agent: 'pi', prompt: 'go' })
    await expect(piClientManager.startTask({ taskId: 'dup', agent: 'pi', prompt: 'go' })).rejects.toThrow('已经在跑')
    pool.launch = null
    await expect(piClientManager.startTask({ taskId: 'y', agent: 'pi', prompt: 'go' })).rejects.toThrow('No workspace')
  })
})
