/**
 * 沙箱出站白名单的纯函数(见 docs/sandbox-mode-plan.md)。
 *
 * 设置页让用户按行填写额外放行的域名;这里负责把用户输入归一化成 hostname,
 * 再和内置默认名单合并去重。放在 shared 是因为 main 的代理和 IPC 校验都要用,
 * 而它不依赖 electron / node,便于单测。
 */

/** 把一行用户输入归一化成 hostname;无法识别时返回 null。 */
export function normalizeAllowedHost(entry: string): string | null {
  let host = entry.trim()
  if (!host) return null

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    // 允许直接粘 URL,取 hostname
    try {
      host = new URL(host).hostname
    } catch {
      return null
    }
  } else {
    // 裸条目:去掉路径 / 查询 / 片段
    const cut = host.search(/[/?#]/)
    if (cut >= 0) host = host.slice(0, cut)
    // 去掉端口;IPv6 的方括号形式保留原样
    if (!host.startsWith('[')) {
      const colon = host.indexOf(':')
      if (colon >= 0) host = host.slice(0, colon)
    }
  }

  host = host.trim().toLowerCase().replace(/\.+$/, '')
  if (!host || /[\s/\\]/.test(host)) return null
  return host
}

/**
 * 解析跨进程传来的白名单(字符串数组,或换行 / 逗号分隔的字符串),
 * 归一化 + 去重 + 保序。非字符串、空行、坏条目一律丢弃。
 */
export function parseAllowedHostList(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : []

  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const host = normalizeAllowedHost(entry)
    if (host && !seen.has(host)) {
      seen.add(host)
      out.push(host)
    }
  }
  return out
}

/** 合并内置默认名单与用户额外名单:归一化 + 去重 + 保序,默认名单在前。 */
export function mergeAllowedHosts(defaults: readonly string[], extra: readonly string[]): string[] {
  return parseAllowedHostList([...defaults, ...extra])
}
