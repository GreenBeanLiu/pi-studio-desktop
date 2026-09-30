import { describe, expect, it, vi } from 'vitest'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import { UnattendedApprovalGate } from './approval-gateway'
import type { AgentEntry } from './pi-agent-entry'
import { EventProjection, type EventProjectionHost } from './pi-event-projection'

vi.mock('./app-log', () => ({ appendAppLog: vi.fn(), normalizeError: (err: unknown) => err }))

function entry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    client: { respondExtensionUi: vi.fn() },
    pi: null,
    acp: { agentId: 'codex-acp', agentName: 'Codex' },
    firstMessage: null,
    job: { observeRun: vi.fn(), isRunActive: () => false, touch: vi.fn() },
    sessionFile: null,
    sessionId: 'sess-1',
    unsubscribe: null,
    pendingUi: [],
    outstandingUi: new Map(),
    subagentJobs: new Map(),
    statusFile: '/tmp/status.json',
    status: { observe: vi.fn(), loopDetected: vi.fn() },
    loopGuard: { observe: () => null },
    ...overrides,
  } as unknown as AgentEntry
}

function host(active: AgentEntry | null): EventProjectionHost & {
  emitEvent: ReturnType<typeof vi.fn>
  emitTaskEvent: ReturnType<typeof vi.fn>
  emitActivity: ReturnType<typeof vi.fn>
} {
  return {
    currentWorkspacePath: () => '/ws',
    isActive: (candidate) => candidate === active,
    emitEvent: vi.fn(),
    emitActivity: vi.fn(),
    emitTaskEvent: vi.fn(),
    registerSubagentJob: vi.fn(),
  }
}

const APPROVAL = {
  type: 'extension_ui_request',
  id: 'perm-1',
  method: 'select',
  title: 'Allow Codex to run `rm -rf build`?',
  options: ['Allow once', 'Reject'],
} as unknown as PiRuntimeEvent

describe('task sessions in the event projection', () => {
  it('sends every event of a task session to the control plane, never into the chat UI', () => {
    const task = entry({ task: { taskId: 'task-1', gate: new UnattendedApprovalGate() } })
    const h = host(null)
    const projection = new EventProjection(h)
    const started = { type: 'agent_start' } as PiRuntimeEvent
    projection.handleEvent(task, started)
    expect(h.emitTaskEvent).toHaveBeenCalledWith(task, started)
    expect(h.emitEvent).not.toHaveBeenCalled()
    expect(h.emitActivity).not.toHaveBeenCalled()
  })

  it('stays out of the chat UI even if the task session happens to be the active one', () => {
    const task = entry({ task: { taskId: 'task-1', gate: new UnattendedApprovalGate() } })
    const h = host(task)
    new EventProjection(h).handleEvent(task, { type: 'agent_start' } as PiRuntimeEvent)
    expect(h.emitEvent).not.toHaveBeenCalled()
  })

  it('answers a blocking approval at once instead of parking it until someone opens the session', () => {
    const gate = new UnattendedApprovalGate()
    const task = entry({ task: { taskId: 'task-1', gate } })
    const h = host(null)
    new EventProjection(h).handleEvent(task, APPROVAL)
    expect(task.client.respondExtensionUi).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'perm-1',
      cancelled: true,
    })
    expect(task.pendingUi).toEqual([])
    expect(task.outstandingUi.has('perm-1')).toBe(false)
    expect(gate.denied().map((item) => item.id)).toEqual(['perm-1'])
    // 控制面也收到了这条请求,知道 agent 被拦过
    expect(h.emitTaskEvent).toHaveBeenCalledWith(task, APPROVAL)
  })

  it('leaves ordinary background sessions as before: approvals wait for the user', () => {
    const background = entry()
    const h = host(null)
    new EventProjection(h).handleEvent(background, APPROVAL)
    expect(background.client.respondExtensionUi).not.toHaveBeenCalled()
    expect(background.pendingUi).toEqual([APPROVAL])
    expect(h.emitTaskEvent).not.toHaveBeenCalled()
  })
})
