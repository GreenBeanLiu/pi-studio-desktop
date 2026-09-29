import type { RoutineStepType } from '../shared/ipc/contract'

export type RoutineStepKind = RoutineStepType

export type RoutineStepLike = {
  name: string
  type: RoutineStepKind
  prompt?: string
  channelId?: string
}

/** Main-process validation shared by every routine save path. */
export function isRoutineStepComplete(step: RoutineStepLike): boolean {
  if (!step.name.trim()) return false
  if (step.type === 'notify') return !!step.channelId
  if (step.type === 'folder-input' || step.type === 'review' || step.type === 'export' || step.type === 'feishu-doc' || step.type === 'wechat-draft' || step.type === 'app-icon' || step.type === 'model3d') return true
  return !!step.prompt?.trim()
}
