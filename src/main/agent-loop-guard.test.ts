import { describe, expect, it } from 'vitest'
import { AgentLoopGuard } from './agent-loop-guard'

const start = { type: 'agent_start' }

function call(id: string, args = { path: 'src/a.ts' }) {
  return { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args }
}

function end(id: string, isError = false, result: unknown = 'ok') {
  return { type: 'tool_execution_end', toolCallId: id, toolName: 'read', isError, result }
}

describe('agent loop guard', () => {
  it('detects the same tool call repeated four times', () => {
    const guard = new AgentLoopGuard()
    guard.observe(start)
    for (let i = 1; i < 4; i += 1) {
      expect(guard.observe(call(String(i)))).toBeNull()
      expect(guard.observe(end(String(i)))).toBeNull()
    }
    expect(guard.observe(call('4'))).toBeNull()
    const detection = guard.observe(end('4'))
    expect(detection).toMatchObject({ kind: 'repeated-call', count: 4 })
  })

  it('detects the same error repeated three times', () => {
    const guard = new AgentLoopGuard()
    guard.observe(start)
    for (let i = 1; i < 3; i += 1) {
      guard.observe(call(String(i)))
      expect(guard.observe(end(String(i), true, { error: 'not found' }))).toBeNull()
    }
    guard.observe(call('3'))
    expect(guard.observe(end('3', true, { error: 'not found' }))).toMatchObject({
      kind: 'repeated-failure',
      count: 3,
    })
  })

  it('does not treat a parallel batch as a repeated serial loop', () => {
    const guard = new AgentLoopGuard({ repeatedCallThreshold: 2 })
    guard.observe(start)
    guard.observe(call('1'))
    guard.observe(call('2'))
    expect(guard.observe(end('1'))).toBeNull()
    expect(guard.observe(end('2'))).toBeNull()
  })

  // 2026-10-19 回归:ACP agent 开始时参数是 {},4 条不同的 Bash 被记成同一个签名、整轮被掐掉。
  it('does not call it a loop when the arguments are not known yet', () => {
    const guard = new AgentLoopGuard()
    guard.observe(start)
    for (let i = 1; i <= 6; i += 1) {
      guard.observe({ type: 'tool_execution_start', toolCallId: String(i), toolName: 'Bash', args: {} })
      expect(guard.observe({ type: 'tool_execution_end', toolCallId: String(i), toolName: 'Bash', isError: false, result: 'ok' })).toBeNull()
    }
  })

  it('still catches the same error repeating when the arguments are unknown', () => {
    const guard = new AgentLoopGuard()
    guard.observe(start)
    let detection: ReturnType<AgentLoopGuard["observe"]> = null
    for (let i = 1; i <= 3; i += 1) {
      guard.observe({ type: 'tool_execution_start', toolCallId: String(i), toolName: 'Bash', args: {} })
      detection = guard.observe({ type: 'tool_execution_end', toolCallId: String(i), toolName: 'Bash', isError: true, result: 'permission denied' })
    }
    expect(detection).toMatchObject({ kind: 'repeated-failure', count: 3 })
  })

  it('resets counters at the beginning of the next run', () => {
    const guard = new AgentLoopGuard({ repeatedCallThreshold: 2 })
    guard.observe(start)
    guard.observe(call('1'))
    guard.observe(end('1'))
    guard.observe(start)
    guard.observe(call('2'))
    expect(guard.observe(end('2'))).toBeNull()
  })
})
