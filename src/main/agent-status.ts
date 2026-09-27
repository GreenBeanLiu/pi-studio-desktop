import type { AgentStatusTodo } from '../shared/ipc/contract'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

type RuntimeEvent = {
  type: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  method?: string
}

type TodoItem = { id?: unknown; content?: unknown; status?: unknown }

/** 一条 TODO 最多留这么长 —— 状态要进模型上下文,别让它被一条超长任务撑爆。 */
const MAX_TODO_CONTENT = 200

/**
 * 从 update_agent_todo 的入参里取出清单。
 * 只留计数的话,界面就只能显示 "TODO 0/0",看不出到底在做什么、卡在哪一条。
 */
function todoState(args: unknown): AgentStatusSnapshot['todo'] | null {
  if (!args || typeof args !== 'object') return null
  const raw = (args as { items?: unknown }).items
  if (!Array.isArray(raw)) return null
  const state: AgentStatusSnapshot['todo'] = { pending: 0, inProgress: 0, completed: 0, items: [] }
  for (const item of raw as TodoItem[]) {
    const status = item?.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    if (status === 'pending') state.pending += 1
    else if (status === 'in_progress') state.inProgress += 1
    else state.completed += 1
    state.items.push({
      id: typeof item.id === 'string' ? item.id : String(state.items.length),
      content: (typeof item.content === 'string' ? item.content : '').slice(0, MAX_TODO_CONTENT),
      status,
    })
  }
  return state
}

export type AgentPromptCheckpoint = {
  epoch: number
  runEpoch: number
}

export type AgentStatusSnapshot = {
  version: 1
  cwd: string
  phase: 'idle' | 'running' | 'awaiting_approval' | 'stopped'
  prompt: string | null
  todo: AgentStatusTodo
  tools: Record<string, number>
  failures: number
  repeatedFailures: number
  activeApprovals: number
  startedAt: number | null
  updatedAt: string
  loopDetected: string | null
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

export class AgentStatusTracker {
  private readonly snap: AgentStatusSnapshot
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFailureSignature: string | null = null
  private promptEpoch = 0
  private runEpoch = 0
  private basePrompt: string | null = null
  private readonly pendingPrompts = new Map<number, string>()
  private dirty = true

  constructor(private readonly file: string, cwd: string) {
    this.snap = {
      version: 1,
      cwd,
      phase: 'idle',
      prompt: null,
      todo: { pending: 0, inProgress: 0, completed: 0, items: [] },
      tools: {},
      failures: 0,
      repeatedFailures: 0,
      activeApprovals: 0,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      loopDetected: null,
    }
    this.timer = setInterval(() => {
      if (this.dirty) this.write()
    }, 1_000)
    this.timer.unref?.()
  }

  snapshot(): AgentStatusSnapshot {
    return {
      ...this.snap,
      todo: { ...this.snap.todo, items: this.snap.todo.items.map((item) => ({ ...item })) },
      tools: { ...this.snap.tools },
    }
  }

  prompt(message: string): AgentPromptCheckpoint {
    if (this.pendingPrompts.size === 0) this.basePrompt = this.snap.prompt
    const epoch = ++this.promptEpoch
    this.pendingPrompts.set(epoch, message.slice(0, 500))
    this.snap.prompt = this.latestPendingPrompt() ?? this.basePrompt
    this.write()
    return { epoch, runEpoch: this.runEpoch }
  }

  promptRejected(checkpoint: AgentPromptCheckpoint): boolean {
    if (checkpoint.runEpoch !== this.runEpoch || !this.pendingPrompts.delete(checkpoint.epoch)) {
      return false
    }
    this.snap.prompt = this.latestPendingPrompt() ?? this.basePrompt
    this.write()
    return true
  }

  private latestPendingPrompt(): string | null {
    let latestEpoch = -1
    let latest: string | null = null
    for (const [epoch, prompt] of this.pendingPrompts) {
      if (epoch > latestEpoch) {
        latestEpoch = epoch
        latest = prompt
      }
    }
    return latest
  }

  private acceptPendingPrompts(): void {
    this.pendingPrompts.clear()
    this.basePrompt = this.snap.prompt
  }

  approvalResolved(): void {
    this.snap.activeApprovals = Math.max(0, this.snap.activeApprovals - 1)
    if (this.snap.phase === 'awaiting_approval' && this.snap.activeApprovals === 0) {
      this.snap.phase = 'running'
    }
    this.write()
  }

  observe(event: RuntimeEvent): void {
    let changed = true
    if (event.type === 'agent_start') {
      this.runEpoch += 1
      this.acceptPendingPrompts()
      this.snap.phase = 'running'
      this.snap.todo = { pending: 0, inProgress: 0, completed: 0, items: [] }
      this.snap.tools = {}
      this.snap.failures = 0
      this.snap.repeatedFailures = 0
      this.snap.activeApprovals = 0
      this.snap.startedAt = Date.now()
      this.snap.loopDetected = null
      this.lastFailureSignature = null
    } else if (event.type === 'agent_settled') {
      this.acceptPendingPrompts()
      this.snap.phase = 'idle'
      this.snap.startedAt = null
      this.snap.activeApprovals = 0
    } else if (
      event.type === 'extension_ui_request' &&
      ['confirm', 'select', 'input', 'editor'].includes(event.method ?? '')
    ) {
      this.snap.phase = 'awaiting_approval'
      this.snap.activeApprovals += 1
    } else if (event.type === 'tool_execution_start' && event.toolName) {
      this.snap.tools[event.toolName] = (this.snap.tools[event.toolName] ?? 0) + 1
      if (event.toolName === 'update_agent_todo') {
        const todo = todoState(event.args)
        if (todo) this.snap.todo = todo
      }
    } else if (event.type === 'tool_execution_end') {
      if (event.isError) {
        this.snap.failures += 1
        const signature = `${event.toolName ?? 'tool'}:${textOf(event.result).trim().slice(0, 500)}`
        if (signature === this.lastFailureSignature) this.snap.repeatedFailures += 1
        else this.lastFailureSignature = signature
      } else {
        // Repeated failures are consecutive by definition. A successful tool
        // result breaks the sequence even if the same error appears later.
        this.lastFailureSignature = null
      }
    } else {
      changed = false
    }
    if (changed) this.write()
  }

  loopDetected(message: string): void {
    this.snap.loopDetected = message
    this.snap.phase = 'stopped'
    this.write()
  }

  write(): void {
    this.dirty = true
    this.snap.updatedAt = new Date().toISOString()
    const temp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temp, JSON.stringify(this.snap), 'utf8')
      try {
        renameSync(temp, this.file)
      } catch {
        // Windows cannot rename over an existing file; the fallback keeps the
        // status channel best-effort and never blocks the agent run.
        rmSync(this.file, { force: true })
        renameSync(temp, this.file)
      }
      this.dirty = false
    } catch {
      try { rmSync(temp, { force: true }) } catch { /* best effort cleanup */ }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { rmSync(this.file, { force: true }) } catch { /* best effort cleanup */ }
  }
}

/**
 * 启动时清掉上次崩溃/强杀遗留的 per-process 状态文件(`runtime-status/<uuid>.json`)。
 * 正常收尾由 `AgentStatusTracker.dispose()` 删;崩溃留下的孤儿没人再读,启动时也没有活动
 * agent 进程,所以整目录安全清空。返回删掉的文件数。
 */
export function pruneStaleRuntimeStatus(dir: string): number {
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    try {
      rmSync(join(dir, entry), { force: true })
      removed += 1
    } catch {
      /* best effort */
    }
  }
  return removed
}

export function formatAgentStatus(snapshot: AgentStatusSnapshot): string {
  const tools = Object.entries(snapshot.tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}=${count}`).join(', ')
  const todo = `pending=${snapshot.todo.pending}, in_progress=${snapshot.todo.inProgress}, completed=${snapshot.todo.completed}`
  const todoList = snapshot.todo.items
    .map((item) => `  [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.content}`)
    .join('\n')
  return `<agent_status>\nphase: ${snapshot.phase}\nworkspace: ${snapshot.cwd}\nprompt: ${snapshot.prompt ?? '(none)'}\ntodo: ${todo}${todoList ? `\n${todoList}` : ''}\ntool_calls: ${tools || '(none)'}\nfailures: ${snapshot.failures}\nrepeated_failures: ${snapshot.repeatedFailures}\nactive_approvals: ${snapshot.activeApprovals}\nloop_detected: ${snapshot.loopDetected ?? 'none'}\n</agent_status>`
}
