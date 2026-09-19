import { BrowserWindow } from 'electron'
import { remoteControl } from './remote-control'
import type { RoutineReviewRequest } from './routines'

/**
 * 例程运行时共享的低层状态:取消信号、广播、人工审核的挂起队列,以及几个超时/截断常量。
 *
 * 从 routines.ts 抽出来(2026-09-19):执行器(routine-steps.ts)和 run engine 都要用这几样,
 * 放在各自的模块里会形成循环依赖,所以单独一个中立模块。它不碰存储、不碰调度。
 */

/** agent 节点单步超时。 */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000
/** 传给后续节点的文本产物上限(超过就截断)。 */
export const MAX_STEP_OUTPUT_CHARS = 60_000
/** 人工审核等多久算超时。 */
export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000

/** 取消信号已置位时抛出,由 run engine 捕获后把这次运行标成 cancelled。 */
export class WorkflowCancelledError extends Error {
  constructor() {
    super('工作流已取消')
    this.name = 'WorkflowCancelledError'
  }
}

export function throwIfWorkflowCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkflowCancelledError()
}

/** 广播给所有渲染窗口,再走 remoteControl 推给手机 —— 手机也是一块屏。 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  // 人工审核节点尤其要出去 —— 它是阻塞式的,没人应就超时把整条工作流拖死,而人多半不在电脑前。
  remoteControl.forwardHostEvent(channel, payload)
}

export type PendingReview = {
  routineId: string
  // 手机可能在广播之后才连上来(锁屏、切后台、换网),没有原始请求就补不回去
  request: RoutineReviewRequest
  approve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export const pendingReviews = new Map<string, PendingReview>()

/** 桌面和手机走同一条路:审核只能应一次,谁先点谁生效。 */
export function respondToReview(
  reviewId: string,
  decision: 'approve' | 'reject',
  comment?: string,
): { ok: true } | { error: string } {
  const pending = pendingReviews.get(reviewId)
  if (!pending) return { error: '审核请求已过期或工作流已结束' }
  if (decision === 'approve') pending.approve()
  else pending.reject(new Error(comment?.trim() || '人工审核拒绝'))
  return { ok: true }
}

export function cancelPendingReviews(routineId: string, reason: string): void {
  for (const [reviewId, pending] of pendingReviews) {
    if (pending.routineId !== routineId) continue
    broadcast('routines:reviewCancelled', { reviewId, routineId, reason })
    pending.reject(new Error(reason))
    pendingReviews.delete(reviewId)
  }
}
