import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WSL_SANDBOX_DISTRO, buildWslBwrapArgs, windowsToWslPath } from './sandbox-wsl'

/** 发行版是否就绪(和 detectWslSandboxDistro 同款判断,但同步,方便 skipIf)。 */
function sandboxDistroReady(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' })
    return out
      .toString('utf16le')
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .includes(WSL_SANDBOX_DISTRO)
  } catch {
    return false
  }
}

const distroReady = sandboxDistroReady()

describe('buildWslBwrapArgs', () => {
  const base = { workspaceWsl: '/mnt/c/ws', agentDirWsl: '/mnt/c/agent' }

  it('makes the whole root read-only and the workspace writable', () => {
    const args = buildWslBwrapArgs({ ...base, workspaceReadOnly: false })
    expect(args[0]).toBe('bwrap')
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', '/', '/']))
    expect(args).toEqual(expect.arrayContaining(['--bind', '/mnt/c/ws', '/mnt/c/ws']))
    expect(args).toEqual(expect.arrayContaining(['--bind', '/mnt/c/agent', '/mnt/c/agent']))
    expect(args).toContain('--unshare-pid')
  })

  it('drops the workspace bind when read-only', () => {
    const args = buildWslBwrapArgs({ ...base, workspaceReadOnly: true })
    expect(args).not.toContain('/mnt/c/ws')
    expect(args).toEqual(expect.arrayContaining(['--bind', '/mnt/c/agent', '/mnt/c/agent']))
  })
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!distroReady)('the WSL bubblewrap sandbox actually confines', () => {
  function scratch(): {
    workspace: string
    workspaceWsl: string
    agentWsl: string
    outside: string
    outsideWsl: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'pi-wsl-e2e-'))
    roots.push(root)
    const workspace = join(root, 'ws')
    const agent = join(root, 'agent')
    const outside = join(root, 'outside.txt')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(agent, { recursive: true })
    writeFileSync(outside, 'original', 'utf8')
    return {
      workspace,
      workspaceWsl: windowsToWslPath(workspace),
      agentWsl: windowsToWslPath(agent),
      outside,
      outsideWsl: windowsToWslPath(outside),
    }
  }

  function run(bwrap: string[], script: string): { ok: boolean; output: string } {
    try {
      const output = execFileSync(
        'wsl.exe',
        ['-d', WSL_SANDBOX_DISTRO, '--', ...bwrap, 'env', 'HOME=/tmp', 'sh', '-c', script],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return { ok: true, output }
    } catch (error) {
      return { ok: false, output: String((error as { stderr?: string }).stderr ?? error) }
    }
  }

  function sandbox(readOnly: boolean) {
    const s = scratch()
    const bwrap = buildWslBwrapArgs({
      workspaceWsl: s.workspaceWsl,
      agentDirWsl: s.agentWsl,
      workspaceReadOnly: readOnly,
    })
    return { ...s, bwrap }
  }

  it('allows writes inside the workspace', () => {
    const s = sandbox(false)
    const result = run(s.bwrap, `echo hi > ${s.workspaceWsl}/f.txt`)
    expect(result.ok, result.output).toBe(true)
    expect(readFileSync(join(s.workspace, 'f.txt'), 'utf8').trim()).toBe('hi')
  })

  it('blocks writes outside the workspace and leaves the target untouched', () => {
    const s = sandbox(false)
    const result = run(s.bwrap, `echo pwned > ${s.outsideWsl}`)
    expect(result.ok).toBe(false)
    expect(readFileSync(s.outside, 'utf8')).toBe('original')
  })

  it('still allows reading outside — the agent needs the system', () => {
    const s = sandbox(false)
    expect(run(s.bwrap, 'head -c 2 /etc/hosts').ok).toBe(true)
  })

  it('blocks writing the workspace when it is mounted read-only', () => {
    const s = sandbox(true)
    const result = run(s.bwrap, `echo x > ${s.workspaceWsl}/f2.txt`)
    expect(result.ok).toBe(false)
    expect(existsSync(join(s.workspace, 'f2.txt'))).toBe(false)
  })

  it('lets the real pi CLI start inside the sandbox', () => {
    const s = sandbox(false)
    const result = run(s.bwrap, 'pi --version')
    expect(result.ok, result.output).toBe(true)
    expect(result.output).toMatch(/\d+\.\d+\.\d+/)
  })
})
