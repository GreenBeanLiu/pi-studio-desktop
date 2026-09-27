import type {
  CompiledRunProfile,
  RunProfileCompileOptions,
  RunProfileKind,
} from './run-profile'
import {
  startPiRuntime,
  startPiRuntimeCancellable,
  type PiAgentRunHandle,
} from './pi-runtime'
import {
  JsonlRuntimeEventRecorder,
  runtimeEventLogPath,
  runtimeEventTimestamp,
  summarizeRuntimeProfile,
  type RuntimeEventRecord,
  type RuntimeEventRecorder,
} from './runtime-event-recorder'

export type RuntimeHostRun = {
  profile: CompiledRunProfile
  client: PiAgentRunHandle
}

export type RuntimeHostStartOptions = RunProfileCompileOptions & {
  signal?: AbortSignal
  onOwned?: (cleanup: () => Promise<void>) => void
  audit?: Record<string, unknown>
}

type RuntimeLogSink = (
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  details?: unknown,
) => void

type RuntimeHostDependencies = {
  compileProfile: (
    kind: RunProfileKind,
    cwd: string,
    options?: RunProfileCompileOptions,
  ) => Promise<CompiledRunProfile>
  startRuntime: (profile: CompiledRunProfile) => Promise<PiAgentRunHandle>
  startCancellableRuntime: (
    profile: CompiledRunProfile,
    signal: AbortSignal,
    options?: { onOwned?: (cleanup: () => Promise<void>) => void },
  ) => Promise<PiAgentRunHandle>
  appendLog: RuntimeLogSink
  resolveRecorder?: () => RuntimeEventRecorder | null | Promise<RuntimeEventRecorder | null>
}

function appendDesktopAppLog(...args: Parameters<RuntimeLogSink>): void {
  if (!process.versions.electron) return
  void import('./app-log')
    .then(({ appendAppLog }) => appendAppLog(...args))
    .catch(() => {})
}

let desktopRecorder: RuntimeEventRecorder | null | undefined

async function resolveDesktopRuntimeRecorder(): Promise<RuntimeEventRecorder | null> {
  if (!process.versions.electron) return null
  if (desktopRecorder !== undefined) return desktopRecorder
  const electron = (await import('electron')) as {
    app?: { getPath: (name: 'userData') => string }
    default?: { app?: { getPath: (name: 'userData') => string } }
  }
  const app = electron.app ?? electron.default?.app
  if (!app) {
    desktopRecorder = null
    return desktopRecorder
  }
  desktopRecorder = new JsonlRuntimeEventRecorder(runtimeEventLogPath(app.getPath('userData')))
  return desktopRecorder
}

const DEFAULT_DEPENDENCIES: RuntimeHostDependencies = {
  compileProfile: async (kind, cwd, options) => {
    const { runProfileCompiler } = await import('./run-profile')
    return runProfileCompiler.compile(kind, cwd, options)
  },
  startRuntime: startPiRuntime,
  startCancellableRuntime: (profile, signal, options) =>
    startPiRuntimeCancellable(profile, signal, options),
  appendLog: appendDesktopAppLog,
  resolveRecorder: resolveDesktopRuntimeRecorder,
}

function compileOptions(options: RuntimeHostStartOptions): RunProfileCompileOptions {
  return {
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.subagentsAvailable !== undefined
      ? { subagentsAvailable: options.subagentsAvailable }
      : {}),
    ...(options.workspaceReadOnly !== undefined
      ? { workspaceReadOnly: options.workspaceReadOnly }
      : {}),
  }
}

/**
 * RuntimeHost is the host-side seam for launching pi-backed runs.
 *
 * Callers pick the run kind and workspace; this module owns profile compilation,
 * cancellable startup wiring, and the shared audit record. Session switching and
 * event projection stay in PiClientManager/AgentPool.
 */
export class RuntimeHost {
  constructor(private readonly dependencies: RuntimeHostDependencies = DEFAULT_DEPENDENCIES) {}

  async start(
    kind: RunProfileKind,
    cwd: string,
    options: RuntimeHostStartOptions = {},
  ): Promise<RuntimeHostRun> {
    const profile = await this.dependencies.compileProfile(kind, cwd, compileOptions(options))
    return this.startCompiled(profile, options)
  }

  async startCompiled(
    profile: CompiledRunProfile,
    options: Omit<RuntimeHostStartOptions, keyof RunProfileCompileOptions> = {},
  ): Promise<RuntimeHostRun> {
    const client = options.signal
      ? await this.dependencies.startCancellableRuntime(profile, options.signal, {
          onOwned: options.onOwned,
        })
      : await this.dependencies.startRuntime(profile)
    this.logStart(profile, options.audit)
    await this.attachRecorder(client, profile, options.audit)
    return { profile, client }
  }

  private logStart(profile: CompiledRunProfile, audit?: Record<string, unknown>): void {
    this.dependencies.appendLog('info', 'agent.start', 'Pi agent process started', {
      kind: profile.kind,
      cwd: profile.cwd,
      provider: profile.provider,
      model: profile.model ?? null,
      sandboxMode: profile.sandboxMode,
      security: profile.security,
      profileDigest: profile.profileDigest,
      ...(audit ?? {}),
    })
  }

  private async attachRecorder(
    client: PiAgentRunHandle,
    profile: CompiledRunProfile,
    audit?: Record<string, unknown>,
  ): Promise<void> {
    let recorder: RuntimeEventRecorder | null | undefined
    try {
      recorder = await this.dependencies.resolveRecorder?.()
    } catch (error) {
      this.dependencies.appendLog('warn', 'runtime.events', 'Failed to initialize runtime recorder', {
        runId: client.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (!recorder) return
    const runId = client.id
    let settled = false
    let queue = Promise.resolve()
    const enqueue = (record: RuntimeEventRecord): Promise<void> => {
      queue = queue
        .catch(() => {})
        .then(() => Promise.resolve(recorder.append(record)))
        .catch((error) => {
          this.dependencies.appendLog('warn', 'runtime.events', 'Failed to append runtime event', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return queue
    }
    const now = runtimeEventTimestamp
    await enqueue({
      type: 'run.started',
      runId,
      at: now(),
      profile: summarizeRuntimeProfile(profile),
      ...(audit ? { audit } : {}),
    })
    const detach = client.onEvent((event) => {
      void enqueue({ type: 'runtime.event', runId, at: now(), event })
      if ((event as { type?: unknown }).type === 'agent_settled' && !settled) {
        settled = true
        void enqueue({ type: 'run.settled', runId, at: now(), reason: 'agent_settled' })
      }
    })
    this.wrapCleanup(client, 'dispose', detach, enqueue, now)
    this.wrapCleanup(client, 'forceDispose', detach, enqueue, now)
  }

  private wrapCleanup(
    client: PiAgentRunHandle,
    mode: 'dispose' | 'forceDispose',
    detach: () => void,
    enqueue: (record: RuntimeEventRecord) => Promise<void>,
    now: () => string,
  ): void {
    const original = client[mode].bind(client)
    client[mode] = async (): Promise<void> => {
      try {
        await original()
        await enqueue({ type: 'cleanup', runId: client.id, at: now(), mode, status: 'ok' })
      } catch (error) {
        await enqueue({
          type: 'cleanup',
          runId: client.id,
          at: now(),
          mode,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      } finally {
        detach()
      }
    }
  }
}

export const runtimeHost = new RuntimeHost()
