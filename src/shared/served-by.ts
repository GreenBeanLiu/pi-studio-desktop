import type { PiRuntimeEvent, PiServedByEvent } from './ipc/contract'

/**
 * 网关实际服务方(D5:响应头 x-pi-served-by / x-pi-upstream-model)。
 *
 * Pi 发请求，宿主拿不到响应头;内置扩展在 after_provider_response 里读出来，
 * 用 ctx.ui.setStatus(SERVED_BY_STATUS_KEY, JSON) 回传。扩展是字符串源码，不能 import 这里:
 * 键名是生成源码时插值进去的，JSON 形状两边各写一份，由 agent-status-extension-sync.test.ts
 * 把扩展真跑一遍、再用这里的解析函数对齐。
 */
export const SERVED_BY_STATUS_KEY = 'pi-served-by'

/** 扩展发来的 setStatus 是不是「谁回的」;是就转成稳定事件，否则 null。坏数据一律当没有。 */
export function servedByFromStatusEvent(event: PiRuntimeEvent): PiServedByEvent | null {
  if (event.type !== 'extension_ui_request' || event.method !== 'setStatus') return null
  const record = event as { statusKey?: unknown; statusText?: unknown }
  if (record.statusKey !== SERVED_BY_STATUS_KEY || typeof record.statusText !== 'string') return null
  try {
    const value = JSON.parse(record.statusText) as { profileId?: unknown; upstreamModel?: unknown }
    if (typeof value.profileId !== 'string' || !value.profileId.trim()) return null
    const upstreamModel =
      typeof value.upstreamModel === 'string' && value.upstreamModel.trim() ? value.upstreamModel.trim() : undefined
    return { type: 'served_by', profileId: value.profileId.trim(), ...(upstreamModel ? { upstreamModel } : {}) }
  } catch {
    return null
  }
}
