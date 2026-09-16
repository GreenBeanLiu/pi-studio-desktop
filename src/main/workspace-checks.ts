import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import { realpathSync } from 'fs'

export const VERIFY_CONTRACT = 'engine-verify/v1'
const OUTPUT_LIMIT = 64 * 1024
const COMMAND_TIMEOUT_DEFAULT_MS = 60_000

export type WorkspaceCheck = Record<string, unknown> & { type?: string }

export type WorkspaceCheckResult = {
  check: WorkspaceCheck
  passed: boolean
  message: string
  details?: Record<string, unknown>
}

export type WorkspaceVerifyResult = {
  contract: typeof VERIFY_CONTRACT
  status: 'completed' | 'error'
  passed: boolean
  checks: WorkspaceCheckResult[]
  error: string | null
  seconds: number
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesAny(path: string, patterns: readonly string[] | undefined): boolean {
  return !!patterns?.some((pattern) => globRegex(pattern).test(path))
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}\n… [${text.length - OUTPUT_LIMIT} more bytes truncated]`
}

function workspaceFile(workspace: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('file check needs a relative path')
  }
  const requested = raw.trim()
  if (isAbsolute(requested) || requested.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error(`path must stay within the workspace: ${requested}`)
  }
  const root = realpathSync(workspace)
  const target = resolve(root, requested)
  const rel = relative(root, target)
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path must stay within the workspace: ${requested}`)
  }
  return target
}

async function runFileCheck(workspace: string, check: WorkspaceCheck): Promise<Omit<WorkspaceCheckResult, 'check'>> {
  const target = workspaceFile(workspace, check.path)
  const expectedExists = check.exists ?? true
  if (typeof expectedExists !== 'boolean') throw new Error('file check: exists must be a boolean')
  const content = await readFile(target, 'utf8').catch(() => null)
  if (!expectedExists) {
    const passed = content === null
    return { passed, message: passed ? 'file assertion passed' : `file exists but should not: ${String(check.path)}` }
  }
  if (content === null) {
    return { passed: false, message: `file assertion failed: ${String(check.path)} does not exist` }
  }
  if (typeof check.contains === 'string' && !content.includes(check.contains)) {
    return { passed: false, message: `file assertion failed: ${String(check.path)} does not contain the expected text` }
  }
  if (typeof check.equals === 'string' && content !== check.equals) {
    return { passed: false, message: `file assertion failed: ${String(check.path)} content differs` }
  }
  return { passed: true, message: 'file assertion passed' }
}

function commandEnvironment(check: WorkspaceCheck): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.Path ? { Path: process.env.Path } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
  }
  const mapping = check.env
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const [name, source] of Object.entries(mapping as Record<string, unknown>)) {
      const fromEnv = source && typeof source === 'object' && !Array.isArray(source)
        ? (source as { fromEnv?: unknown }).fromEnv
        : undefined
      if (typeof fromEnv !== 'string' || process.env[fromEnv] === undefined) {
        throw new Error(`missing check environment variable: ${typeof fromEnv === 'string' ? fromEnv : name}`)
      }
      env[name] = process.env[fromEnv]
    }
  }
  return env
}

function runCommandCheck(workspace: string, check: WorkspaceCheck): Promise<Omit<WorkspaceCheckResult, 'check'>> {
  return new Promise((resolveResult) => {
    const executable = typeof check.executable === 'string' ? check.executable.trim() : ''
    if (!executable) {
      resolveResult({ passed: false, message: 'command check needs an executable' })
      return
    }
    const args = Array.isArray(check.args) ? check.args : []
    if (!args.every((item) => typeof item === 'string')) {
      resolveResult({ passed: false, message: 'command check: args must be a list of strings' })
      return
    }
    const expected = typeof check.expectedExitCode === 'number' ? check.expectedExitCode : 0
    const timeoutMs = typeof check.timeoutMs === 'number' && check.timeoutMs > 0 ? check.timeoutMs : COMMAND_TIMEOUT_DEFAULT_MS
    let env: NodeJS.ProcessEnv
    try {
      env = commandEnvironment(check)
    } catch (error) {
      resolveResult({ passed: false, message: error instanceof Error ? error.message : String(error) })
      return
    }
    const child = spawn(executable, args as string[], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const started = Date.now()
    const finish = (result: Omit<WorkspaceCheckResult, 'check'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      finish({
        passed: false,
        message: `command could not start: ${error.message}`,
        details: { kind: 'spawn-error', stdout: '', stderr: error.message },
      })
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({
        passed: false,
        message: `command timed out after ${timeoutMs}ms`,
        details: { kind: 'timeout', stdout: truncate(stdout), stderr: truncate(stderr), seconds: Number(((Date.now() - started) / 1000).toFixed(3)) },
      })
    }, timeoutMs)
    child.on('close', (code, signal) => {
      if (settled) return
      if (typeof code !== 'number') {
        finish({
          passed: false,
          message: `command could not start: process exited by signal ${signal ?? 'unknown'}`,
          details: { kind: 'spawn-error', stdout: truncate(stdout), stderr: truncate(stderr) },
        })
        return
      }
      const passed = code === expected
      finish({
        passed,
        message: passed ? 'command passed' : `command exited ${code}, expected ${expected}`,
        details: {
          kind: 'exit',
          exitCode: code,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
        },
      })
    })
  })
}

function parseGitStatus(stdout: string): Array<{ path: string; status: string }> {
  const entries: Array<{ path: string; status: string }> = []
  const items = stdout.split('\0')
  let index = 0
  while (index < items.length) {
    const record = items[index] ?? ''
    index += 1
    if (!record) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (code[0] === 'R' || code[0] === 'C') index += 1
    if (path === '.dsh' || path.startsWith('.dsh/')) continue
    const status = code.includes('?') || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified'
    entries.push({ path, status })
  }
  return entries
}

function runDiffCheck(workspace: string, check: WorkspaceCheck): Promise<Omit<WorkspaceCheckResult, 'check'>> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      resolveResult({ passed: false, message: `diff check needs a git repository: ${error.message}` })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolveResult({ passed: false, message: `diff check needs a git repository: ${stderr.trim() || 'git status failed'}` })
        return
      }
      const diff = parseGitStatus(stdout)
      const allow = Array.isArray(check.allow) ? check.allow.filter((item): item is string => typeof item === 'string') : undefined
      const deny = Array.isArray(check.deny) ? check.deny.filter((item): item is string => typeof item === 'string') : undefined
      const unexpected = diff.filter((entry) => allow !== undefined && !matchesAny(entry.path, allow))
      const denied = diff.filter((entry) => matchesAny(entry.path, deny))
      const limit = check.maxChangedFiles
      const overLimit = typeof limit === 'number' && diff.length > limit
      const passed = unexpected.length === 0 && denied.length === 0 && !overLimit
      resolveResult({
        passed,
        message: passed ? 'diff rules passed' : 'diff rules failed',
        details: { unexpected, denied, changedFiles: diff.length },
      })
    })
  })
}

async function runOne(workspace: string, check: WorkspaceCheck): Promise<WorkspaceCheckResult> {
  try {
    if (check.type === 'file') return { check, ...(await runFileCheck(workspace, check)) }
    if (check.type === 'command') return { check, ...(await runCommandCheck(workspace, check)) }
    if (check.type === 'diff') return { check, ...(await runDiffCheck(workspace, check)) }
    return { check, passed: false, message: `unsupported check type: ${JSON.stringify(check.type)}` }
  } catch (error) {
    return { check, passed: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function runWorkspaceChecks(workspace: string, checks: unknown[]): Promise<WorkspaceVerifyResult> {
  const started = Date.now()
  if (!Array.isArray(checks) || checks.length === 0) {
    return {
      contract: VERIFY_CONTRACT,
      status: 'error',
      passed: false,
      checks: [],
      error: 'checks must be a non-empty list',
      seconds: 0,
    }
  }
  const results: WorkspaceCheckResult[] = []
  for (const item of checks) {
    const check = item && typeof item === 'object' && !Array.isArray(item) ? item as WorkspaceCheck : { type: String(item) }
    results.push(await runOne(workspace, check))
  }
  const passed = results.every((item) => item.passed)
  return {
    contract: VERIFY_CONTRACT,
    status: 'completed',
    passed,
    checks: results,
    error: null,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
  }
}
