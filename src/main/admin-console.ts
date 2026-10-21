import { shell } from 'electron'

import { getCloudConnection } from './cloud-connection'
import { cloudMediaFetch } from './cloud-media'

/**
 * 设置 →「打开管理台」(2026-10-21):设备面的 /admin 网页(供应商 key、开关、权重)。
 *
 * 管理台没有密码,登录靠一次性链接。以前只有手机能要链接,可配供应商都是坐在电脑前做的。
 * 桌面主进程本来就拿着云端的应用令牌(出图用的那把),用它向 /admin/login-link/desktop
 * 换一条 10 分钟内有效、只能用一次的链接,交给系统浏览器打开 —— 令牌本身不出主进程。
 */
export type AdminConsoleIo = {
  fetch: typeof cloudMediaFetch
  open: (url: string) => Promise<void>
  relay: () => { available: boolean; relay: string; error?: string | null }
}

const defaultIo: AdminConsoleIo = {
  fetch: cloudMediaFetch,
  open: (url) => shell.openExternal(url),
  relay: () => getCloudConnection(),
}

export async function openAdminConsole(io: AdminConsoleIo = defaultIo): Promise<{ ok: true } | { error: string }> {
  const cloud = io.relay()
  if (!cloud.available) return { error: cloud.error ?? '先在上面填好云服务地址和应用令牌并保存' }
  try {
    const response = await io.fetch('/admin/login-link/desktop', { method: 'POST' }, 15_000)
    if (response.status === 404) return { error: '云端还没更新到支持桌面登录的版本' }
    if (response.status === 401) return { error: '应用令牌不对，管理台不让进' }
    if (!response.ok) return { error: `云端 ${response.status}: ${(await response.text()).slice(0, 160)}` }
    const { path } = (await response.json()) as { path?: string }
    if (!path?.startsWith('/admin/login?code=')) return { error: '云端没有返回登录链接' }
    await io.open(`${cloud.relay.replace(/\/+$/, '')}${path}`)
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
