import { createServer, type Server } from 'http'
import { connect } from 'net'
import { appendAppLog } from './app-log'
import { mergeAllowedHosts, parseAllowedHostList } from '../shared/sandbox-hosts'

/**
 * 沙箱专用的主机侧白名单代理(HTTP CONNECT)。
 * WSL / macOS 沙箱内的 pi 经 HTTPS_PROXY 指到这里;LLM 流量实际从主机进程出网,
 * 绕开「虚拟网络 × Clash TUN」的脆弱路径(Docker 沙箱就是死在容器自己出网)。
 * 白名单外的目标一律 403——对 agent 的网络面做正向收敛。
 *
 * 名单 = 内置默认 + 用户在设置页填的额外域名(sandboxAllowedHosts)。代理是单例,
 * 额外名单在每次 startSandboxProxy 时刷新;同一时刻只有一个生效名单。
 */

export const DEFAULT_ALLOWED_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'api.tavily.com',
  'trail-api.glanger.xyz',
  'registry.npmjs.org',
  'registry.npmmirror.com',
]

let server: Server | null = null
let listeningPort: number | null = null
let listeningHost: string | null = null
let extraAllowedHosts: string[] = []

function allowedHosts(): string[] {
  return mergeAllowedHosts(DEFAULT_ALLOWED_HOSTS, extraAllowedHosts)
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase()
  return allowedHosts().some((a) => h === a || h.endsWith(`.${a}`))
}

/**
 * @param bindHost 监听地址。mirrored networking 下沙箱经 127.0.0.1 直达主机;
 * NAT 模式下主机对沙箱可见的地址是 WSL vEthernet 网关 IP,须绑到该 IP 上
 * (绑 0.0.0.0 会把白名单代理暴露给局域网,不做)。
 */
export async function startSandboxProxy(
  bindHost = '127.0.0.1',
  extraHosts: string[] = [],
): Promise<number> {
  // 即使复用已存在的 server 也要刷新额外名单(设置页改了域名后重启工作区生效)
  extraAllowedHosts = parseAllowedHostList(extraHosts)
  if (server && listeningPort) {
    if (listeningHost === bindHost) return listeningPort
    // 网络模式变了(如用户切了 .wslconfig):换绑定地址重启
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    listeningPort = null
    listeningHost = null
  }

  server = createServer((_req, res) => {
    // 沙箱内应当只发 HTTPS(CONNECT);裸 HTTP 一律拒绝,避免明文外传
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('sandbox proxy: plain HTTP not allowed')
  })

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = (req.url ?? '').split(':')
    const port = Number(portStr) || 443
    if (!host || !hostAllowed(host)) {
      appendAppLog('warn', 'sandbox.proxy', '拦截沙箱内的非白名单出站', { host })
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, bindHost, () => resolve())
  })
  const addr = server.address()
  listeningPort = typeof addr === 'object' && addr ? addr.port : null
  if (!listeningPort) throw new Error('沙箱代理启动失败')
  listeningHost = bindHost
  appendAppLog('info', 'sandbox.proxy', '沙箱白名单代理已启动', {
    host: bindHost,
    port: listeningPort,
    allow: allowedHosts(),
  })
  return listeningPort
}

/** 关掉代理并清空额外名单。主要给测试收尾用,应用退出时进程结束也会自然释放。 */
export async function stopSandboxProxy(): Promise<void> {
  if (!server) return
  const current = server
  server = null
  listeningPort = null
  listeningHost = null
  extraAllowedHosts = []
  await new Promise<void>((resolve) => current.close(() => resolve()))
}
