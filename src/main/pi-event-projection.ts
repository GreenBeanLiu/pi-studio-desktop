import { appendAppLog, normalizeError } from './app-log'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import { isBlockingExtensionUiMethod } from './extension-ui-ownership'
import type { AgentJob } from './agent-job-registry'
import type { LoopDetection } from './agent-loop-guard'
import {
  entryContext,
  nextRunActive,
  type AgentEntry,
  type PiEventContext,
  type TaskBinding,
  type SessionActivityEvent,
} from './pi-agent-entry'

/**
 * 投影层需要问上层的事。它自己不持有 entry 集合,也不知道谁在前台。
 */
export type EventProjectionHost = {
  currentWorkspacePath(): string | null
  isActive(entry: AgentEntry): boolean
  /** 前台事件才推给界面。 */
  emitEvent(event: PiRuntimeEvent, context: PiEventContext): void
  /** 后台会话只上报运行状态给侧栏。 */
  emitActivity(event: SessionActivityEvent): void
  /** 控制面任务会话的事件,不管前台后台都推给控制面(见 TaskBinding)。 */
  emitTaskEvent(entry: AgentEntry, event: PiRuntimeEvent): void
  registerSubagentJob(entry: AgentEntry): AgentJob
}

/**
 * 把某个 agent 进程的原始事件流投影成界面能消费的东西:
 * 前台直推、后台攒审批请求、顺带维护一轮的运行状态、循环检测和子代理血缘。
 */
export class EventProjection {
  constructor(private readonly host: EventProjectionHost) {}

  handleEvent(entry: AgentEntry, event: PiRuntimeEvent): void {
    entry.job.observeRun(nextRunActive(entry.job.isRunActive(), event.type))
    entry.status.observe(event)
    const loop = entry.loopGuard.observe(event)
    if (event.type === 'agent_settled') entry.outstandingUi.clear()
    if (
      event.type === 'extension_ui_request' &&
      isBlockingExtensionUiMethod(event.method)
    ) {
      entry.outstandingUi.set(event.id, event.method)
    }
    this.trackSubagentLineage(entry, event)
    if (entry.task) {
      this.handleTaskEvent(entry, entry.task, event)
      if (loop) this.handleLoopDetection(entry, loop)
      return
    }
    if (this.host.isActive(entry)) {
      this.host.emitEvent(event, entryContext(entry))
    }
    if (loop) this.handleLoopDetection(entry, loop)
    // 前后各求值一次是有意的:handleLoopDetection 会同步回调进界面,
    // 它可能把前台切走,之后这条事件就该按后台处理。
    if (this.host.isActive(entry)) return
    // 后台会话:审批之类的请求先攒着,切回前台再补发;其余只上报运行状态给侧栏
    if ((event as { type?: string }).type === 'extension_ui_request') entry.pendingUi.push(event)
    this.host.emitActivity({ sessionFile: entry.sessionFile, running: entry.job.isRunActive() })
  }

  /**
   * 任务会话:事件全部推给控制面;阻塞式审批没人能答,由闸门当场拒绝 —— 攒着等切前台
   * 会让任务卡到超时。拒绝理由写回给 agent,它能据此换个做法或如实收尾。
   */
  private handleTaskEvent(entry: AgentEntry, task: TaskBinding, event: PiRuntimeEvent): void {
    this.host.emitTaskEvent(entry, event)
    const answered = task.gate.answer(event)
    if (!answered) return
    try {
      entry.client.respondExtensionUi(answered.response)
      entry.outstandingUi.delete(answered.response.id)
    } catch (err) {
      // 拒绝没送到 agent 手里,这一轮还卡着:记在闸门上,控制面超时收尾时看得到原因
      task.gate.recordDeliveryFailure(answered.response.id, err instanceof Error ? err.message : String(err))
      appendAppLog('warn', 'task.session', 'Could not deliver an unattended denial', {
        taskId: task.taskId,
        requestId: answered.response.id,
        error: normalizeError(err),
      })
    }
  }

  private handleLoopDetection(entry: AgentEntry, detection: LoopDetection): void {
    const message = `检测到 Agent 可能陷入循环：${detection.message}。已停止本轮运行，请检查失败原因后继续。`
    entry.status.loopDetected(message)
    appendAppLog('warn', 'agent.loop-guard', message, {
      cwd: this.host.currentWorkspacePath(),
      sessionFile: entry.sessionFile,
      kind: detection.kind,
      signature: detection.signature,
      count: detection.count,
    })
    if (this.host.isActive(entry)) {
      this.host.emitEvent({ type: 'run_failed', scope: 'prompt', message }, entryContext(entry))
    }
    void entry.client.cancel('loop guard detected repeated tool activity').catch((error) => {
      appendAppLog('warn', 'agent.loop-guard', 'Failed to abort repeated agent run', normalizeError(error))
    })
  }

  /**
   * 子代理在 pi 子进程里跑,宿主拿不到它的进程,但"谁派生了谁"是重启后仍要解释的事实。
   * 按工具调用登记成没有资源的逻辑 job,血缘和终态就都能观察到,而不是只剩一张卡片。
   */
  private trackSubagentLineage(entry: AgentEntry, event: PiRuntimeEvent): void {
    if (event.type === 'tool_execution_start' && event.toolName === 'subagent') {
      entry.subagentJobs.set(event.toolCallId, this.host.registerSubagentJob(entry))
      return
    }
    if (event.type === 'tool_execution_end') {
      const job = entry.subagentJobs.get(event.toolCallId)
      if (!job) return
      entry.subagentJobs.delete(event.toolCallId)
      void job.finish(event.isError ? 'subagent failed' : 'subagent returned')
      return
    }
    if (event.type !== 'agent_settled') return
    // 一轮结束还挂着的子代理没有权威结果可等,按中断收尾而不是永远留在 running。
    for (const [callId, job] of entry.subagentJobs) {
      entry.subagentJobs.delete(callId)
      void job.finish('run settled without a subagent result')
    }
  }
}
