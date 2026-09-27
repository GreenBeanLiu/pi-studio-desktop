import { app } from 'electron'
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { agentConfigDir, loadSettings } from './settings'
import type { SandboxPrepareOptions } from './sandbox-backend'
import { startSandboxProxy } from './sandbox-proxy'
import { appendAppLog } from './app-log'

/**
 * WSL2 + bubblewrap 沙箱(见 docs/sandbox-mode-plan.md「2026-07-15 复盘与决策」):
 * 官方 Linux 原语路线——bwrap 的 mount namespace 做「广读 + 只写工作区/agent 目录」,
 * 网络经 mirrored localhost 强制走主机侧白名单代理(sandbox-proxy.ts)。
 * 架构沿用中继 shim:RpcClient spawn `node <shim> --mode rpc …`,shim 把 stdio
 * 透传给 `wsl.exe -d pi-studio-sandbox -- bwrap … pi <RpcClient 追加的参数>`。
 *
 * 发行版一次性准备(约 1 分钟,Alpine 3MB rootfs):
 *   wsl --import pi-studio-sandbox %LOCALAPPDATA%\pi-studio-sandbox <alpine-minirootfs>.tar.gz --version 2
 *   wsl -d pi-studio-sandbox -- sh -c "sed -i 's#dl-cdn.alpinelinux.org#mirrors.tuna.tsinghua.edu.cn#' /etc/apk/repositories && apk add nodejs npm bash git ripgrep bubblewrap coreutils && npm i -g --registry=https://registry.npmmirror.com @earendil-works/pi-coding-agent@<app 捆绑版本>"
 * 并在 %USERPROFILE%\.wslconfig 里开 [wsl2] networkingMode=mirrored(Win11 22H2+)。
 */

export const WSL_SANDBOX_DISTRO = 'pi-studio-sandbox'

/** wsl.exe 的列表输出是 UTF-16LE,必须按此解码(踩过的坑)。 */
export async function detectWslSandboxDistro(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise((resolve) => {
    const p = spawn('wsl.exe', ['-l', '-q'], { windowsHide: true })
    const chunks: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.on('error', () => resolve(false))
    p.on('close', () => {
      const names = Buffer.concat(chunks)
        .toString('utf16le')
        .split(/\r?\n/)
        .map((s) => s.replace(/\0/g, '').trim())
      resolve(names.includes(WSL_SANDBOX_DISTRO))
    })
  })
}

/** 在发行版里跑一条命令,拿 stdout(utf8;注意这不同于 wsl -l 的 UTF-16LE)。 */
function wslExec(args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('wsl.exe', ['-d', WSL_SANDBOX_DISTRO, '--', ...args], { windowsHide: true })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      p.kill()
      resolve('')
    }, timeoutMs)
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    p.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8').trim())
    })
  })
}

/**
 * NAT 模式适配:mirrored networking(Win11 22H2+ 且 .wslconfig 开启)下沙箱经
 * 127.0.0.1 直达主机;NAT(老系统/默认配置)下 127.0.0.1 是沙箱自己,主机地址
 * 是 WSL 默认路由的网关 IP(vEthernet 适配器)。返回代理应绑定/被访问的主机地址。
 */
export async function resolveSandboxProxyHost(): Promise<{
  host: string
  mode: 'mirrored' | 'nat'
}> {
  const mode = await wslExec(['wslinfo', '--networking-mode'])
  if (mode === 'mirrored') return { host: '127.0.0.1', mode: 'mirrored' }
  // 非 mirrored(nat/virtioproxy/wslinfo 缺失的老 WSL)一律按 NAT 处理:取默认网关
  const route = await wslExec(['sh', '-c', 'ip route show default | head -1'])
  const gateway = /default via (\S+)/.exec(route)?.[1]
  if (!gateway) {
    throw new Error(
      `WSL 沙箱网络探测失败(networking-mode=${mode || '未知'},且拿不到默认网关)—— ` +
        '请确认发行版网络正常,或在 .wslconfig 开启 networkingMode=mirrored(Win11 22H2+)',
    )
  }
  return { host: gateway, mode: 'nat' }
}

export function windowsToWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m) return p
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/** shim:把 RpcClient 握着的 stdio 原样透传进 wsl.exe(纯字节管道,不解析 JSON)。 */
function wslShimSource(): string {
  return `// pi-studio WSL 沙箱中继:RpcClient 以为在跑 node,实际字节转发进 wsl.exe。
const { spawn } = require('child_process')
const pre = JSON.parse(process.env.PISTUDIO_WSL_ARGS || '[]')
const child = spawn('wsl.exe', [...pre, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
child.on('close', (code) => process.exit(code ?? 0))
`
}

export async function prepareWslSandboxLaunch(
  cwd: string,
  env: Record<string, string>,
  options: SandboxPrepareOptions = {},
): Promise<{ cliPath: string; env: Record<string, string> }> {
  const wsWsl = windowsToWslPath(cwd)
  const agentWsl = windowsToWslPath(agentConfigDir())
  // mirrored → 127.0.0.1;NAT → WSL 网关 IP(代理绑到该地址,不暴露局域网)
  const proxy = await resolveSandboxProxyHost()
  const proxyPort = await startSandboxProxy(proxy.host, loadSettings().sandboxAllowedHosts)

  const shimPath = join(app.getPath('userData'), 'sandbox-wsl-shim.cjs')
  writeFileSync(shimPath, wslShimSource(), 'utf-8')

  // bwrap:整盘只读 + 工作区/agent 目录可写 + 私有 /tmp;网络共享发行版 netns
  // (mirrored 模式下 127.0.0.1 即主机),出站由 HTTPS_PROXY 收敛到白名单代理。
  // 只读工作区:不额外 bind 工作区即可 —— 整盘已经是 --ro-bind / /,天然只读。
  const wslArgs = [
    '-d',
    WSL_SANDBOX_DISTRO,
    '--cd',
    cwd, // wsl.exe 自己会翻译 Windows 路径
    '--',
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...(options.workspaceReadOnly ? [] : ['--bind', wsWsl, wsWsl]),
    '--bind', agentWsl, agentWsl,
    '--unshare-pid',
    '--die-with-parent',
    'env',
    'HOME=/tmp',
    `PI_CODING_AGENT_DIR=${agentWsl}`,
    `HTTP_PROXY=http://${proxy.host}:${proxyPort}`,
    `HTTPS_PROXY=http://${proxy.host}:${proxyPort}`,
    'NO_PROXY=localhost,127.0.0.1',
    'pi',
  ]

  // 密钥不上命令行:经 shim 进程 env + WSLENV 名单进入 WSL(bwrap 默认继承 env)
  const secretNames = Object.keys(env)
  appendAppLog('info', 'sandbox.wsl', 'Launching pi inside WSL bubblewrap sandbox', {
    cwd,
    distro: WSL_SANDBOX_DISTRO,
    networkingMode: proxy.mode,
    proxyHost: proxy.host,
    proxyPort,
  })
  return {
    cliPath: shimPath,
    env: {
      ...env,
      PI_STUDIO_MEMORY_FILE: windowsToWslPath(env.PI_STUDIO_MEMORY_FILE ?? ''),
      PISTUDIO_WSL_ARGS: JSON.stringify(wslArgs),
      WSLENV: secretNames.join(':'),
    },
  }
}
