import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWorkspaceChecks } from './workspace-checks'

let workspace: string
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'pi-workspace-checks-')) })
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workspace, windowsHide: true, stdio: 'ignore' })
}

describe('workspace acceptance checks', () => {
  it('passes a file check when the path exists and contains the expected text', async () => {
    writeFileSync(join(workspace, 'README.md'), '# Demo\n')
    const result = await runWorkspaceChecks(workspace, [{ type: 'file', path: 'README.md', contains: '# Demo' }])
    expect(result).toMatchObject({ contract: 'engine-verify/v1', status: 'completed', passed: true })
    expect(result.checks).toEqual([
      { check: { type: 'file', path: 'README.md', contains: '# Demo' }, passed: true, message: 'file assertion passed' },
    ])
  })

  it('fails a file check when the path is missing, without hiding later checks', async () => {
    const result = await runWorkspaceChecks(workspace, [
      { type: 'file', path: 'missing.txt' },
      { type: 'file', path: 'also-missing.txt', exists: false },
    ])
    expect(result.passed).toBe(false)
    expect(result.status).toBe('completed')
    expect(result.checks.map((item) => item.passed)).toEqual([false, true])
  })

  it('rejects a file path that escapes the workspace', async () => {
    const result = await runWorkspaceChecks(workspace, [{ type: 'file', path: '../secret.txt' }])
    expect(result.passed).toBe(false)
    expect(result.checks[0]?.message).toMatch(/within the workspace/)
  })

  it('runs a command check in the workspace and records the exit code', async () => {
    const result = await runWorkspaceChecks(workspace, [{
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      expectedExitCode: 0,
      timeoutMs: 10_000,
    }])
    expect(result.passed).toBe(true)
    expect(result.checks[0]).toMatchObject({ passed: true, message: 'command passed' })
    expect(result.checks[0]?.details).toMatchObject({ kind: 'exit', exitCode: 0 })
  })

  it('fails a command check when the exit code does not match', async () => {
    const result = await runWorkspaceChecks(workspace, [{
      type: 'command',
      executable: process.execPath,
      args: ['-e', 'process.exit(2)'],
      expectedExitCode: 0,
      timeoutMs: 10_000,
    }])
    expect(result.passed).toBe(false)
    expect(result.checks[0]?.message).toBe('command exited 2, expected 0')
    expect(result.checks[0]?.details).toMatchObject({ kind: 'exit', exitCode: 2 })
  })

  it('applies git working-tree diff allow and deny globs, ignoring .dsh', async () => {
    git(['init'])
    git(['config', 'user.email', 'check@test'])
    git(['config', 'user.name', 'check'])
    mkdirSync(join(workspace, 'src'))
    mkdirSync(join(workspace, 'config'))
    mkdirSync(join(workspace, '.dsh'))
    writeFileSync(join(workspace, 'src/ok.ts'), 'export {}\n')
    writeFileSync(join(workspace, 'config/secret.env'), 'TOKEN=1\n')
    writeFileSync(join(workspace, '.dsh/trace.json'), '{}\n')

    const result = await runWorkspaceChecks(workspace, [{
      type: 'diff',
      allow: ['src/**'],
      deny: ['**/*.env'],
      maxChangedFiles: 20,
    }])
    expect(result.passed).toBe(false)
    expect(result.checks[0]?.message).toBe('diff rules failed')
    expect(result.checks[0]?.details).toMatchObject({
      unexpected: [{ path: 'config/secret.env', status: 'added' }],
      denied: [{ path: 'config/secret.env', status: 'added' }],
    })
    const changed = result.checks[0]?.details as { unexpected: { path: string }[]; denied: { path: string }[]; changedFiles: number }
    expect(changed.unexpected.some((entry) => entry.path.startsWith('.dsh'))).toBe(false)
  })
})
