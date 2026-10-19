type RuntimeEvent = {
  type: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
}

export type LoopDetection = {
  kind: 'repeated-call' | 'repeated-failure'
  signature: string
  count: number
  message: string
}

type PendingCall = { signature: string | null; toolName: string; serial: boolean }

function isEmptyArgs(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
}

export type AgentLoopGuardOptions = {
  repeatedCallThreshold?: number
  repeatedFailureThreshold?: number
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return [record.error, record.message, record.text, record.content].map(textOf).filter(Boolean).join('\n')
  }
  return String(value)
}

export class AgentLoopGuard {
  private readonly repeatedCallThreshold: number
  private readonly repeatedFailureThreshold: number
  private pending = new Map<string, PendingCall>()
  private lastSignature: string | null = null
  private repeatedCallCount = 0
  private lastFailure: string | null = null
  private repeatedFailureCount = 0
  private detected = false

  constructor(options: AgentLoopGuardOptions = {}) {
    this.repeatedCallThreshold = options.repeatedCallThreshold ?? 4
    this.repeatedFailureThreshold = options.repeatedFailureThreshold ?? 3
  }

  observe(event: RuntimeEvent): LoopDetection | null {
    if (event.type === 'agent_start') {
      this.pending.clear()
      this.lastSignature = null
      this.repeatedCallCount = 0
      this.lastFailure = null
      this.repeatedFailureCount = 0
      this.detected = false
      return null
    }
    if (event.type === 'agent_settled') {
      this.pending.clear()
      return null
    }
    if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
      this.pending.set(event.toolCallId, {
        toolName: event.toolName,
        // ACP agent(Claude Code / Codex)开始时参数常常还是 {},完整参数在后续 update 里才到。
        // 没有参数就没法说「参数相同」—— 2026-10-19 一个 Claude Code 任务连跑 4 条不同的 Bash,
        // 全记成 `Bash:{}`,被当成死循环掐掉了。
        signature: isEmptyArgs(event.args) ? null : `${event.toolName}:${stable(event.args)}`,
        // Calls started while another tool is active may be an intentional parallel batch.
        serial: this.pending.size === 0,
      })
      return null
    }
    if (event.type !== 'tool_execution_end' || !event.toolCallId) return null
    const call = this.pending.get(event.toolCallId)
    this.pending.delete(event.toolCallId)
    if (!call) return null

    if (call.serial && call.signature !== null && call.signature === this.lastSignature) this.repeatedCallCount += 1
    else if (call.serial && call.signature !== null) {
      this.lastSignature = call.signature
      this.repeatedCallCount = 1
    } else {
      this.lastSignature = null
      this.repeatedCallCount = 0
    }

    const failure = event.isError ? `${call.toolName}:${textOf(event.result).trim().slice(0, 500)}` : null
    if (call.serial && failure && failure === this.lastFailure) this.repeatedFailureCount += 1
    else if (call.serial && failure) {
      this.lastFailure = failure
      this.repeatedFailureCount = 1
    } else if (call.serial) {
      this.lastFailure = null
      this.repeatedFailureCount = 0
    } else {
      this.lastFailure = null
      this.repeatedFailureCount = 0
    }

    if (this.detected) return null
    if (this.repeatedFailureCount >= this.repeatedFailureThreshold && failure) {
      this.detected = true
      return {
        kind: 'repeated-failure',
        signature: failure,
        count: this.repeatedFailureCount,
        message: `${call.toolName} returned the same error ${this.repeatedFailureCount} times`,
      }
    }
    if (this.repeatedCallCount >= this.repeatedCallThreshold) {
      this.detected = true
      return {
        kind: 'repeated-call',
        signature: call.signature ?? call.toolName,
        count: this.repeatedCallCount,
        message: `${call.toolName} was called with the same arguments ${this.repeatedCallCount} times`,
      }
    }
    return null
  }
}
