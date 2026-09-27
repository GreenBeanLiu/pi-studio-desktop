import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsModal = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

// 2026-08-23: mac 上的沙箱设置页照抄了 Windows 文案 —— 承诺「整盘只读 + 域名白名单
// 代理」,但那套是 WSL/bwrap 专属(sandbox-wsl.ts)。非 Windows 只能走 Docker 回退,
// buildSandboxDockerArgs 里一个网络参数都没有,容器拿默认网络,出站完全不受限。
describe('sandbox settings copy must match the platform', () => {
  it('branches on the platform instead of hardcoding the WSL story', () => {
    expect(settingsModal).toContain("const sandboxOnWsl = api.platform === 'win32'")
  })

  it('gives macOS its own branch instead of the Docker story', () => {
    expect(settingsModal).toContain("const sandboxOnSeatbelt = api.platform === 'darwin'")
    expect(settingsModal).toContain('沙箱模式（macOS 原生）')
    expect(settingsModal).toContain('sandbox-exec')
  })

  it('tells the seatbelt user the network goes through the allowlist proxy', () => {
    // 2026-09-27:Seatbelt 出站已收敛到主机白名单代理,文案不能再写「网络不受限」
    expect(settingsModal).toContain('出站经主机白名单代理')
    expect(settingsModal).not.toContain('网络不受限')
  })

  it('keeps the shelved-Docker warning for the platforms that still get Docker', () => {
    expect(settingsModal).toContain('const sandboxUsesDocker = !sandboxOnWsl && !sandboxOnSeatbelt')
    expect(settingsModal).toContain('这条链路已封存')
    expect(settingsModal).toContain("type={sandboxUsesDocker ? 'warning' : 'info'}")
  })

  it('hides the Docker and image rows where Docker is not used', () => {
    expect(settingsModal).toContain('{!sandboxOnSeatbelt && (')
    expect(settingsModal).toContain(
      '{!sandboxOnSeatbelt && sandboxDetect?.docker.daemonRunning && !sandboxImage?.exists && (',
    )
  })

  it('hides the WSL distro row and prep hint on other platforms', () => {
    expect(settingsModal).toContain('{sandboxOnWsl && (')
    expect(settingsModal).toContain('{sandboxOnWsl && sandboxDetect && !sandboxDetect.wslSandboxReady && (')
  })

  it('never shows the word WSL to a non-Windows user', () => {
    // 每一处提到 WSL 的 UI 文本,要么在三元的 sandboxOnWsl ? 真分支里,
    // 要么整块被 {sandboxOnWsl && …} 包住。mac 用户不该看到这三个字母。
    const lines = settingsModal.split('\n')
    const sandboxStart = lines.findIndex((line) => line.includes('沙箱模式（WSL2'))
    expect(sandboxStart).toBeGreaterThan(-1)

    let gated = 0
    for (let i = sandboxStart; i < lines.length; i++) {
      const line = lines[i]
      if (!/WSL|wsl/.test(line)) continue
      if (line.trim().startsWith('//')) continue
      const guarded =
        line.includes('sandboxOnWsl ?') ||
        line.includes('sandboxOnWsl &&') ||
        /^\s*\? /.test(line) ||
        withinGuardedBlock(lines, sandboxStart, i)
      expect(guarded, `line ${i + 1} leaks WSL copy: ${line.trim()}`).toBe(true)
      gated++
    }
    expect(gated).toBeGreaterThan(0)
  })

  it('stops calling Docker a fallback where it is the only path', () => {
    expect(settingsModal).toContain("const sandboxFallbackWord = sandboxOnWsl ? '(回退)' : ''")
    expect(settingsModal).not.toContain('回退镜像未构建')
  })
})

/** i 行是否落在某个 {sandboxOnWsl && ( … )} 块里(按缩进配对,足够应付这段 JSX)。 */
function withinGuardedBlock(lines: string[], from: number, i: number): boolean {
  for (let j = i; j >= from; j--) {
    if (!lines[j].includes('sandboxOnWsl &&')) continue
    const guardIndent = lines[j].search(/\S/)
    // 守卫和 i 之间,任何回到守卫缩进或更浅的收尾行都说明块已经闭合
    for (let k = j + 1; k < i; k++) {
      const indent = lines[k].search(/\S/)
      if (indent >= 0 && indent <= guardIndent && /^\s*\)\}/.test(lines[k])) return false
    }
    return true
  }
  return false
}
