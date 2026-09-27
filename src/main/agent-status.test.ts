import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentStatusTracker, pruneStaleRuntimeStatus } from './agent-status'

describe('agent status tracker', () => {
  it('projects runtime events into a status file', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.prompt('fix the failing test')
    tracker.observe({ type: 'agent_start' })
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: false })
    tracker.observe({
      type: 'tool_execution_start',
      toolName: 'update_agent_todo',
      args: {
        items: [
          { id: '1', content: 'inspect', status: 'completed' },
          { id: '2', content: 'implement', status: 'in_progress' },
          { id: '3', content: 'verify', status: 'pending' },
        ],
      },
    })
    tracker.observe({ type: 'extension_ui_request', method: 'confirm' })
    tracker.approvalResolved()
    const snapshot = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
    expect(snapshot).toMatchObject({
      cwd: 'D:/workspace',
      phase: 'running',
      prompt: 'fix the failing test',
      tools: { read: 1, update_agent_todo: 1 },
      todo: { pending: 1, inProgress: 1, completed: 1 },
      activeApprovals: 0,
    })
    tracker.dispose()
  })

  it('waits for agent_start and rolls back a rejected prompt safely', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-prompt-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    const first = tracker.prompt('first task')
    expect(tracker.snapshot()).toMatchObject({ prompt: 'first task', phase: 'idle', startedAt: null })
    expect(tracker.promptRejected(first)).toBe(true)
    expect(tracker.snapshot()).toMatchObject({ prompt: null, phase: 'idle', startedAt: null })

    const older = tracker.prompt('older task')
    const newer = tracker.prompt('newer task')
    expect(tracker.promptRejected(newer)).toBe(true)
    expect(tracker.snapshot().prompt).toBe('older task')
    expect(tracker.promptRejected(older)).toBe(true)
    expect(tracker.snapshot().prompt).toBeNull()

    const accepted = tracker.prompt('accepted task')
    tracker.observe({ type: 'agent_start' })
    expect(tracker.promptRejected(accepted)).toBe(false)
    expect(tracker.snapshot()).toMatchObject({ prompt: 'accepted task', phase: 'running' })
    tracker.dispose()
  })

  it('resets run-scoped counters when a new run starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-new-run-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.prompt('first task')
    tracker.observe({ type: 'agent_start' })
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: true, result: { error: 'failed' } })
    tracker.observe({ type: 'extension_ui_request', method: 'confirm' })
    tracker.observe({
      type: 'tool_execution_start',
      toolName: 'update_agent_todo',
      args: { items: [{ id: '1', content: 'inspect', status: 'completed' }] },
    })

    tracker.observe({ type: 'agent_settled' })
    tracker.prompt('second task')
    tracker.observe({ type: 'agent_start' })

    expect(tracker.snapshot()).toMatchObject({
      prompt: 'second task',
      phase: 'running',
      tools: {},
      todo: { pending: 0, inProgress: 0, completed: 0 },
      failures: 0,
      repeatedFailures: 0,
      activeApprovals: 0,
      loopDetected: null,
    })
    tracker.dispose()
  })

  it('does not write the status file for unrelated streaming events', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-streaming-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    const write = vi.spyOn(tracker, 'write')
    tracker.observe({ type: 'message_update' })
    tracker.observe({ type: 'message_update' })
    expect(write).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('returns a detached snapshot for IPC consumers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-snapshot-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    const snapshot = tracker.snapshot()
    snapshot.tools.read = 99
    snapshot.todo.completed = 99
    expect(tracker.snapshot()).toMatchObject({ tools: { read: 1 }, todo: { completed: 0 } })
    tracker.dispose()
  })

  it('counts only consecutive identical failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-failures-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.observe({ type: 'agent_start' })
    for (let i = 0; i < 2; i += 1) {
      tracker.observe({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { error: 'failed' } })
    }
    expect(tracker.snapshot()).toMatchObject({ failures: 2, repeatedFailures: 1 })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: false, result: { content: 'ok' } })
    tracker.observe({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { error: 'failed' } })
    expect(tracker.snapshot()).toMatchObject({ failures: 3, repeatedFailures: 1 })
    tracker.dispose()
  })
})

describe('pruneStaleRuntimeStatus', () => {
  it('removes crash-leftover status files and reports the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-status-prune-'))
    writeFileSync(join(dir, 'a.json'), '{}', 'utf8')
    writeFileSync(join(dir, 'b.json'), '{}', 'utf8')

    expect(pruneStaleRuntimeStatus(dir)).toBe(2)
    expect(readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op when the directory does not exist yet', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pi-studio-status-none-')), 'missing')
    expect(existsSync(dir)).toBe(false)
    expect(pruneStaleRuntimeStatus(dir)).toBe(0)
  })

  it('a live tracker removes its own file on dispose, so a clean stop leaves nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-status-clean-'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'status.json')
    const tracker = new AgentStatusTracker(file, 'D:/workspace')
    tracker.observe({ type: 'agent_start' })
    expect(existsSync(file)).toBe(true)
    tracker.dispose()
    expect(existsSync(file)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
