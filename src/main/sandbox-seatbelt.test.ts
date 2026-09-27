import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildSeatbeltProfile } from './sandbox-seatbelt'
import { resolvePiCliPath } from './pi-process'

describe('buildSeatbeltProfile', () => {
  const profile = buildSeatbeltProfile({
    workspace: '/Users/me/repo',
    agentDir: '/Users/me/Library/Application Support/pi-studio/pi-agent',
    tmpDir: '/var/folders/xx/T',
  })

  it('confines writes without trying to enumerate everything else', () => {
    // (deny default) 要求把 mach 服务/sysctl/IPC 全列一遍,漏一条就是难查的运行时故障。
    // 我们要的只是"别写工作区外面",所以 allow default 打底再收窄。
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile.indexOf('(allow default)')).toBeLessThan(profile.indexOf('(deny file-write*)'))
  })

  it('grants write access to exactly the three roots the agent needs', () => {
    expect(profile).toContain('(subpath "/Users/me/repo")')
    expect(profile).toContain('(subpath "/Users/me/Library/Application Support/pi-studio/pi-agent")')
    // 临时目录不能漏:node 要用,粘贴图也写在这里
    expect(profile).toContain('(subpath "/var/folders/xx/T")')
  })

  it('keeps stdio writable, or the RPC pipe never comes up', () => {
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toContain('(regex #"^/dev/fd/")')
  })

  it('does not touch the network unless a proxy port is given', () => {
    // 宽松档(缺省):只做文件隔离,不碰网络
    expect(profile).not.toContain('deny network')
  })

  it('confines outbound to the allowlist proxy port when one is given', () => {
    const confined = buildSeatbeltProfile({
      workspace: '/Users/me/repo',
      agentDir: '/tmp/agent',
      tmpDir: '/tmp/t',
      proxyPort: 18923,
    })
    expect(confined).toContain('(deny network*)')
    expect(confined).toContain('(allow network-outbound (remote ip "localhost:18923"))')
    // deny 必须排在 allow default 之后才生效;放行规则再排在 deny 之后
    expect(confined.indexOf('(allow default)')).toBeLessThan(confined.indexOf('(deny network*)'))
    expect(confined.indexOf('(deny network*)')).toBeLessThan(
      confined.indexOf('(allow network-outbound'),
    )
  })

  it('escapes paths so a quote cannot break out of the profile', () => {
    const nasty = buildSeatbeltProfile({
      workspace: '/tmp/we"ird\\path',
      agentDir: '/tmp/agent',
      tmpDir: '/tmp/t',
    })
    expect(nasty).toContain('(subpath "/tmp/we\\"ird\\\\path")')
  })
})

// 真跑一遍 sandbox-exec:profile 语法错、路径没解析对、规则顺序写反,都只有这里能发现。
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('the profile actually confines writes', () => {
  function sandboxed(): { workspace: string; outside: string; profilePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'pi-seatbelt-test-'))
    dirs.push(root)
    const workspace = join(root, 'ws')
    const outside = join(root, 'outside.txt')
    execFileSync('/bin/mkdir', [workspace])
    writeFileSync(outside, 'original', 'utf8')
    const profilePath = join(root, 'test.sb')
    writeFileSync(
      profilePath,
      buildSeatbeltProfile({ workspace, agentDir: join(root, 'agent'), tmpDir: join(root, 'tmp') }),
      'utf8',
    )
    return { workspace, outside, profilePath }
  }

  const run = (profilePath: string, script: string): { ok: boolean; output: string } => {
    try {
      const output = execFileSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, output }
    } catch (error) {
      return { ok: false, output: String((error as { stderr?: string }).stderr ?? error) }
    }
  }

  it('allows writes inside the workspace', () => {
    const { workspace, profilePath } = sandboxed()
    const result = run(profilePath, `echo hi > ${workspace}/f.txt`)

    expect(result.ok, result.output).toBe(true)
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8').trim()).toBe('hi')
  })

  it('blocks writes outside it and leaves the target untouched', () => {
    const { outside, profilePath } = sandboxed()
    const result = run(profilePath, `echo pwned > ${outside}`)

    expect(result.ok).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('original')
  })

  it('blocks deleting a file outside the workspace', () => {
    const { outside, profilePath } = sandboxed()
    const result = run(profilePath, `rm -f ${outside}`)

    expect(result.ok).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('still allows reading outside — the agent needs to read the system', () => {
    const { profilePath } = sandboxed()
    const result = run(profilePath, 'head -c 2 /etc/hosts')

    expect(result.ok, result.output).toBe(true)
  })

  // Docker 那条就是死在这一步(容器里 pi 起不来/连不上),而且从来没人真跑过。
  // 这里用真 profile + 真 pi CLI 跑一次,把那个坑钉死。
  it('lets the real pi CLI start up inside the sandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-seatbelt-boot-'))
    dirs.push(root)
    const profilePath = join(root, 'boot.sb')
    writeFileSync(
      profilePath,
      // 临时目录用真的:pi 启动要在那里落临时文件,漏了就起不来
      buildSeatbeltProfile({ workspace: root, agentDir: join(root, 'agent'), tmpDir: tmpdir() }),
      'utf8',
    )

    const cli = resolvePiCliPath()
    const result = run(profilePath, `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} --version`)

    expect(result.ok, result.output).toBe(true)
    expect(result.output).toMatch(/\d+\.\d+\.\d+/)
  })
})
