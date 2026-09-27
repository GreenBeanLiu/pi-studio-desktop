import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPool, type AgentPoolRuntimeLauncher } from './pi-agent-pool'
import type { AgentPoolHost } from './pi-agent-pool'
import type { LaunchContext } from './pi-agent-entry'
import type { PiAgentRunHandle } from './pi-runtime'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

let userData = ''

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))

function launchContext(): LaunchContext {
  return {
    kind: 'chat',
    cwd: 'D:\\repo',
    provider: 'openai',
    model: 'gpt-test',
    env: { PI_CODING_AGENT_DIR: 'D:\\agent' },
    cliPath: 'C:\\pi\\cli.js',
    args: [],
    thinkingLevel: 'high',
    sandboxMode: null,
    sandboxSessionPaths: false,
    security: {
      requested: 'full-access',
      filesystemMode: 'danger-full-access',
      networkMode: 'unrestricted',
      backend: 'host',
      enforcement: 'none',
      hostCodeExecution: false,
      reason: 'test',
    },
    declaredCapabilities: { subagents: true },
    profileDigest: 'digest',
  }
}

function host(): AgentPoolHost {
  return {
    currentWorkspacePath: () => 'D:\\repo',
    isActive: () => true,
    handleRuntimeEvent: vi.fn(),
    onEntryRemoved: vi.fn(),
    emitStatus: vi.fn(),
    emitActivity: vi.fn(),
  }
}

function expectRuntimeEventListener(
  value: unknown,
): asserts value is (event: PiRuntimeEvent) => void {
  expect(value).toEqual(expect.any(Function))
}

function client(overrides: Record<string, unknown> = {}): PiAgentRunHandle {
  return {
    capabilities: {
      engine: 'pi',
      engineVersion: '0.84.2-test',
      protocolVersion: 'rpc-v1',
      sessionFormatVersion: 'pi-jsonl-v1',
      handshake: { verified: true, state: true, messages: true, commands: true },
      features: {
        listSessions: true,
        resume: true,
        fork: false,
        subagents: true,
        images: true,
        compact: true,
        approvals: true,
        sessionRead: true,
      },
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    respondExtensionUi: vi.fn(),
    conversation: vi.fn(() => null),
    observeProcess: vi.fn(),
    processId: vi.fn(() => 42),
    dispose: vi.fn(async () => {}),
    forceDispose: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: null })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    ...overrides,
  } as unknown as PiAgentRunHandle
}

describe('AgentPool runtime host seam', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pi-agent-pool-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('launches chat sessions through the injected runtime host while keeping pool-owned env', async () => {
    const launched: Array<{ profile: LaunchContext; audit: Record<string, unknown> | undefined }> = []
    const runtimeClient = client({
      getState: vi.fn(async () => ({
        sessionId: 'session-1',
        sessionFile: 'D:\\agent\\sessions\\session.jsonl',
      })),
      switchSession: vi.fn(async () => ({ cancelled: false })),
    })
    const launchRuntime: AgentPoolRuntimeLauncher = vi.fn(async (profile, options) => {
      launched.push({ profile, audit: options?.audit })
      return { client: runtimeClient }
    })
    const pool = new AgentPool(host(), launchRuntime)
    pool.setLaunch(launchContext())

    const entry = await pool.spawn('D:\\agent\\sessions\\previous.jsonl')

    expect(entry.client).toBe(runtimeClient)
    expect(entry.pi).toBe(runtimeClient)
    expect(launchRuntime).toHaveBeenCalledOnce()
    expect(launched[0].audit).toEqual({
      source: 'chat-pool',
      requestedSessionFile: 'D:\\agent\\sessions\\previous.jsonl',
    })
    expect(launched[0].profile).toMatchObject({
      kind: 'chat',
      cwd: 'D:\\repo',
      env: {
        PI_CODING_AGENT_DIR: 'D:\\agent',
        PI_STUDIO_STATUS_FILE: expect.stringContaining('runtime-status'),
        PI_STUDIO_ARTIFACT_DIR: join(userData, 'pi-agent', 'artifacts'),
        PI_STUDIO_ARTIFACT_WORKSPACE_KEY: expect.any(String),
      },
    })
    expect(runtimeClient.switchSession).toHaveBeenCalledWith('D:\\agent\\sessions\\previous.jsonl')
    expect(entry.sessionId).toBe('session-1')
    expect(entry.sessionFile).toBe('D:\\agent\\sessions\\session.jsonl')
  })

  it('passes raw runtime events back to the pool host', async () => {
    const observed: { listener?: (event: PiRuntimeEvent) => void } = {}
    const runtimeClient = client({
      getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: null })),
      onEvent: vi.fn((next: (event: PiRuntimeEvent) => void) => {
        observed.listener = next
        return () => {
          observed.listener = undefined
        }
      }),
    })
    const runtimeHost = vi.fn(async () => ({ client: runtimeClient }))
    const poolHost = host()
    const pool = new AgentPool(poolHost, runtimeHost)
    pool.setLaunch(launchContext())

    const entry = await pool.spawn(null)
    expectRuntimeEventListener(observed.listener)
    observed.listener({ type: 'agent_start' } as PiRuntimeEvent)

    expect(poolHost.handleRuntimeEvent).toHaveBeenCalledWith(entry, { type: 'agent_start' })
  })
})

type ProcessHandlers = {
  exit?: (code: number | null, signal: string | null) => void
}

/**
 * session 生命周期的行为测试:从 AgentPool 这个 kernel 拥有层验证
 * start → events → switch → stop → crash,断言 observable outcome
 * (host 回调、job 快照、find 结果),不直接摸内部数组。
 */
describe('session lifecycle behaviour', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pi-agent-pool-life-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  function sessionClient(sessionFile: string): PiAgentRunHandle {
    return client({ getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile })) })
  }

  it('stops a session by releasing its job and removing it from the pool', async () => {
    const runtimeClient = sessionClient('D:\\agent\\sessions\\a.jsonl')
    const poolHost = host()
    const pool = new AgentPool(poolHost, vi.fn(async () => ({ client: runtimeClient })))
    pool.setLaunch(launchContext())

    const entry = await pool.spawn(null)
    expect(pool.find('D:\\agent\\sessions\\a.jsonl')).toBe(entry)
    expect(pool.liveAgentCount()).toBe(1)

    await pool.stopEntry(entry, 'workspace closed')

    expect(runtimeClient.dispose).toHaveBeenCalledOnce()
    expect(poolHost.onEntryRemoved).toHaveBeenCalledWith(entry)
    expect(pool.find('D:\\agent\\sessions\\a.jsonl')).toBeUndefined()
    expect(pool.liveAgentCount()).toBe(0)
    expect(pool.agentJobs().every((job) => job.state === 'done')).toBe(true)
  })

  it('offers the existing entry for a session path so a switch does not spawn again', async () => {
    const launchRuntime = vi.fn(async () => ({ client: sessionClient('D:\\agent\\sessions\\a.jsonl') }))
    const pool = new AgentPool(host(), launchRuntime)
    pool.setLaunch(launchContext())

    await pool.spawn(null)

    // 路径写法不同也要认出是同一个会话(否则切换会给它再起一个进程)
    expect(pool.find('D:/agent/sessions/a.jsonl')).toBeDefined()
    expect(pool.find('D:\\agent\\sessions\\other.jsonl')).toBeUndefined()
    expect(launchRuntime).toHaveBeenCalledOnce()
  })

  it('marks an unexpected exit as a crash and reports it for the active session', async () => {
    const handlers: ProcessHandlers = {}
    const runtimeClient = client({
      getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: 'D:\\agent\\sessions\\a.jsonl' })),
      observeProcess: vi.fn((next: ProcessHandlers) => {
        Object.assign(handlers, next)
      }),
    })
    const poolHost = host() // isActive → true
    const pool = new AgentPool(poolHost, vi.fn(async () => ({ client: runtimeClient })))
    pool.setLaunch(launchContext())

    await pool.spawn(null)
    handlers.exit?.(1, null)

    expect(poolHost.emitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'exited', code: 1, expected: false }),
    )
    expect(pool.find('D:\\agent\\sessions\\a.jsonl')).toBeUndefined()
  })

  it('reports a background crash as activity, not as a foreground error', async () => {
    const handlers: ProcessHandlers = {}
    const runtimeClient = client({
      getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: 'D:\\agent\\sessions\\a.jsonl' })),
      observeProcess: vi.fn((next: ProcessHandlers) => {
        Object.assign(handlers, next)
      }),
    })
    const poolHost = { ...host(), isActive: () => false }
    const pool = new AgentPool(poolHost, vi.fn(async () => ({ client: runtimeClient })))
    pool.setLaunch(launchContext())

    await pool.spawn(null)
    handlers.exit?.(1, null)

    expect(poolHost.emitActivity).toHaveBeenCalledWith({
      sessionFile: 'D:\\agent\\sessions\\a.jsonl',
      running: false,
    })
    expect(poolHost.emitStatus).not.toHaveBeenCalled()
  })
})
