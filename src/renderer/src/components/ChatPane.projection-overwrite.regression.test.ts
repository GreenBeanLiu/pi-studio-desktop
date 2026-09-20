import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  AgentMessage,
  ApprovalProjection,
  SessionProjectionSnapshot,
  ToolExecutionProjection,
} from '../../../shared/ipc/contract'
import { planProjectionApply } from './chat-projection'

// 2026-08-23: 提一个问题,画面刷一下,刚打的字就没了。用户消息和流式回复是本地
// 靠 message_start/update 拼出来的,而运行途中每个工具事件都会广播一份 projection
// —— 那份 snapshot.messages 还停在上一次落库的内容。原来这里无条件覆盖。
//
// 2026-08-30: 判断逻辑抽到 chat-projection.ts 之后,这里从「读源码文本 grep」
// 改成了真的喂 projection 进去看它算出什么。

function message(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage
}

function tool(callId: string, toolName: string): ToolExecutionProjection {
  return { callId, sessionId: 's1', runId: 'r1', toolName, status: 'running', startedAt: '2026-08-30T00:00:00Z' }
}

function approval(id: string, outcome: ApprovalProjection['outcome']): ApprovalProjection {
  return {
    id,
    sessionId: 's1',
    runId: 'r1',
    callId: null,
    correlation: { kind: 'tool-call', id },
    tool: 'bash',
    action: 'execute',
    policy: { decision: 'ask' },
    title: '执行命令',
    message: 'rm -rf build',
    createdAt: '2026-08-30T00:00:00Z',
    outcome,
  }
}

function projection(over: Partial<SessionProjectionSnapshot> = {}): SessionProjectionSnapshot {
  return {
    revision: 7,
    messagesRevision: 3,
    asOfSeq: 42,
    workspacePath: '/w',
    sessionFile: null,
    sessionId: 's1',
    source: 'durable-session',
    messages: [message('落库里的旧消息')],
    tools: { a: tool('a', 'bash') },
    approvals: [approval('ap1', 'pending')],
    updatedAt: '2026-08-30T00:00:00Z',
    ...over,
  }
}

describe('projection 不能盖掉正在进行的对话', () => {
  it('messagesRevision 没变时不给出消息替换计划', () => {
    const plan = planProjectionApply(projection({ revision: 99 }), {
      workspacePath: '/w',
      appliedMessagesRevision: 3,
    })
    expect(plan.kind).toBe('apply')
    // messages 为 null = 别碰本地列表。这就是当初丢字的那一下。
    expect(plan.kind === 'apply' && plan.messages).toBeNull()
  })

  it('messagesRevision 变了才替换,并带上要记录的新 revision', () => {
    const plan = planProjectionApply(projection({ messagesRevision: 4 }), {
      workspacePath: '/w',
      appliedMessagesRevision: 3,
    })
    expect(plan.kind === 'apply' && plan.messages).toEqual({
      list: [message('落库里的旧消息')],
      revision: 4,
    })
  })

  it('工具和审批每份 projection 都要落地 —— 哪怕消息被挡住', () => {
    const plan = planProjectionApply(projection(), {
      workspacePath: '/w',
      appliedMessagesRevision: 3,
    })
    if (plan.kind !== 'apply') throw new Error('应当 apply')
    expect(plan.messages).toBeNull()
    expect(plan.tools).toEqual({ a: { toolName: 'bash', args: undefined, status: 'running', result: undefined, details: undefined, artifact: undefined } })
    expect(plan.approvals).toHaveLength(1)
    expect(plan.approvals[0]).toMatchObject({ id: 'ap1', status: 'pending', message: 'rm -rf build' })
  })

  it('冷启动(还没记过 revision)照常整份铺开', () => {
    const plan = planProjectionApply(projection(), {
      workspacePath: '/w',
      appliedMessagesRevision: null,
    })
    expect(plan.kind === 'apply' && plan.messages?.revision).toBe(3)
  })

  it('不是当前工作区的 projection 整份丢弃', () => {
    expect(
      planProjectionApply(projection({ workspacePath: '/other' }), {
        workspacePath: '/w',
        appliedMessagesRevision: 3,
      }).kind,
    ).toBe('ignore')
    // 没开工作区时也不能落地
    expect(
      planProjectionApply(projection(), { workspacePath: undefined, appliedMessagesRevision: null })
        .kind,
    ).toBe('ignore')
  })

  it.each([
    ['pending', 'pending'],
    ['allowed-once', 'allowed'],
    ['unavailable', 'error'],
    ['rejected', 'denied'],
    ['cancelled', 'denied'],
  ] as const)('审批 outcome %s 映射成 %s', (outcome, status) => {
    const plan = planProjectionApply(projection({ approvals: [approval('ap1', outcome)] }), {
      workspacePath: '/w',
      appliedMessagesRevision: 3,
    })
    expect(plan.kind === 'apply' && plan.approvals[0].status).toBe(status)
  })
})

// 剩下的一点接线还测不了:streamingIndex 是组件里的 ref。清空它必须发生在
// 「真的替换了消息」这一支里 —— 否则后续 message_update 会当成新消息 append,
// 同一条回复在界面上出现两次。
describe('handler 接线', () => {
  const chatPane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8')

  it('只在 plan.messages 非空时清 streamingIndex', () => {
    const branch = chatPane.slice(chatPane.indexOf('if (plan.messages) {'))
    const body = branch.slice(0, branch.indexOf('setToolExecutions'))
    expect(body).toContain('streamingIndexRef.current = null')
    expect(body).toContain('applyProjectionMessages(plan.messages.list')
    expect(body).toContain('appliedMessagesRevisionRef.current = plan.messages.revision')
  })

  it('工具和审批在那个分支之外无条件应用', () => {
    const handler = chatPane.slice(chatPane.indexOf('api.pi.onSessionProjection((projection)'))
    const body = handler.slice(0, handler.indexOf('}, [workspace?.path])'))
    const branchClose = body.lastIndexOf('}', body.indexOf('setToolExecutions'))
    expect(branchClose).toBeLessThan(body.indexOf('setToolExecutions'))
    expect(body).toContain('setApprovalRequests(plan.approvals)')
  })
})
