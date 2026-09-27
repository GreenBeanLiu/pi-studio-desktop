import { createHash } from 'crypto'
import type { AgentRuntimeConfig } from './agent-runtime-config'
import { prepareAgentRuntime } from './agent-runtime-config'
import { resolvePiCliPath } from './pi-process'
import { prepareSandboxLaunch, sandboxAgentPath } from './sandbox'
import { loadSettings } from './settings'
import type { ExecutionSecuritySnapshot, SandboxMode } from '../shared/ipc/contract'
import { DEFAULT_THINKING_LEVEL } from '../shared/agent-defaults'
import { appendAppLog } from './app-log'

export type RunProfileKind = 'chat' | 'routine' | 'code-model' | 'blender-model'

export type RunProfileCompileOptions = {
  extensions?: string[]
  subagentsAvailable?: boolean
}

export type CompiledRunProfile = {
  kind: RunProfileKind
  cwd: string
  provider: string
  model?: string
  env: Record<string, string>
  cliPath: string
  args: string[]
  thinkingLevel: typeof DEFAULT_THINKING_LEVEL
  sandboxMode: SandboxMode | null
  security: ExecutionSecuritySnapshot
  declaredCapabilities?: { subagents: boolean }
  profileDigest: string
}

type RunProfileCompilerDependencies = {
  loadSettings: () => { sandboxEnabled: boolean; subagentsEnabled?: boolean }
  prepareRuntime: (cwd?: string) => Promise<AgentRuntimeConfig>
  prepareSandbox: (
    cwd: string,
    env: Record<string, string>,
  ) => Promise<{ cliPath: string; env: Record<string, string>; mode: SandboxMode }>
  resolveCliPath: () => string
}

const DEFAULT_DEPENDENCIES: RunProfileCompilerDependencies = {
  loadSettings,
  prepareRuntime: prepareAgentRuntime,
  prepareSandbox: prepareSandboxLaunch,
  resolveCliPath: resolvePiCliPath,
}

function profileDigest(profile: Omit<CompiledRunProfile, 'profileDigest' | 'env'>, env: Record<string, string>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...profile,
        envNames: Object.keys(env).sort(),
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

function securitySnapshot(
  kind: RunProfileKind,
  sandboxMode: SandboxMode | null,
): ExecutionSecuritySnapshot {
  const hostCodeExecution = kind === 'code-model' || kind === 'blender-model'
  if (sandboxMode === 'wsl') {
    return {
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'allowlist',
      backend: 'wsl-bwrap',
      enforcement: hostCodeExecution ? 'partial' : 'full',
      hostCodeExecution,
      reason: hostCodeExecution
        ? 'Pi is confined by WSL bubblewrap and the outbound allowlist; generated code is still executed by the host.'
        : 'Pi is confined by WSL bubblewrap and the outbound allowlist.',
    }
  }
  if (sandboxMode === 'seatbelt') {
    return {
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'allowlist',
      backend: 'macos-seatbelt',
      enforcement: hostCodeExecution ? 'partial' : 'full',
      hostCodeExecution,
      reason: hostCodeExecution
        ? 'Pi filesystem writes and outbound network are confined by the macOS Seatbelt sandbox; generated code is still executed by the host.'
        : 'Pi filesystem writes and outbound network are confined by the macOS Seatbelt sandbox.',
    }
  }
  if (sandboxMode === 'docker') {
    return {
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'unrestricted',
      backend: 'docker',
      enforcement: 'partial',
      hostCodeExecution,
      reason: hostCodeExecution
        ? 'Pi filesystem access is confined by Docker; outbound network access and generated host code execution are unrestricted.'
        : 'Pi filesystem access is confined by Docker; outbound network access is unrestricted.',
    }
  }
  return {
    requested: 'full-access',
    filesystemMode: 'danger-full-access',
    networkMode: 'unrestricted',
    backend: 'host',
    enforcement: 'none',
    hostCodeExecution,
    reason: 'Sandbox is disabled; Pi runs with the desktop user permissions.',
  }
}

function isolatedArgs(extensions: string[], tools: string): string[] {
  return [
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    ...extensions.flatMap((extension) => ['--extension', extension]),
    '--tools',
    tools,
  ]
}

function runArgs(kind: RunProfileKind, options: RunProfileCompileOptions): string[] {
  if (kind === 'routine') {
    return isolatedArgs(
      [...new Set(options.extensions ?? [])],
      'read,edit,write,grep,find,ls,web_search',
    )
  }
  if (kind === 'code-model' || kind === 'blender-model') {
    return isolatedArgs([], 'read,edit,write')
  }
  return []
}

export class RunProfileCompiler {
  constructor(private readonly dependencies: RunProfileCompilerDependencies = DEFAULT_DEPENDENCIES) {}

  async compile(
    kind: RunProfileKind,
    cwd: string,
    options: RunProfileCompileOptions = {},
  ): Promise<CompiledRunProfile> {
    const settings = this.dependencies.loadSettings()
    const runtime = await this.dependencies.prepareRuntime(cwd)
    const prepared = settings.sandboxEnabled
      ? await this.dependencies.prepareSandbox(cwd, runtime.env)
      : { cliPath: this.dependencies.resolveCliPath(), env: runtime.env, mode: null }
    const security = securitySnapshot(kind, prepared.mode)
    const sandboxMode = prepared.mode
    const profileOptions = sandboxMode
      ? {
          ...options,
          extensions: options.extensions?.map((extension) =>
            sandboxAgentPath(extension, sandboxMode),
          ),
        }
      : options
    const base = {
      kind,
      cwd,
      provider: runtime.provider,
      model: runtime.model,
      cliPath: prepared.cliPath,
      args: runArgs(kind, profileOptions),
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      sandboxMode,
      security,
      declaredCapabilities: {
        subagents:
          kind === 'chat' &&
          (options.subagentsAvailable ?? settings.subagentsEnabled === true),
      },
    } satisfies Omit<CompiledRunProfile, 'profileDigest' | 'env'>
    const compiled = {
      ...base,
      env: prepared.env,
      profileDigest: profileDigest(base, prepared.env),
    }
    appendAppLog('info', 'agent.profile', 'Compiled Pi run profile', {
      kind,
      cwd,
      profileDigest: compiled.profileDigest,
      sandboxMode: compiled.sandboxMode,
      security: compiled.security,
      args: compiled.args,
    })
    return compiled
  }
}

export const runProfileCompiler = new RunProfileCompiler()
