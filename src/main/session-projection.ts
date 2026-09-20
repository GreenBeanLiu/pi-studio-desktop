import { createHash } from 'crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ApprovalProjection,
  ExtensionUiResponse,
  SessionProjectionChanges,
  SessionProjectionSnapshot,
  StudioAgentEvent,
  ToolExecutionProjection,
} from '../shared/ipc/contract'

export type SessionProjectionLoad = {
  generation: number
  workspacePath: string
  sessionFile: string | null
  sessionId: string
}

const INITIAL_SNAPSHOT: SessionProjectionSnapshot = {
  revision: 0,
  messagesRevision: 0,
  asOfSeq: 0,
  workspacePath: null,
  sessionFile: null,
  sessionId: null,
  source: 'durable-session',
  messages: [],
  tools: {},
  approvals: [],
  updatedAt: null,
}

type RuntimeEvent = { type: string; [key: string]: unknown }

// 快照上线只带这么多条消息(计划 T2.4);更大的会话用 getMessagesPage 往前翻。
const PROJECTION_WIRE_WINDOW = 400

const EVENT_TYPES: Record<string, StudioAgentEvent['type']> = {
  agent_start: 'agent.started',
  agent_end: 'agent.ended',
  agent_settled: 'agent.settled',
  message_start: 'message.started',
  message_update: 'message.updated',
  message_end: 'message.finished',
  tool_execution_start: 'tool.started',
  tool_execution_update: 'tool.updated',
  tool_execution_end: 'tool.finished',
  extension_ui_request: 'approval.requested',
  run_failed: 'run.failed',
}

function withoutType(event: RuntimeEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type'))
}

function parseApprovalMessage(message: string): { command?: string; reason?: string } {
  const command =
    message.match(/(?:^|\n)Command:\s*(.+)/i)?.[1]?.trim() ??
    message.match(/命令[:：]\s*\n+([\s\S]*?)(?:\n\s*\n\s*原因[:：]|$)/)?.[1]?.trim()
  const reason =
    message.match(/(?:^|\n)Reason:\s*(.+)/i)?.[1]?.trim() ??
    message.match(/原因[:：]\s*([\s\S]*?)(?:\n\s*\n|$)/)?.[1]?.trim()
  return { command, reason }
}

function stringField(event: RuntimeEvent, name: string): string {
  return typeof event[name] === 'string' ? event[name] : ''
}

function approvalAction(toolName: string): ApprovalProjection['action'] {
  const tool = toolName.toLowerCase()
  if (tool === 'read' || tool === 'grep' || tool === 'find' || tool === 'ls') return 'read'
  if (tool === 'write' || tool === 'edit') return 'write'
  if (tool.includes('bash') || tool.includes('shell') || tool.includes('command')) return 'execute'
  if (tool.includes('web') || tool.includes('http') || tool.includes('search')) return 'network'
  if (tool.includes('credential') || tool.includes('secret')) return 'credential'
  return 'external-side-effect'
}

function messageTime(message: { timestamp?: unknown }, fallback: string): string {
  if (typeof message.timestamp !== 'number') return fallback
  const date = new Date(message.timestamp)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function projectDurableTools(
  sessionId: string,
  messages: AgentMessage[],
  now: string,
): SessionProjectionSnapshot['tools'] {
  const tools: SessionProjectionSnapshot['tools'] = {}
  for (const message of messages as unknown as Array<Record<string, unknown>>) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string') continue
        tools[part.id] = {
          callId: part.id,
          sessionId,
          runId: null,
          toolName: typeof part.name === 'string' ? part.name : '',
          args: part.arguments,
          status: 'running',
          startedAt: messageTime(message, now),
        }
      }
      continue
    }
    if (message.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue
    const current = tools[message.toolCallId]
    tools[message.toolCallId] = {
      callId: message.toolCallId,
      sessionId,
      runId: current?.runId ?? null,
      toolName:
        typeof message.toolName === 'string' ? message.toolName : current?.toolName ?? '',
      args: current?.args,
      status: message.isError ? 'error' : 'done',
      result: message.content,
      details: message.details,
      artifact:
        (message.details as { artifact?: ToolExecutionProjection['artifact'] } | undefined)?.artifact,
      startedAt: current?.startedAt ?? messageTime(message, now),
      endedAt: messageTime(message, now),
    }
  }
  return tools
}

export class SessionProjectionTracker {
  private generation = 0
  private snap: SessionProjectionSnapshot = INITIAL_SNAPSHOT
  private nextSeq = 0
  private events: StudioAgentEvent[] = []
  private eventSizes: number[] = []
  private eventBytes = 0
  private discardedThroughSeq = 0
  private activeRunId: string | null = null
  private durableFingerprint: string | null = null

  snapshot(): SessionProjectionSnapshot {
    return this.snap
  }

  /**
   * What goes on the wire: for a very large session, only the tail of `messages`, with the
   * offset so a client can page the rest. The full list stays in this process (plan T2.4).
   */
  wireSnapshot(): SessionProjectionSnapshot {
    const messages = this.snap.messages
    if (messages.length <= PROJECTION_WIRE_WINDOW) return this.snap
    const offset = messages.length - PROJECTION_WIRE_WINDOW
    return { ...this.snap, messages: messages.slice(offset), messagesTruncated: true, olderMessagesOffset: offset }
  }

  messagesPage(offset: number, limit: number): AgentMessage[] {
    const start = Math.max(0, Math.trunc(offset))
    return this.snap.messages.slice(start, start + Math.max(0, Math.trunc(limit)))
  }

  isCurrentLoad(load: SessionProjectionLoad): boolean {
    return load.generation === this.generation
  }

  beginLoad(
    workspacePath: string,
    sessionFile: string | null,
    sessionId = sessionFile ?? `${workspacePath}:session`,
  ): SessionProjectionLoad {
    const generation = ++this.generation
    if (
      this.snap.workspacePath !== workspacePath ||
      this.snap.sessionFile !== sessionFile ||
      this.snap.sessionId !== sessionId
    ) {
      this.events = []
      this.eventSizes = []
      this.eventBytes = 0
      this.discardedThroughSeq = this.nextSeq
      this.activeRunId = null
      this.durableFingerprint = null
      const event = this.append(sessionId, 'session.changed', { workspacePath, sessionFile })
      this.snap = {
        revision: this.snap.revision + 1,
        messagesRevision: this.snap.messagesRevision + 1,
        asOfSeq: event.seq,
        workspacePath,
        sessionFile,
        sessionId,
        source: 'durable-session',
        messages: [],
        tools: {},
        approvals: [],
        updatedAt: null,
      }
    }
    return { generation, workspacePath, sessionFile, sessionId }
  }

  commit(load: SessionProjectionLoad, messages: AgentMessage[]): SessionProjectionSnapshot {
    if (load.generation !== this.generation) return this.snap
    const fingerprint = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    if (fingerprint === this.durableFingerprint) return this.snap
    this.durableFingerprint = fingerprint
    const updatedAt = new Date().toISOString()
    const tools = projectDurableTools(load.sessionId, messages, updatedAt)
    let asOfSeq = this.append(load.sessionId, 'conversation.replaced', {
      messageCount: messages.length,
      snapshotRequired: true,
    }).seq
    for (const tool of Object.values(tools)) {
      const startedTool = {
        callId: tool.callId,
        sessionId: tool.sessionId,
        runId: tool.runId,
        toolName: tool.toolName,
        args: tool.args,
        status: 'running' as const,
        startedAt: tool.startedAt,
      }
      asOfSeq = this.append(load.sessionId, 'tool.started', { tool: startedTool }).seq
      if (tool.status !== 'running') {
        asOfSeq = this.append(load.sessionId, 'tool.finished', { tool }).seq
      }
    }
    this.snap = {
      revision: this.snap.revision + 1,
      messagesRevision: this.snap.messagesRevision + 1,
      asOfSeq,
      workspacePath: load.workspacePath,
      sessionFile: load.sessionFile,
      sessionId: load.sessionId,
      source: 'durable-session',
      messages,
      tools,
      approvals: this.snap.approvals,
      updatedAt,
    }
    return this.snap
  }

  restoreApprovals(
    load: SessionProjectionLoad,
    approvals: ApprovalProjection[],
    ownedApprovalIds: ReadonlySet<string> = new Set(),
    now = new Date().toISOString(),
  ): SessionProjectionSnapshot {
    if (load.generation !== this.generation) return this.snap
    const matching = approvals
      .filter((approval) => approval.sessionId === load.sessionId)
      .map((approval) =>
        approval.outcome === 'pending' && !ownedApprovalIds.has(approval.id)
          ? {
              ...approval,
              outcome: 'unavailable' as const,
              resolvedAt: now,
              error: '应用已重启，原审批请求不可再响应',
            }
          : approval,
      )
    if (JSON.stringify(matching) === JSON.stringify(this.snap.approvals)) return this.snap
    const event = this.append(load.sessionId, 'approvals.replaced', { approvals: matching })
    this.snap = {
      ...this.snap,
      revision: this.snap.revision + 1,
      asOfSeq: event.seq,
      approvals: matching,
    }
    return this.snap
  }

  changes(sessionId: string | null, afterSeq: number): SessionProjectionChanges {
    const firstSeq = this.events[0]?.seq
    const canObserveClear =
      this.snap.sessionId === null &&
      this.events.some(
        (event) =>
          event.seq > afterSeq && event.type === 'session.cleared' && event.sessionId === sessionId,
      )
    const resetRequired =
      (sessionId !== this.snap.sessionId && !canObserveClear) ||
      afterSeq > this.snap.asOfSeq ||
      afterSeq < this.discardedThroughSeq ||
      (firstSeq !== undefined && afterSeq < firstSeq - 1)
    return {
      sessionId: this.snap.sessionId,
      afterSeq,
      asOfSeq: this.snap.asOfSeq,
      resetRequired,
      events: resetRequired ? [] : this.events.filter((event) => event.seq > afterSeq),
    }
  }

  ingest(
    sessionId: string,
    runtimeEvent: RuntimeEvent,
    now = new Date().toISOString(),
  ): { accepted: boolean; event: StudioAgentEvent; projectionChanged: boolean } {
    if (sessionId !== this.snap.sessionId) {
      return {
        accepted: false,
        event: {
          seq: this.snap.asOfSeq,
          sessionId,
          type: EVENT_TYPES[runtimeEvent.type] ?? 'agent.event',
          data: withoutType(runtimeEvent),
        },
        projectionChanged: false,
      }
    }

    this.generation++

    const normalizedType = EVENT_TYPES[runtimeEvent.type] ?? 'agent.event'
    const callId = stringField(runtimeEvent, 'toolCallId')
    const currentTool = callId ? this.snap.tools[callId] : undefined
    let liveTool: SessionProjectionSnapshot['tools'][string] | undefined
    if (runtimeEvent.type === 'tool_execution_start' && callId) {
      liveTool = {
        callId,
        sessionId,
        runId: this.activeRunId,
        toolName: stringField(runtimeEvent, 'toolName'),
        args: runtimeEvent.args,
        status: 'running',
        startedAt: now,
      }
    } else if (runtimeEvent.type === 'tool_execution_update' && currentTool) {
      const partialResult = runtimeEvent.partialResult
      liveTool = {
        ...currentTool,
        result: partialResult,
        details: (partialResult as { details?: unknown } | undefined)?.details,
        artifact: (partialResult as { details?: { artifact?: ToolExecutionProjection['artifact'] } } | undefined)?.details?.artifact,
      }
    } else if (runtimeEvent.type === 'tool_execution_end' && callId) {
      const result = runtimeEvent.result
      liveTool = {
        callId,
        sessionId,
        runId: currentTool?.runId ?? this.activeRunId,
        toolName: stringField(runtimeEvent, 'toolName') || currentTool?.toolName || '',
        args: currentTool?.args,
        status: runtimeEvent.isError ? 'error' : 'done',
        result,
        details: (result as { details?: unknown } | undefined)?.details,
        artifact: (result as { details?: { artifact?: ToolExecutionProjection['artifact'] } } | undefined)?.details?.artifact,
        startedAt: currentTool?.startedAt ?? now,
        endedAt: now,
      }
    }
    const event = this.append(
      sessionId,
      normalizedType,
      liveTool ? { tool: liveTool } : withoutType(runtimeEvent),
    )
    let projectionChanged = false

    if (runtimeEvent.type === 'agent_start') {
      this.activeRunId = `${sessionId}:${event.seq}`
    } else if (runtimeEvent.type === 'agent_settled') {
      this.activeRunId = null
    } else if (liveTool) {
      this.snap = {
        ...this.snap,
        tools: { ...this.snap.tools, [liveTool.callId]: liveTool },
      }
      projectionChanged = true
    } else if (
      runtimeEvent.type === 'extension_ui_request' &&
      runtimeEvent.method === 'confirm'
    ) {
      const id = stringField(runtimeEvent, 'id')
      if (id) {
        const message = stringField(runtimeEvent, 'message')
        const parsed = parseApprovalMessage(message)
        const runningTools = Object.values(this.snap.tools).filter(
          (tool) => tool.status === 'running' && tool.runId === this.activeRunId,
        )
        const commandMatches = parsed.command
          ? runningTools.filter((tool) => {
              const args = tool.args as { command?: unknown } | undefined
              return typeof args?.command === 'string' && args.command.trim() === parsed.command
            })
          : []
        // Never guess by event order when tools run concurrently. A synthetic
        // correlation id still makes the approval auditable without falsely
        // attributing it to an unrelated call.
        const activeTool =
          commandMatches.length === 1
            ? commandMatches[0]
            : !parsed.command && runningTools.length === 1
              ? runningTools[0]
              : undefined
        const toolName = activeTool?.toolName || (parsed.command ? 'bash' : 'extension')
        const approval: ApprovalProjection = {
          id,
          sessionId,
          runId: this.activeRunId,
          callId: activeTool?.callId ?? null,
          correlation: activeTool
            ? { kind: 'tool-call', id: activeTool.callId }
            : { kind: 'extension-request', id },
          tool: toolName,
          action: approvalAction(toolName),
          policy: { decision: 'ask', reason: parsed.reason },
          title: stringField(runtimeEvent, 'title'),
          message,
          ...parsed,
          createdAt: now,
          outcome: 'pending',
        }
        this.snap = {
          ...this.snap,
          approvals: [approval, ...this.snap.approvals.filter((item) => item.id !== id)].slice(0, 50),
        }
        projectionChanged = true
      }
    }

    this.snap = {
      ...this.snap,
      revision: this.snap.revision + 1,
      asOfSeq: event.seq,
    }
    return { accepted: true, event, projectionChanged }
  }

  resolveApproval(
    sessionId: string,
    id: string,
    response: ExtensionUiResponse,
    now = new Date().toISOString(),
  ): { accepted: boolean; event: StudioAgentEvent; projectionChanged: boolean } {
    const current = this.snap.approvals.find((approval) => approval.id === id)
    const outcome: ApprovalProjection['outcome'] =
      'confirmed' in response
        ? response.confirmed
          ? 'allowed-once'
          : 'rejected'
        : 'cancelled' in response
          ? 'cancelled'
          : 'unavailable'
    if (sessionId !== this.snap.sessionId || !current) {
      return {
        accepted: false,
        event: {
          seq: this.snap.asOfSeq,
          sessionId,
          type: 'approval.decided',
          data: { id, outcome, resolvedAt: now },
        },
        projectionChanged: false,
      }
    }
    this.generation++
    const event = this.append(sessionId, 'approval.decided', { id, outcome, resolvedAt: now })
    this.snap = {
      ...this.snap,
      revision: this.snap.revision + 1,
      asOfSeq: event.seq,
      approvals: this.snap.approvals.map((approval) =>
        approval.id === id ? { ...approval, outcome, resolvedAt: now } : approval,
      ),
    }
    return { accepted: true, event, projectionChanged: true }
  }

  cancelPendingApprovals(
    sessionId: string,
    reason: string,
    now = new Date().toISOString(),
  ): ApprovalProjection[] {
    if (sessionId !== this.snap.sessionId) return []
    const changed = this.snap.approvals
      .filter((approval) => approval.outcome === 'pending')
      .map((approval) => ({
        ...approval,
        outcome: 'cancelled' as const,
        resolvedAt: now,
        error: reason,
      }))
    if (changed.length === 0) return []
    this.generation++
    const byId = new Map(changed.map((approval) => [approval.id, approval]))
    let asOfSeq = this.snap.asOfSeq
    for (const approval of changed) {
      asOfSeq = this.append(sessionId, 'approval.decided', {
        id: approval.id,
        outcome: approval.outcome,
        resolvedAt: now,
        error: reason,
      }).seq
    }
    this.snap = {
      ...this.snap,
      revision: this.snap.revision + 1,
      asOfSeq,
      approvals: this.snap.approvals.map((approval) => byId.get(approval.id) ?? approval),
    }
    return changed
  }

  private append(
    sessionId: string,
    type: StudioAgentEvent['type'],
    data: Record<string, unknown>,
  ): StudioAgentEvent {
    const event = { seq: ++this.nextSeq, sessionId, type, data }
    this.events.push(event)
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    } catch {
      bytes = 1_024
    }
    this.eventSizes.push(bytes)
    this.eventBytes += bytes
    while (this.events.length > 1_000 || this.eventBytes > 2 * 1024 * 1024) {
      const discarded = this.events.shift()
      if (discarded) this.discardedThroughSeq = discarded.seq
      this.eventBytes -= this.eventSizes.shift() ?? 0
    }
    return event
  }

  clear(): SessionProjectionSnapshot {
    this.generation++
    if (
      this.snap.workspacePath === null &&
      this.snap.sessionFile === null &&
      this.snap.messages.length === 0
    ) {
      return this.snap
    }
    const event = this.snap.sessionId
      ? this.append(this.snap.sessionId, 'session.cleared', {})
      : null
    this.snap = {
      ...INITIAL_SNAPSHOT,
      revision: this.snap.revision + 1,
      messagesRevision: this.snap.messagesRevision + 1,
      asOfSeq: event?.seq ?? this.snap.asOfSeq,
    }
    this.activeRunId = null
    this.durableFingerprint = null
    return this.snap
  }
}
