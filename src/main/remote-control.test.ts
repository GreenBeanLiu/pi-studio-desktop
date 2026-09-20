import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  abort: vi.fn(),
  bash: vi.fn(),
  newSession: vi.fn(),
  getState: vi.fn(),
  getMessages: vi.fn(),
  getAvailableModels: vi.fn(),
  setModel: vi.fn(),
  getWorkspacePath: vi.fn(),
  switchSession: vi.fn(),
  setSessionName: vi.fn(),
  listSessions: vi.fn(),
  loadCachedProviderLabels: vi.fn(),
}))

vi.mock('./pi-client', () => ({
  NO_WORKSPACE_ERROR: 'No workspace is open',
  piClientManager: {
    prompt: mocks.prompt,
    steer: mocks.steer,
    followUp: mocks.followUp,
    abort: mocks.abort,
    bash: mocks.bash,
    newSession: mocks.newSession,
    getState: mocks.getState,
    getMessages: mocks.getMessages,
    getAvailableModels: mocks.getAvailableModels,
    setModel: mocks.setModel,
    getWorkspacePath: mocks.getWorkspacePath,
    switchSession: mocks.switchSession,
    setSessionName: mocks.setSessionName,
  },
}))
vi.mock('./pi-sessions', () => ({ listSessions: mocks.listSessions }))
vi.mock('./routine-cloud-sync', () => ({
  ensureCredential: vi.fn().mockResolvedValue({ token: 'host-token' }),
  routineSyncOrigin: vi.fn().mockReturnValue('https://relay.example'),
}))
vi.mock('./app-log', () => ({
  appendAppLog: vi.fn(),
  normalizeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}))
vi.mock('./model-catalog', () => ({
  ModelCatalogCoordinator: class {
    loadCachedProviderLabels = mocks.loadCachedProviderLabels
  },
}))

import { HOST_EVENT_CHANNELS, LOCAL_TOOL_PROTOCOL, SUPPORTED_COMMANDS, remoteControl } from './remote-control'
import { executeLocalToolOperation, TOOL_GATEWAY_MANIFEST } from './tool-gateway'
import { ToolReceiptLedger } from './tool-receipts'

type Listener = (event: { data?: string; code?: number; reason?: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols?: string | string[]
  readonly sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  closed = false

  close(code?: number): void {
    this.closed = true
    this.emitClose(code)
  }

  /** 中转端主动关闭时会带码(4401/4409),桌面端要据此决定还要不要重连。 */
  emitClose(code?: number, reason = ''): void {
    for (const listener of this.listeners.get('close') ?? []) listener({ code, reason })
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }

  receive(message: unknown): void {
    this.emit('message', JSON.stringify(message))
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>
  }
}

async function connect(): Promise<FakeWebSocket> {
  await remoteControl.enable()
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  ws.emit('open')
  return ws
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.clearAllMocks()
  mocks.loadCachedProviderLabels.mockReturnValue({ providerLabels: {} })
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  remoteControl.setProjectionProvider(null)
  remoteControl.setToolReceiptLedger(null)
})

afterEach(() => {
  remoteControl.disable()
})

describe('remote-control command protocol', () => {
  it('sends host credentials through WebSocket protocols instead of the URL', async () => {
    const ws = await connect()

    expect(ws.url).toBe('wss://relay.example/remote/ws')
    expect(ws.protocols).toEqual(['pi-studio-role.host', 'pi-studio-token.host-token'])
  })

  it('reports the computer identity when creating a pairing code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: '123456', expires_at: 123 }),
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch

    await expect(remoteControl.generatePairingCode()).resolves.toEqual({
      code: '123456',
      expiresAt: 123,
      qrPayload: 'pi-studio://pair?code=123456',
    })
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      device_name: expect.any(String),
      platform: process.platform,
    })
  })

  it('acknowledges prompt only after the agent accepts it', async () => {
    mocks.prompt.mockResolvedValue(undefined)
    const ws = await connect()

    ws.receive({ id: 'phone-a:7', type: 'prompt', text: 'ship it' })

    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith('ship it', undefined))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 'phone-a:7', data: { ok: true } })
  })

  it('pushes a projection snapshot on reconnect and serves session-bound changes', async () => {
    const snapshot = {
      revision: 3,
      messagesRevision: 1,
      asOfSeq: 8,
      workspacePath: '/workspace',
      sessionFile: '/sessions/a.jsonl',
      sessionId: 'session-a',
      source: 'durable-session' as const,
      messages: [],
      tools: {},
      approvals: [],
      updatedAt: null,
    }
    const changes = vi.fn().mockReturnValue({
      sessionId: 'session-a',
      afterSeq: 5,
      asOfSeq: 8,
      resetRequired: false,
      events: [],
    })
    remoteControl.setProjectionProvider({ snapshot: () => snapshot, changes })
    const ws = await connect()

    ws.receive({ type: 'controller_online' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'sessionProjection', snapshot }),
    )

    ws.receive({ id: 'changes-1', type: 'getSessionChanges', sessionId: 'session-a', afterSeq: 5 })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'changes-1',
        data: {
          sessionId: 'session-a',
          afterSeq: 5,
          asOfSeq: 8,
          resetRequired: false,
          events: [],
        },
      }),
    )
    expect(changes).toHaveBeenCalledWith('session-a', 5)
  })

  it('returns command failures in the top-level error field', async () => {
    mocks.prompt.mockRejectedValue(new Error('agent is busy'))
    const ws = await connect()

    ws.receive({ id: 8, type: 'prompt', text: 'run' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 8, error: 'agent is busy' }),
    )
  })

  it('executes a claimed local shell tool operation through the active Pi runtime', async () => {
    mocks.bash.mockResolvedValue({ stdout: 'ok', exitCode: 0 })
    const ws = await connect()

    ws.receive({
      id: 'tool-command-1',
      type: 'executeToolOperation',
      operationId: 'toolop-1',
      toolName: 'shell.exec',
      arguments: { command: ' pwd ' },
    })

    await vi.waitFor(() => expect(mocks.bash).toHaveBeenCalledWith('pwd'))
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'tool-command-1',
        data: { operationId: 'toolop-1', ok: true, result: { stdout: 'ok', exitCode: 0 } },
      }),
    )
  })

  // 控制面断线后回来问"这条写做了没有":账本里 dispatched 在执行前落盘,settled 带着结果在执行后落盘。
  // 没挂账本的桌面(老版本)不宣告 receipts,问回执得到 RECEIPTS_UNAVAILABLE,控制面按老桌面等 deadline。
  describe('tool operation receipts', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pi-remote-receipts-'))
      remoteControl.setToolReceiptLedger(new ToolReceiptLedger(join(dir, 'tool-operations.jsonl')))
    })

    afterEach(() => {
      remoteControl.setToolReceiptLedger(null)
      rmSync(dir, { recursive: true, force: true })
    })

    it('advertises receipts in the tool gateway manifest once a ledger is attached', async () => {
      const ws = await connect()
      ws.receive({ id: 'cap', type: 'capabilities' })
      await vi.waitFor(() => expect(ws.lastSent().id).toBe('cap'))
      expect((ws.lastSent().data as { toolGateway: Record<string, unknown> }).toolGateway).toMatchObject({ manifestVersion: 1, receipts: 1 })
    })

    it('answers unknown for an operation it never received', async () => {
      const ws = await connect()
      ws.receive({ id: 'r0', type: 'toolOperationReceipt', operationId: 'toolop-never' })
      await vi.waitFor(() => expect(ws.lastSent()).toEqual({ type: 'result', id: 'r0', data: { operationId: 'toolop-never', state: 'unknown' } }))
    })

    it('settles the receipt with the result the desktop produced, so a lost ack can be reconciled', async () => {
      mocks.bash.mockResolvedValue({ stdout: 'ok', exitCode: 0 })
      const ws = await connect()
      ws.receive({
        id: 'exec', type: 'executeToolOperation', operationId: 'toolop-w1', toolName: 'shell.exec',
        arguments: { command: 'touch a' }, audit: { task_id: 'task-9', subtask_id: 'sub-1', principal: 'account:acc-1' },
      })
      await vi.waitFor(() => expect(ws.lastSent().id).toBe('exec'))
      ws.receive({ id: 'r1', type: 'toolOperationReceipt', operationId: 'toolop-w1' })
      await vi.waitFor(() => expect(ws.lastSent().id).toBe('r1'))
      expect(ws.lastSent().data).toMatchObject({
        operationId: 'toolop-w1', state: 'settled', ok: true, result: { stdout: 'ok', exitCode: 0 },
        toolName: 'shell.exec', taskId: 'task-9', subtaskId: 'sub-1', principal: 'account:acc-1',
      })
      const lines = readFileSync(join(dir, 'tool-operations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string })
      expect(lines.map((line) => line.kind)).toEqual(['dispatched', 'settled'])
    })

    it('records rejected operations as settled failures with their code', async () => {
      const ws = await connect()
      ws.receive({ id: 'bad', type: 'executeToolOperation', operationId: 'toolop-bad', toolName: 'local.nope' })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'bad', code: 'UNSUPPORTED_TOOL' }))
      ws.receive({ id: 'r2', type: 'toolOperationReceipt', operationId: 'toolop-bad' })
      await vi.waitFor(() => expect(ws.lastSent().id).toBe('r2'))
      expect(ws.lastSent().data).toMatchObject({ state: 'settled', ok: false, code: 'UNSUPPORTED_TOOL' })
    })

    it('refuses to execute when the dispatch receipt cannot be written', async () => {
      // a directory where the ledger file should be: nothing can be appended, so nothing may run
      remoteControl.setToolReceiptLedger(new ToolReceiptLedger(dir))
      mocks.bash.mockResolvedValue({ stdout: 'ok', exitCode: 0 })
      const ws = await connect()
      ws.receive({ id: 'exec2', type: 'executeToolOperation', operationId: 'toolop-w2', toolName: 'shell.exec', arguments: { command: 'touch b' } })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'exec2', code: 'RECEIPT_UNAVAILABLE' }))
      expect(mocks.bash).not.toHaveBeenCalled()
    })

    it('tells a controller when this desktop keeps no receipts', async () => {
      remoteControl.setToolReceiptLedger(null)
      const ws = await connect()
      ws.receive({ id: 'r3', type: 'toolOperationReceipt', operationId: 'toolop-x' })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'r3', code: 'RECEIPTS_UNAVAILABLE' }))
    })
  })

  it('accepts the bash tool alias and args payload for local tool operations', async () => {
    mocks.bash.mockResolvedValue({ stdout: 'ok', exitCode: 0 })
    const ws = await connect()

    ws.receive({
      id: 'tool-command-alias',
      type: 'executeToolOperation',
      operation_id: 'toolop-legacy',
      tool_name: 'bash',
      args: { command: 'echo ok' },
    })

    await vi.waitFor(() => expect(mocks.bash).toHaveBeenCalledWith('echo ok'))
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'tool-command-alias',
        data: { operationId: 'toolop-legacy', ok: true, result: { stdout: 'ok', exitCode: 0 } },
      }),
    )
  })

  it('rejects expired or out-of-scope v2 tool operations before execution', async () => {
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    const ws = await connect()
    const base = {
      type: 'executeToolOperation', operationId: 'toolop-v2', toolName: 'local.read',
      protocolVersion: 2, arguments: { workspace: '/workspace', path: 'note.txt' },
      scope: { workspace: '/workspace', permissions: ['local.read'] },
    }

    ws.receive({ ...base, id: 'expired', deadlineAt: '2020-01-01T00:00:00Z' })
    await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
      id: 'expired', code: 'DEADLINE_EXPIRED', error: 'tool operation deadline expired',
    }))

    ws.receive({
      ...base, id: 'scope', deadlineAt: '2099-01-01T00:00:00Z',
      scope: { workspace: '/other', permissions: ['local.read'] },
    })
    await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'scope', code: 'SCOPE_MISMATCH' }))
  })

  it('accepts the canonical snake_case v2 request fixture at the tool gateway boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-contract-fixture-'))
    mocks.getWorkspacePath.mockReturnValue(workspace)
    writeFileSync(join(workspace, 'README.md'), '# Demo\n')
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'docs/contracts/fixtures/tool-operation-v2-request.json'), 'utf8')) as Record<string, unknown>
    const args = fixture.arguments as Record<string, unknown>
    const scope = fixture.scope as Record<string, unknown>
    args.workspace = workspace
    scope.workspace = workspace
    fixture.deadline_at = '2099-01-01T00:00:00Z'

    try {
      await expect(executeLocalToolOperation(fixture)).resolves.toMatchObject({
        operationId: 'toolop-example-001',
        ok: true,
        result: { content: '# Demo\n', encoding: 'utf-8' },
      })
    } finally {
      mocks.getWorkspacePath.mockReset()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('accepts equivalent Windows workspace spellings in v2 scope', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-remote-scope-'))
    const wireWorkspace = workspace.replaceAll('\\', '/')
    mocks.getWorkspacePath.mockReturnValue(workspace)
    const ws = await connect()
    try {
      // 没有 audit.approved_capabilities 的写操作要被桌面自己拒掉(计划 T4.2)
      ws.receive({
        id: 'normalized-scope-unapproved',
        type: 'executeToolOperation',
        operationId: 'normalized-scope-bad',
        toolName: 'local.write',
        protocolVersion: 2,
        deadlineAt: '2099-01-01T00:00:00Z',
        scope: { workspace: wireWorkspace, permissions: ['local.write'] },
        arguments: { workspace: wireWorkspace, path: 'note.txt', content: 'hello' },
      })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
        id: 'normalized-scope-unapproved', code: 'SCOPE_MISMATCH',
      }))

      ws.receive({
        id: 'normalized-scope',
        type: 'executeToolOperation',
        operationId: 'normalized-scope-op',
        toolName: 'local.write',
        protocolVersion: 2,
        deadlineAt: '2099-01-01T00:00:00Z',
        scope: { workspace: wireWorkspace, permissions: ['local.write'] },
        audit: { approved_capabilities: ['workspace_write'] },
        arguments: { workspace: wireWorkspace, path: 'note.txt', content: 'hello' },
      })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
        id: 'normalized-scope', data: { ok: true, result: { bytes: 5 } },
      }))
    } finally {
      mocks.getWorkspacePath.mockReset()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('requires an exact v2 shell permission before invoking Pi', async () => {
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    mocks.bash.mockResolvedValue({ stdout: 'ok', exitCode: 0 })
    const ws = await connect()
    const base = {
      type: 'executeToolOperation', operationId: 'shell-v2', toolName: 'shell.exec',
      protocolVersion: 2, deadlineAt: '2099-01-01T00:00:00Z',
      arguments: { workspace: '/workspace', command: 'git push origin main' },
      scope: { workspace: '/workspace', permissions: ['shell.exec'], permission: 'shell_read' },
    }

    ws.receive({ ...base, id: 'wrong-shell-scope' })
    await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
      id: 'wrong-shell-scope', code: 'SCOPE_MISMATCH', error: 'shell command requires git_push permission',
    }))
    expect(mocks.bash).not.toHaveBeenCalled()

    // 权限对上了,但没有被批准 —— 会改动的命令仍要拒
    ws.receive({ ...base, id: 'unapproved-shell-scope', scope: { ...base.scope, permission: 'git_push' } })
    await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
      id: 'unapproved-shell-scope', code: 'SCOPE_MISMATCH', error: 'shell command requires approved git_push',
    }))
    expect(mocks.bash).not.toHaveBeenCalled()

    ws.receive({
      ...base, id: 'approved-shell-scope',
      scope: { ...base.scope, permission: 'git_push' },
      audit: { approved_capabilities: ['git_push'] },
    })
    await vi.waitFor(() => expect(mocks.bash).toHaveBeenCalledWith('git push origin main'))
  })

  it('round trips files and propagates file errors through the remote protocol', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-remote-files-'))
    mocks.getWorkspacePath.mockReturnValue(workspace)
    const ws = await connect()
    const base = { type: 'executeToolOperation', operationId: 'file-op' }
    const args = { workspace, path: 'test.txt' }
    try {
      mkdirSync(join(workspace, 'folder'))
      writeFileSync(join(workspace, 'alpha.txt'), 'not returned as content')
      ws.receive({ ...base, id: 'write', toolName: 'local.write', arguments: { ...args, content: 'hello' } })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'write', data: { ok: true, result: { bytes: 5 } } }))
      ws.receive({ ...base, id: 'duplicate', toolName: 'local.write', arguments: { ...args, content: 'replaced' } })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'duplicate', error: expect.stringContaining('EEXIST'), code: 'EEXIST' }))
      ws.receive({ ...base, id: 'read', toolName: 'local.read', arguments: args })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'read', data: { ok: true, result: { content: 'hello' } } }))
      ws.receive({ ...base, id: 'missing', toolName: 'local.read', arguments: { ...args, path: 'missing.txt' } })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({ id: 'missing', code: 'ENOENT' }))
      ws.receive({ ...base, id: 'list', toolName: 'local.list', arguments: { workspace, path: '.', limit: 2 } })
      await vi.waitFor(() => expect(ws.lastSent()).toMatchObject({
        id: 'list', data: { ok: true, result: {
          path: '.', entries: [{ name: 'alpha.txt', type: 'file' }, { name: 'folder', type: 'directory' }], truncated: true,
        } },
      }))
    } finally {
      mocks.getWorkspacePath.mockReset()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects malformed or unsupported local tool operations before touching Pi', async () => {
    const ws = await connect()

    ws.receive({ id: 'tool-command-version', type: 'executeToolOperation', operationId: 'toolop-version', toolName: 'local.read', protocolVersion: 3 })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'tool-command-version',
        error: 'unsupported local tool protocol version: 3',
        code: 'UNSUPPORTED_TOOL_PROTOCOL',
      }),
    )

    ws.receive({ id: 'tool-command-2', type: 'executeToolOperation', operationId: 'toolop-2', toolName: 'local.unknown' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'tool-command-2',
        error: 'unsupported local tool: local.unknown',
        code: 'UNSUPPORTED_TOOL',
      }),
    )

    ws.receive({ id: 'tool-command-3', type: 'executeToolOperation', operationId: 'toolop-3', toolName: 'shell.exec' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'tool-command-3',
        error: 'arguments.command is required',
        code: 'INVALID_TOOL_ARGUMENTS',
      }),
    )
    expect(mocks.bash).not.toHaveBeenCalled()
  })

  // 手机端据此弹「打开工作目录」而不是笼统报一句失败 —— 桌面冷启动后没人点
  // 「打开工作区」时,每条指令都会走到这里。
  it('codes a closed workspace so the phone can offer to open one', async () => {
    mocks.getAvailableModels.mockRejectedValue(new Error('No workspace is open'))
    const ws = await connect()

    ws.receive({ id: 30, type: 'getAvailableModels' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 30,
        error: 'No workspace is open',
        code: 'NO_WORKSPACE',
      }),
    )
  })

  it('renames the current session and rejects an empty name', async () => {
    mocks.setSessionName.mockResolvedValue(undefined)
    const ws = await connect()

    ws.receive({ id: 20, type: 'renameSession', name: '  发布流程  ' })
    await vi.waitFor(() => expect(mocks.setSessionName).toHaveBeenCalledWith('发布流程'))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 20, data: { ok: true } })

    ws.receive({ id: 21, type: 'renameSession', name: '   ' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 21,
        error: 'session name is required',
        code: 'INVALID_NAME',
      }),
    )
    expect(mocks.setSessionName).toHaveBeenCalledTimes(1)
  })

  it('lists sessions for the current workspace', async () => {
    const sessions = [{ path: '/sessions/a.jsonl', id: 'a' }]
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    mocks.getState.mockResolvedValue({ sessionFile: '/sessions/current.jsonl' })
    mocks.listSessions.mockResolvedValue(sessions)
    const ws = await connect()

    ws.receive({ id: 9, type: 'listSessions' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 9, data: sessions }),
    )
    expect(mocks.listSessions).toHaveBeenCalledWith('/sessions', '/workspace')
  })

  it('lets the phone list and open workspaces while none is open', async () => {
    const recent = [{ path: '/Users/me/Works', name: 'Works', lastOpenedAt: '2026-08-08T00:00:00Z' }]
    const open = vi.fn().mockResolvedValue({ ok: true, recentWorkspaces: recent })
    mocks.getWorkspacePath.mockReturnValue(null)
    remoteControl.setWorkspaceHost({ list: () => ({ current: null, recent }), open })
    const ws = await connect()

    ws.receive({ id: 40, type: 'listWorkspaces' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 40,
        data: { current: null, recent },
      }),
    )

    ws.receive({ id: 41, type: 'openWorkspace', path: '  /Users/me/Works  ' })
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('/Users/me/Works'))
    expect(ws.lastSent()).toEqual({
      type: 'result',
      id: 41,
      data: { workspacePath: '/Users/me/Works', recent },
    })
  })

  it('reports repository-aware workspace inventory to the runtime', async () => {
    const inventory = vi.fn().mockResolvedValue([{
      path: '/Users/me/Works/pi-studio',
      name: 'pi-studio',
      kind: 'git',
      repository: 'GreenBeanLiu/pi-studio-desktop',
      defaultRef: 'master',
    }])
    remoteControl.setWorkspaceHost({
      list: () => ({ current: null, recent: [] }),
      open: vi.fn(),
      inventory,
    })
    const ws = await connect()

    ws.receive({ id: 44, type: 'workspaceInventory' })

    await vi.waitFor(() => expect(inventory).toHaveBeenCalledOnce())
    expect(ws.lastSent()).toEqual({
      type: 'result',
      id: 44,
      data: [{
        path: '/Users/me/Works/pi-studio',
        name: 'pi-studio',
        kind: 'git',
        repository: 'GreenBeanLiu/pi-studio-desktop',
        defaultRef: 'master',
      }],
    })
  })

  it('reports a rejected workspace path and a failed open separately', async () => {
    const open = vi.fn().mockResolvedValue({ error: '启动工作区失败' })
    remoteControl.setWorkspaceHost({ list: () => ({ current: null, recent: [] }), open })
    const ws = await connect()

    ws.receive({ id: 42, type: 'openWorkspace', path: '   ' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 42,
        error: 'workspace path is required',
        code: 'INVALID_PATH',
      }),
    )
    expect(open).not.toHaveBeenCalled()

    ws.receive({ id: 43, type: 'openWorkspace', path: '/broken' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 43,
        error: '启动工作区失败',
        code: 'OPEN_WORKSPACE_FAILED',
      }),
    )
  })

  // NAT 超时/Wi-Fi 漫游不产生 close,中转早把这个 host 踢了、手机显示离线,
  // 而桌面 socket 还是 ESTABLISHED —— 只靠 close 事件重连的话永远醒不过来。
  it('pings the relay and reconnects once the link goes silent', async () => {
    vi.useFakeTimers()
    try {
      const ws = await connect()
      const sentBefore = ws.sent.length

      await vi.advanceTimersByTimeAsync(25_000)
      expect(JSON.parse(ws.sent[sentBefore])).toEqual({ type: 'ping' })

      // 一直没有任何回包 —— 越过判死线后应主动关掉这条,交给重连
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ws.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a pong as liveness, not as an unknown command', async () => {
    const ws = await connect()
    const sentBefore = ws.sent.length

    ws.receive({ type: 'pong' })

    await vi.waitFor(() => expect(ws.sent.length).toBe(sentBefore))
  })

  it('keeps non-agent desktop events off the chat event channel', async () => {
    const ws = await connect()

    remoteControl.forwardHostEvent('routines:stepProgress', { routineId: 'r1', stepIndex: 2 })

    expect(ws.lastSent()).toEqual({
      type: 'hostEvent',
      channel: 'routines:stepProgress',
      payload: { routineId: 'r1', stepIndex: 2 },
    })
  })

  it('advertises the commands it supports', async () => {
    const ws = await connect()

    ws.receive({ id: 50, type: 'capabilities' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 50,
        data: {
          commands: [...SUPPORTED_COMMANDS], hostEvents: [...HOST_EVENT_CHANNELS],
          localTools: ['shell.exec', 'bash', 'local.list', 'local.read', 'local.write', 'verify.checks'], localFileMaxBytes: 65536,
          toolProtocol: LOCAL_TOOL_PROTOCOL,
          toolGateway: {
            manifestVersion: 1,
            operationProtocols: [1, 2],
            tools: [...TOOL_GATEWAY_MANIFEST.tools],
          },
        },
      }),
    )
  })

  // 指令是一条条加的,清单漏一条,手机就会把一个其实可用的功能藏起来 —— 而且
  // 没人会注意到,因为不报错。让每条声明过的指令都真的走到 switch 里。
  it('answers every command it advertises', async () => {
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    mocks.getState.mockResolvedValue({ isStreaming: false, sessionFile: null })
    mocks.listSessions.mockResolvedValue([])
    remoteControl.setWorkspaceHost({ list: () => ({ current: null, recent: [] }), open: vi.fn() })
    remoteControl.setReviewHost({ list: () => [], respond: () => ({ ok: true }) })
    remoteControl.setRoutineHost({
      list: () => ({ routines: [], runs: [], runningIds: [], queuedIds: [], progress: [] }),
      run: () => ({ ok: true }),
      toggle: () => ({ ok: true }),
    })
    remoteControl.setImageHost({
      health: async () => ({ ok: true, model: 'gpt-image-2' }),
      generate: async () => ({ urls: [] }),
      history: async () => [],
    })
    remoteControl.setVideoHost({
      health: async () => ({ ok: true, model: 'kling-v1' }),
      list: () => [],
      start: vi.fn(),
    })
    const ws = await connect()

    for (const [index, command] of SUPPORTED_COMMANDS.entries()) {
      const id = `cap-${index}`
      ws.receive({ id, type: command })
      await vi.waitFor(() => expect(ws.lastSent().id).toBe(id))
      expect(ws.lastSent()).not.toMatchObject({ code: 'UNKNOWN_COMMAND' })
    }
  })

  // 一张图的 base64 有几 MB。它进了 WebSocket 帧,中转和手机一起遭殃 —— 结果只能带链接。
  it('sends generated images as links, never as base64', async () => {
    const generate = vi.fn().mockResolvedValue({
      urls: ['https://cdn.example/a.png'],
      dataUrl: `data:image/png;base64,${'A'.repeat(5000)}`,
      publicUrl: 'https://cdn.example/a.png',
    })
    remoteControl.setImageHost({
      health: async () => ({ ok: true, model: 'gpt-image-2' }),
      generate,
      history: async () => [],
    })
    const ws = await connect()

    ws.receive({ id: 80, type: 'imageGenerate', prompt: '一只猫', n: 1, aspectRatio: '1:1' })

    await vi.waitFor(() =>
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '一只猫', n: 1, aspectRatio: '1:1' }),
      ),
    )
    expect(ws.lastSent()).toEqual({
      type: 'result',
      id: 80,
      data: { urls: ['https://cdn.example/a.png'] },
    })
    expect(JSON.stringify(ws.lastSent())).not.toContain('base64')
  })

  it('refuses an empty prompt and passes a generation failure through', async () => {
    remoteControl.setImageHost({
      health: async () => ({ ok: true, model: '' }),
      generate: async () => ({ error: '云端中继 429' }),
      history: async () => ({ error: '连不上云端历史服务' }),
    })
    const ws = await connect()

    ws.receive({ id: 81, type: 'imageGenerate', prompt: '   ' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 81,
        error: 'prompt is required',
        code: 'INVALID_PROMPT',
      }),
    )

    ws.receive({ id: 82, type: 'imageGenerate', prompt: '猫' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 82,
        error: '云端中继 429',
        code: 'IMAGE_GEN_FAILED',
      }),
    )

    ws.receive({ id: 83, type: 'imageGenHistory' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 83,
        error: '连不上云端历史服务',
        code: 'IMAGE_HISTORY_FAILED',
      }),
    )
  })

  // 视频一次要跑 5~20 分钟。挂一条长请求等着的话,手机切后台或换网就断了、结果就丢了,
  // 所以发起必须立刻返回,进度和结果走 video:job 事件。
  it('returns a video job immediately instead of holding the request', async () => {
    const job = {
      id: 'v1',
      prompt: '一只橘猫趴在窗台上',
      duration: 5,
      aspectRatio: '16:9',
      mode: 'std',
      status: 'running' as const,
      stage: 'submitting',
      createdAt: 1,
    }
    const start = vi.fn().mockReturnValue(job)
    remoteControl.setVideoHost({
      health: async () => ({ ok: true, model: 'kling-v1' }),
      list: () => [job],
      start,
    })
    const ws = await connect()

    ws.receive({ id: 90, type: 'klingVideoStart', prompt: '一只橘猫趴在窗台上', duration: 5 })

    await vi.waitFor(() =>
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一只橘猫趴在窗台上', duration: 5 })),
    )
    expect(ws.lastSent()).toEqual({ type: 'result', id: 90, data: job })

    // 重连后要能把还在跑的补回来 —— 事件是一次性的,断线期间推的那些收不到
    ws.receive({ id: 91, type: 'listVideoJobs' })
    await vi.waitFor(() => expect(ws.lastSent()).toEqual({ type: 'result', id: 91, data: [job] }))
  })

  it('rejects a video request with no prompt', async () => {
    remoteControl.setVideoHost({
      health: async () => ({ ok: true, model: 'kling-v1' }),
      list: () => [],
      start: vi.fn(),
    })
    const ws = await connect()

    ws.receive({ id: 92, type: 'klingVideoStart', prompt: '   ' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 92,
        error: 'prompt is required',
        code: 'INVALID_PROMPT',
      }),
    )
  })

  it('gives the phone a routine list, a manual run and an on/off switch', async () => {
    const snapshot = {
      routines: [
        {
          id: 'r1',
          name: '每日日报',
          enabled: true,
          stepCount: 3,
          schedule: { type: 'daily' as const, time: '09:00' },
          workspacePath: '/Users/me/Works',
          createdAt: 1,
          lastRunAt: 2,
        },
      ],
      runs: [],
      runningIds: ['r1'],
      queuedIds: [],
      progress: [
        { routineId: 'r1', stepId: 's2', stepIndex: 1, totalSteps: 3, status: 'running' as const },
      ],
    }
    const run = vi.fn().mockReturnValue({ ok: true })
    const toggle = vi.fn().mockReturnValue({ ok: true })
    remoteControl.setRoutineHost({ list: () => snapshot, run, toggle })
    const ws = await connect()

    ws.receive({ id: 70, type: 'listRoutines' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 70, data: snapshot }),
    )

    ws.receive({ id: 71, type: 'runRoutine', routineId: 'r1' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('r1'))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 71, data: { ok: true } })

    ws.receive({ id: 72, type: 'toggleRoutine', routineId: 'r1', enabled: false })
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith('r1', false))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 72, data: { ok: true } })
  })

  // 「不存在」「正在跑」「到并发上限」在手机上是三种不同的提示
  it('passes the reason a manual run was refused through to the phone', async () => {
    remoteControl.setRoutineHost({
      list: () => ({ routines: [], runs: [], runningIds: [], queuedIds: [], progress: [] }),
      run: () => ({ error: '该任务正在执行或排队', code: 'ROUTINE_BUSY' }),
      toggle: () => ({ ok: true }),
    })
    const ws = await connect()

    ws.receive({ id: 73, type: 'runRoutine', routineId: 'r1' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 73,
        error: '该任务正在执行或排队',
        code: 'ROUTINE_BUSY',
      }),
    )

    ws.receive({ id: 74, type: 'runRoutine' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 74,
        error: 'routineId is required',
        code: 'INVALID_ROUTINE',
      }),
    )
  })

  // review 节点阻塞整条工作流,超时就是全挂 —— 手机必须能应,也必须能在重连后补上
  it('hands pending reviews to the phone and applies its decision', async () => {
    const request = {
      reviewId: 'rv1',
      routineId: 'r1',
      routineName: '公众号草稿',
      stepId: 's3',
      stepName: '人工确认',
      message: '确认后继续',
      preview: '草稿正文…',
    }
    const respond = vi.fn().mockReturnValue({ ok: true })
    remoteControl.setReviewHost({ list: () => [request], respond })
    const ws = await connect()

    ws.receive({ id: 60, type: 'listPendingReviews' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 60, data: [request] }),
    )

    ws.receive({ id: 61, type: 'respondReview', reviewId: 'rv1', decision: 'reject', comment: '图不对' })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('rv1', 'reject', '图不对'))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 61, data: { ok: true } })
  })

  it('separates an expired review from a malformed one', async () => {
    remoteControl.setReviewHost({
      list: () => [],
      respond: () => ({ error: '审核请求已过期或工作流已结束' }),
    })
    const ws = await connect()

    ws.receive({ id: 62, type: 'respondReview', reviewId: 'rv1', decision: 'maybe' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 62,
        error: 'reviewId and a valid decision are required',
        code: 'INVALID_REVIEW',
      }),
    )

    ws.receive({ id: 63, type: 'respondReview', reviewId: 'gone', decision: 'approve' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 63,
        error: '审核请求已过期或工作流已结束',
        code: 'REVIEW_GONE',
      }),
    )
  })

  it('resets phone pairings with the installation token in the authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch

    await expect(remoteControl.resetPairings()).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/remote/pair/reset',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer host-token' },
      }),
    )
    expect(fetchMock.mock.calls[0][0]).not.toContain('host-token')
  })

  it('labels the current model in the initial host state', async () => {
    mocks.getState.mockResolvedValue({
      isStreaming: false,
      model: { provider: 'openai', id: 'gpt-5.5' },
    })
    mocks.loadCachedProviderLabels.mockReturnValue({
      providerLabels: { openai: '3A API' },
    })
    const ws = await connect()

    ws.receive({ id: 'state-1', type: 'getState' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 'state-1',
        data: {
          isStreaming: false,
          model: { provider: 'openai', providerLabel: '3A API', id: 'gpt-5.5' },
        },
      }),
    )
  })

  it('lists available models and applies a model selected by the phone', async () => {
    const models = [
      { provider: 'openai', id: 'gpt-5.6', contextWindow: 200_000, reasoning: true },
      { provider: 'deepseek', id: 'deepseek-chat', contextWindow: 64_000, reasoning: false },
    ]
    mocks.getAvailableModels.mockResolvedValue(models)
    mocks.loadCachedProviderLabels.mockReturnValue({
      providerLabels: { openai: '3A API', deepseek: 'DeepSeek 官方' },
    })
    mocks.setModel.mockResolvedValue({ provider: 'deepseek', id: 'deepseek-chat' })
    const ws = await connect()

    ws.receive({ id: 10, type: 'getAvailableModels' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 10,
        data: [
          { ...models[0], providerLabel: '3A API' },
          { ...models[1], providerLabel: 'DeepSeek 官方' },
        ],
      }),
    )

    ws.receive({ id: 11, type: 'setModel', provider: 'deepseek', model: 'deepseek-chat' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 11,
        data: { provider: 'deepseek', id: 'deepseek-chat' },
      }),
    )
    expect(mocks.setModel).toHaveBeenCalledWith('deepseek', 'deepseek-chat')
  })

  it('rejects remote model switching while the agent is running', async () => {
    mocks.getState.mockResolvedValue({ isStreaming: true })
    const ws = await connect()

    ws.receive({ id: 12, type: 'setModel', provider: 'openai', model: 'gpt-5.6' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 12,
        error: 'cannot switch model while agent is running',
        code: 'MODEL_SWITCH_WHILE_RUNNING',
      }),
    )
    expect(mocks.setModel).not.toHaveBeenCalled()
  })
})

// 2026-08-19: 桌面日志里刷出 1298 条 "Remote control host connected",密集时每 5 秒
// 一条。close 处理器过去把 code 整个丢掉,4401(配对失效)和 4409(被新 host 顶掉)
// 都当成普通掉线无脑重连 —— 前者永远撞不开,后者会和另一台机器每 5 秒互踢。
// 心跳看门狗对此完全无感:连接不是静默,是被对端主动关的。
describe('remote-control reconnect policy', () => {
  it('stops reconnecting when the relay rejects the installation token', async () => {
    vi.useFakeTimers()
    try {
      const ws = await connect()
      const before = FakeWebSocket.instances.length

      ws.emitClose(4401)
      await vi.advanceTimersByTimeAsync(15_000)

      expect(FakeWebSocket.instances.length).toBe(before)
      expect(remoteControl.snapshot().status).toBe('error')
      expect(remoteControl.snapshot().lastError).toContain('重新配对')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not steal the room back after another host supersedes it', async () => {
    vi.useFakeTimers()
    try {
      const ws = await connect()
      const before = FakeWebSocket.instances.length

      ws.emitClose(4409)
      await vi.advanceTimersByTimeAsync(15_000)

      expect(FakeWebSocket.instances.length).toBe(before)
      expect(remoteControl.snapshot().lastError).toContain('接管')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reconnects after an ordinary drop that carries no code', async () => {
    vi.useFakeTimers()
    try {
      const ws = await connect()
      const before = FakeWebSocket.instances.length

      ws.emitClose(undefined)
      await vi.advanceTimersByTimeAsync(6_000)

      expect(FakeWebSocket.instances.length).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})
