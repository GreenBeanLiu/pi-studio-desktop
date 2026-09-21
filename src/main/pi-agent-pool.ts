import { join } from 'path'
import { randomUUID } from 'crypto'
import { appendAppLog, normalizeError } from './app-log'
import { agentConfigDir } from './settings'
import { sandboxAgentPath, sandboxSessionPathToHost } from './sandbox'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import type { PiAgentRunHandle } from './pi-runtime'
import { runtimeHost } from './runtime-host'
import {
  AgentJobRegistry,
  isTerminalJobState,
  type AgentJob,
  type AgentJobSnapshot,
} from './agent-job-registry'
import { AgentLoopGuard } from './agent-loop-guard'
import { AcpConnection } from './acp-connection'
import type { AcpLaunchSpec } from './acp-launch-spec'
import { AgentStatusTracker } from './agent-status'
import { artifactWorkspaceKey } from './agent-artifact'
import {
  MAX_LIVE_AGENTS,
  NO_WORKSPACE_ERROR,
  pickEvictableAgent,
  sessionKey,
  type AgentEntry,
  type AgentBackend,
  type AgentStatusEvent,
  type LaunchContext,
  type SessionActivityEvent,
} from './pi-agent-entry'

/**
 * 池子需要问上层的事。进程层不持有「哪个会话在前台」这个概念 —— 那是 session 层的,
 * 但崩溃收尾要按前后台走不同的上报路径,所以通过 host 反查。
 */
export type AgentPoolHost = {
  currentWorkspacePath(): string | null
  isActive(entry: AgentEntry): boolean
  /** 子进程的原始事件流,交给投影层。 */
  handleRuntimeEvent(entry: AgentEntry, event: PiRuntimeEvent): void
  /** entry 已经从池子里摘掉(崩溃或回收),session 层据此清掉 active。 */
  onEntryRemoved(entry: AgentEntry): void
  /** 前台进程异常退出/出错才报。 */
  emitStatus(event: AgentStatusEvent): void
  /** 后台进程崩了只更新侧栏的运行状态。 */
  emitActivity(event: SessionActivityEvent): void
}

export type AgentPoolRuntimeLauncher = (
  profile: LaunchContext,
  options?: { audit?: Record<string, unknown> },
) => Promise<{ client: PiAgentRunHandle }>

/**
 * 一个聊天一个 `pi` RPC 子进程,池子管它们的生死。
 *
 * 早先所有聊天共用一个进程、靠 pi 的 new_session/switch_session 来回切,但那两个
 * 调用会直接 dispose 当前会话:正在跑的一轮被掐断且一个收尾事件都不发(实测),
 * 界面就永远停在最后一步。而且模型、推理深度这些是进程级状态,在一个聊天里改会串到
 * 另一个聊天。改成按会话开进程之后,切换只是换看哪一个,后台那轮照常跑完。
 */
export class AgentPool {
  private launch: LaunchContext | null = null
  private entries: AgentEntry[] = []
  private readonly jobs = new AgentJobRegistry()

  constructor(
    private readonly host: AgentPoolHost,
    private readonly launchRuntime: AgentPoolRuntimeLauncher = (profile, options) =>
      runtimeHost.startCompiled(profile, options),
  ) {}

  setLaunch(launch: LaunchContext | null): void {
    this.launch = launch
  }

  launchContext(): LaunchContext | null {
    return this.launch
  }

  find(sessionFile: string | null): AgentEntry | undefined {
    const wanted = sessionKey(sessionFile)
    return this.entries.find((candidate) => sessionKey(candidate.sessionFile) === wanted)
  }

  /** 还没确认放掉资源的 agent 数(诊断用);orphaned 的算在里面,它的进程可能还活着。 */
  liveAgentCount(): number {
    return this.jobs.live().length
  }

  /** owner、血缘、终态和资源回收证据 —— 诊断包里能看到后台到底剩了什么。 */
  agentJobs(): AgentJobSnapshot[] {
    return this.jobs.snapshot()
  }

  /** 子代理跑在 pi 进程内部,只能按工具调用登记成没有资源的逻辑 job。 */
  registerSubagentJob(entry: AgentEntry): AgentJob {
    return this.jobs.register({
      kind: 'subagent',
      parentId: entry.job.id,
      owner: { sessionId: entry.sessionId, sessionFile: entry.sessionFile },
    })
  }

  /** 还活着的外部 agent 会话。会话列表只列这些 —— 断了的没法恢复,列出来点不开。 */
  acpEntries(): AgentEntry[] {
    return this.entries.filter((entry) => entry.acp !== null)
  }

  toHostSessionPath(sessionFile: string | null): string | null {
    if (!sessionFile) return null
    return this.launch?.sandboxSessionPaths ? sandboxSessionPathToHost(sessionFile) : sessionFile
  }

  /**
   * 把一个已经创建好的 backend 纳入 Session Kernel 的共同生命周期。
   *
   * Pi 和 ACP 的启动握手不同，但握手完成后都必须由同一处登记资源、挂事件、
   * 维护 status 并负责回收。把这些步骤散在两个 spawn 分支里，很容易让新加的
   * 生命周期能力只覆盖其中一个 backend。
   */
  private adoptBackend(options: {
    client: AgentBackend
    pi: PiAgentRunHandle | null
    acp: AgentEntry['acp']
    statusFile: string
    sessionFile: string | null
    sessionId: string | null
  }): AgentEntry {
    const job = this.jobs.register({
      kind: 'chat',
      owner: { sessionFile: options.sessionFile },
      resources: {
        dispose: () => options.client.dispose(),
        forceDispose: () => options.client.forceDispose(),
        pid: options.client.processId(),
      },
    })
    const entry: AgentEntry = {
      client: options.client,
      pi: options.pi,
      acp: options.acp,
      firstMessage: null,
      job,
      sessionFile: options.sessionFile,
      sessionId: options.sessionId,
      unsubscribe: null,
      pendingUi: [],
      outstandingUi: new Map(),
      subagentJobs: new Map(),
      statusFile: options.statusFile,
      status: new AgentStatusTracker(options.statusFile, this.launch?.cwd ?? ''),
      loopGuard: new AgentLoopGuard(),
    }
    entry.status.write()
    this.attachAgentProcessLoggers(entry)
    entry.unsubscribe = options.client.onEvent((event) => this.host.handleRuntimeEvent(entry, event))
    this.entries.push(entry)
    return entry
  }

  /** 起一个新的 agent 进程;restoreSessionFile 非空时让它接管那个已有会话。 */
  async spawn(restoreSessionFile: string | null): Promise<AgentEntry> {
    const launch = this.launch
    if (!launch) throw new Error(NO_WORKSPACE_ERROR)

    const statusFile = join(agentConfigDir(), 'runtime-status', `${randomUUID()}.json`)
    const runtimeLaunch = {
      ...launch,
      env: {
        ...launch.env,
        PI_STUDIO_STATUS_FILE: launch.sandboxSessionPaths
          ? sandboxAgentPath(statusFile, launch.sandboxMode!)
          : statusFile,
        PI_STUDIO_ARTIFACT_DIR: launch.sandboxSessionPaths
          ? sandboxAgentPath(join(agentConfigDir(), 'artifacts'), launch.sandboxMode!)
          : join(agentConfigDir(), 'artifacts'),
        PI_STUDIO_ARTIFACT_WORKSPACE_KEY: artifactWorkspaceKey(launch.cwd),
      },
    }
    const { client } = await this.launchRuntime(runtimeLaunch, {
      audit: {
        source: 'chat-pool',
        requestedSessionFile: restoreSessionFile,
      },
    })
    const entry = this.adoptBackend({
      client,
      pi: client,
      acp: null,
      statusFile,
      sessionFile: null,
      sessionId: null,
    })

    // 全新的 agent 上没有正在跑的一轮,这时候 switch_session 是安全的
    if (restoreSessionFile) {
      try {
        // 必须走 mode-aware 的 sandboxAgentPath:sandboxSessionPathToContainer 只会
        // 映射到 Docker 的 /agent,而 seatbelt 用的就是宿主真实路径、wsl 用发行版路径。
        // 直接调它会让 seatbelt 下每次恢复会话都 EPERM(mkdir '/agent/sessions/...')。
        await client.switchSession(
          launch.sandboxSessionPaths && launch.sandboxMode
            ? sandboxAgentPath(restoreSessionFile, launch.sandboxMode)
            : restoreSessionFile,
        )
      } catch (err) {
        appendAppLog('warn', 'agent.restoreSession', 'Failed to restore previous session', {
          cwd: launch.cwd,
          sessionFile: restoreSessionFile,
          error: normalizeError(err),
        })
      }
    }

    try {
      const state = await client.getState()
      entry.sessionFile = this.toHostSessionPath(state?.sessionFile ?? null)
      entry.sessionId = state?.sessionId ?? null
    } catch (err) {
      appendAppLog('warn', 'agent.state', 'Failed to read initial agent state', normalizeError(err))
    }
    entry.job.claim({ sessionId: entry.sessionId, sessionFile: entry.sessionFile })
    entry.job.ready()

    await this.evictIfNeeded()
    return entry
  }

  /**
   * 起一个由外部 ACP agent 驱动的会话。
   *
   * 和 pi 那条路的区别只有两处:没有会话文件(会话在外部 agent 那边,宿主读不到)、
   * entry.pi 是 null(pi 独有的能力用不了)。其余生命周期记账完全一样。
   *
   * resumeSessionId 非空时不新建会话,让 agent 回放那个会话的历史。
   */
  async spawnAcp(
    agentId: string,
    agentName: string,
    spec: AcpLaunchSpec,
    resumeSessionId?: string,
  ): Promise<AgentEntry> {
    const launch = this.launch
    if (!launch) throw new Error(NO_WORKSPACE_ERROR)

    const connection = await AcpConnection.spawnAndOpen(spec, launch.cwd, {
      agentId,
      resumeSessionId,
    })
    const statusFile = join(agentConfigDir(), 'runtime-status', `${randomUUID()}.json`)
    const entry = this.adoptBackend({
      client: connection,
      pi: null,
      acp: { agentId, agentName },
      statusFile,
      sessionFile: null,
      sessionId: connection.sessionId,
    })
    entry.job.claim({ sessionId: entry.sessionId, sessionFile: null })
    entry.job.ready()

    await this.evictIfNeeded()
    return entry
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.length > MAX_LIVE_AGENTS) {
      const candidates = this.entries.map((entry) => ({
        entry,
        runActive: entry.job.isRunActive(),
        lastActivatedAt: entry.job.activatedAt(),
      }))
      const active = candidates.find((candidate) => this.host.isActive(candidate.entry)) ?? null
      const victim = pickEvictableAgent(candidates, active)
      if (!victim) return
      await this.stopEntry(victim.entry, 'evicted')
    }
  }

  async stopEntry(entry: AgentEntry, reason: string): Promise<void> {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    this.host.onEntryRemoved(entry)
    for (const [, job] of entry.subagentJobs) void job.finish(reason)
    entry.status.dispose()
    entry.subagentJobs.clear()
    // finish() 只在资源真的放掉之后才回 done:优雅停不住就强杀,强杀也失败就留成
    // orphaned 并带上证据,而不是当作已回收。
    this.reportJobSettled(await entry.job.finish(reason), entry)
  }

  private reportJobSettled(snapshot: AgentJobSnapshot, entry: AgentEntry): void {
    const details = {
      cwd: this.host.currentWorkspacePath(),
      sessionFile: entry.sessionFile,
      jobId: snapshot.id,
      reason: snapshot.finishReason,
      pid: snapshot.pid,
      forced: snapshot.forced,
    }
    if (snapshot.state === 'orphaned') {
      appendAppLog('error', 'agent.stop', 'Pi agent process cleanup could not be confirmed', {
        ...details,
        cleanupError: snapshot.cleanupError,
      })
      return
    }
    appendAppLog(
      snapshot.forced ? 'warn' : 'info',
      'agent.stop',
      snapshot.forced ? 'Pi agent process killed after a stalled stop' : 'Pi agent process stopped',
      details,
    )
  }

  async stopAll(reason: string): Promise<void> {
    // 每个 job 的收尾都是有界的,并行收不会互相拖住工作区切换。
    await Promise.all([...this.entries].map((entry) => this.stopEntry(entry, reason)))
    this.entries = []
    this.launch = null
    this.jobs.prune()
  }

  private attachAgentProcessLoggers(entry: AgentEntry): void {
    const cwd = this.launch?.cwd ?? ''
    entry.client.observeProcess({
      stderr: (chunk) => {
        const message = String(chunk).trim()
        if (!message) return
        appendAppLog('warn', 'agent.stderr', message, { cwd })
      },
      exit: (code, signal) => {
        // 谁在收这个 job 就写在 job 状态上,不用另存一份 runId 集合。
        const state = entry.job.currentState()
        const expected = state === 'cancelling' || isTerminalJobState(state)
        appendAppLog(code === 0 ? 'info' : 'warn', 'agent.exit', 'Pi agent process exited', {
          cwd,
          sessionFile: entry.sessionFile,
          jobId: entry.job.id,
          code,
          signal,
          expected,
        })
        if (expected) return
        entry.job.crashed(
          code === null
            ? `Agent process exited with signal ${signal ?? 'unknown'}`
            : `Agent process exited with code ${code}`,
        )
        const wasActive = this.host.isActive(entry)
        this.forgetEntry(entry)
        // 后台会话崩了不该打翻前台:只报活动状态,前台崩了才走 agent 错误横幅
        if (!wasActive) {
          this.host.emitActivity({ sessionFile: entry.sessionFile, running: false })
          return
        }
        this.host.emitStatus({
          status: 'exited',
          cwd,
          code,
          signal,
          expected,
          message:
            code === null
              ? `Agent process exited with signal ${signal ?? 'unknown'}`
              : `Agent process exited with code ${code}`,
        })
      },
      error: (err) => {
        appendAppLog('error', 'agent.process', 'Pi agent process error', {
          cwd,
          sessionFile: entry.sessionFile,
          jobId: entry.job.id,
          error: normalizeError(err),
        })
        entry.job.crashed(err.message ?? String(err))
        const wasActive = this.host.isActive(entry)
        this.forgetEntry(entry)
        if (!wasActive) return
        this.host.emitStatus({ status: 'error', cwd, message: err.message ?? String(err) })
      },
    })
  }

  private forgetEntry(entry: AgentEntry): void {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    entry.status.dispose()
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    this.host.onEntryRemoved(entry)
    // 进程已经没了,子代理的逻辑 job 不能继续挂在 running 上。
    for (const [, job] of entry.subagentJobs) void job.finish('parent agent process ended')
    entry.subagentJobs.clear()
  }
}
