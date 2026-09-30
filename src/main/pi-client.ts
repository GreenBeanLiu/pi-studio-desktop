import { dirname, join } from 'path'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { appendAppLog, normalizeError } from './app-log'
import { agentConfigDir, saveSelectedModelRoute } from './settings'
import { runProfileCompiler } from './run-profile'
import type {
  ExtensionUiResponse,
  ModelInfo,
  PiRuntimeEvent,
  SessionInfo,
} from '../shared/ipc/contract'
import { acpSessionKey, parseAcpSessionKey } from '../shared/acp-session-key'
import { loadRpcClient } from './pi-process'
import type { BlockingExtensionUiMethod } from './extension-ui-ownership'
import type { AgentJob, AgentJobSnapshot } from './agent-job-registry'
import type { AgentStatusSnapshot } from './agent-status'
import { AgentPool, type AgentPoolHost } from './pi-agent-pool'
import { AcpRegistry } from './acp-registry'
import { AcpSessionStore, acpRecordToSessionInfo } from './acp-session-store'
import { resolveAcpLaunchSpec } from './acp-launch-spec'
import {
  ACP_MODEL_PROVIDER,
  acpModelEntries,
  isAcpModelRoute,
  mergeModelEntries,
} from './acp-model-entries'
import { EventProjection, type EventProjectionHost } from './pi-event-projection'
import { UnattendedApprovalGate } from './approval-gateway'
import {
  entryContext,
  unsupportedByBackend,
  NO_WORKSPACE_ERROR,
  type AgentEntry,
  type AgentStatusEvent,
  type AgentStatusListener,
  type PiEventContext,
  type PiEventListener,
  type RpcClient,
  type SessionActivatedListener,
  type SessionActivityEvent,
  type SessionActivityListener,
} from './pi-agent-entry'

export { embeddedNodeEnv, loadRpcClient, resolveEmbeddedNodePath, resolvePiCliPath } from './pi-process'

// 进程层(pi-agent-pool)、投影层(pi-event-projection)和这里的会话层拆开之后,
// 这些共享定义落在 pi-agent-entry;从 pi-client 继续导出,调用方不用改。
export {
  MAX_LIVE_AGENTS,
  NO_WORKSPACE_ERROR,
  nextRunActive,
  pickEvictableAgent,
  sessionKey,
} from './pi-agent-entry'

export type StartWorkspaceOptions = {
  subagentsAvailable?: boolean
}

/**
 * 控制面任务能指定的 agent。pi 是自家的;另外两个经 ACP 接进来,id 和模型菜单里的一致。
 * 远程 `capabilities` 把这张表报给控制面,它据此决定能不能走 startTask。
 */
export const TASK_AGENTS = ['pi', 'claude-acp', 'codex-acp'] as const
export type TaskAgent = (typeof TASK_AGENTS)[number]

export type StartTaskRequest = {
  taskId: string
  agent: TaskAgent
  prompt: string
  /** 外部 agent 的权限档(比如 Claude 的 plan / acceptEdits、Codex 的 read-only / agent);pi 不接受。 */
  permissionMode?: string
}

export type TaskEventListener = (taskId: string, event: PiRuntimeEvent, context: PiEventContext) => void
export type {
  AgentStatusEvent,
  AgentStatusListener,
  PiEventContext,
  PiEventListener,
  SessionActivatedListener,
  SessionActivityEvent,
  SessionActivityListener,
} from './pi-agent-entry'

/**
 * 会话层:哪个 agent 在前台、切换/新建/释放会话,以及对外的 RPC 门面。
 *
 * 进程的生死交给 {@link AgentPool},事件流投影交给 {@link EventProjection} ——
 * 这里只回答"现在看的是哪一个",并把 RPC 转发给它。
 */
class PiClientManager implements AgentPoolHost, EventProjectionHost {
  private workspacePath: string | null = null
  private active: AgentEntry | null = null
  private lastSessionFile: string | null = null
  private onEvent: PiEventListener | null = null
  private onStatus: AgentStatusListener | null = null
  private onActivity: SessionActivityListener | null = null
  private onActivated: SessionActivatedListener | null = null
  private onTaskEvent: TaskEventListener | null = null
  /** 进行中的控制面任务会话,按 taskId 找(取消要用)。收掉就删。 */
  private readonly tasks = new Map<string, AgentEntry>()
  private readonly pool = new AgentPool(this)
  private readonly projection = new EventProjection(this)
  private readonly acpRegistry = new AcpRegistry()
  /** 外部 agent 会话的索引。懒建 —— agentConfigDir() 要等 electron 的 app 就绪。 */
  private acpStore: AcpSessionStore | null = null
  /**
   * 上一次从 pi 进程拿到的模型列表。当前会话是 ACP 时没有 pi 进程可问,
   * 但用户仍然要能切回自己的模型 —— 宁可给一份缓存的,也不能让那一组整个消失。
   */
  private lastPiModels: ModelInfo[] = []
  /**
   * 本工作区的会话目录。
   *
   * 它原来是每次都从「当前会话的 sessionFile」现推的,但 ACP 会话没有 sessionFile ——
   * 那样一来只要当前会话是外部 agent,整个会话列表就空了(不是少一条,是全没)。
   * 目录是工作区级的,而且编码规则在 pi 内部(自己重算很脆),所以从 pi 那里
   * 学到一次就记住。
   */
  private sessionDir: string | null = null

  // ---- AgentPoolHost / EventProjectionHost ----

  currentWorkspacePath(): string | null {
    return this.workspacePath
  }

  isActive(entry: AgentEntry): boolean {
    return this.active === entry
  }

  /** 池子收到的子进程事件一律先过投影层,再决定推不推给界面。 */
  handleRuntimeEvent(entry: AgentEntry, event: PiRuntimeEvent): void {
    this.projection.handleEvent(entry, event)
  }

  onEntryRemoved(entry: AgentEntry): void {
    if (this.active === entry) this.active = null
    if (entry.task && this.tasks.get(entry.task.taskId) === entry) this.tasks.delete(entry.task.taskId)
  }

  emitTaskEvent(entry: AgentEntry, event: PiRuntimeEvent): void {
    const task = entry.task
    if (!task) return
    this.onTaskEvent?.(task.taskId, event, entryContext(entry))
    // 一轮真正结束(agent_settled)就收掉进程:会话记录已经落盘,侧栏里还能打开看。
    if (event.type === 'agent_settled') {
      this.tasks.delete(task.taskId)
      void this.pool.stopEntry(entry, 'task settled').catch((err) => {
        appendAppLog('warn', 'task.session', 'Failed to stop a settled task session', {
          taskId: task.taskId,
          error: normalizeError(err),
        })
      })
    }
  }

  setTaskEventListener(listener: TaskEventListener | null): void {
    this.onTaskEvent = listener
  }

  /**
   * 控制面派来的任务:另起一个后台会话跑,不碰你正在看的那个。
   *
   * 以前控制面直接发 `prompt`,落进桌面当前打开的会话 —— 你正选着 Codex 就被 Codex 跑,
   * 任务的对话还插进你正在聊的那段。现在每个任务一个会话,agent 由任务指定,
   * 事件经 emitTaskEvent 按 taskId 推给控制面,审批由无人值守闸门处理(见 TaskBinding)。
   */
  async startTask(request: StartTaskRequest): Promise<{ sessionId: string; agent: TaskAgent }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    if (!TASK_AGENTS.includes(request.agent)) throw new Error(`不认识的 agent:${request.agent}`)
    if (this.tasks.has(request.taskId)) throw new Error(`任务 ${request.taskId} 已经在跑了`)
    if (request.agent === 'pi' && request.permissionMode) {
      throw new Error('pi 会话没有权限档可切(它的权限靠沙箱)')
    }
    const entry = request.agent === 'pi' ? await this.pool.spawn(null) : await this.spawnAcpEntry(request.agent)
    // 在发 prompt 之前挂上:从第一条事件起就按任务处理
    entry.task = { taskId: request.taskId, gate: new UnattendedApprovalGate() }
    this.tasks.set(request.taskId, entry)
    try {
      if (request.permissionMode) {
        const set = entry.client.setPermissionMode
        if (!set) throw unsupportedByBackend(entry, '切换权限模式')
        await set.call(entry.client, request.permissionMode)
      }
      entry.firstMessage ??= request.prompt
      await entry.client.send(request.prompt)
    } catch (err) {
      this.tasks.delete(request.taskId)
      await this.pool.stopEntry(entry, 'task failed to start').catch(() => {})
      throw err
    }
    appendAppLog('info', 'task.session', 'Started a control-plane task session', {
      taskId: request.taskId,
      agent: request.agent,
      sessionId: entry.sessionId,
    })
    return { sessionId: entry.sessionId ?? entry.job.id, agent: request.agent }
  }

  /** 取消一个任务会话:先让 agent 停下这一轮,再收掉进程。没有这个任务就返回 false。 */
  async cancelTask(taskId: string): Promise<boolean> {
    const entry = this.tasks.get(taskId)
    if (!entry) return false
    this.tasks.delete(taskId)
    await entry.client.cancel('task cancelled').catch(() => {})
    await this.pool.stopEntry(entry, 'task cancelled')
    return true
  }

  emitEvent(event: PiRuntimeEvent, context: PiEventContext): void {
    this.onEvent?.(event, context)
  }

  emitActivity(event: SessionActivityEvent): void {
    this.onActivity?.(event)
  }

  emitStatus(event: AgentStatusEvent): void {
    this.onStatus?.(event)
  }

  registerSubagentJob(entry: AgentEntry): AgentJob {
    return this.pool.registerSubagentJob(entry)
  }

  /** Pre-import the pi-coding-agent ESM graph so the first workspace open
   *  doesn't pay the module-load cost (hundreds of ms) on click. */
  warmup(): void {
    loadRpcClient().catch((err) => {
      appendAppLog('warn', 'agent.warmup', 'Failed to warm up pi coding agent', normalizeError(err))
    })
  }

  async startWorkspace(
    cwd: string,
    options: StartWorkspaceOptions,
    onEvent: PiEventListener,
    onStatus?: AgentStatusListener,
    onWorkspaceStopped?: (cwd: string) => Promise<void>,
    onActivity?: SessionActivityListener,
    onActivated?: SessionActivatedListener,
  ): Promise<void> {
    const previousWorkspacePath = this.workspacePath
    const restoreSessionFile = previousWorkspacePath === cwd ? this.lastSessionFile : null
    await this.stop()
    if (previousWorkspacePath) await onWorkspaceStopped?.(previousWorkspacePath)

    const profile = await runProfileCompiler.compile('chat', cwd, {
      subagentsAvailable: options.subagentsAvailable,
    })
    const launch = {
      ...profile,
      sandboxSessionPaths: profile.sandboxMode !== null,
    }
    this.pool.setLaunch(launch)
    this.workspacePath = cwd
    this.onEvent = onEvent
    this.onStatus = onStatus ?? null
    this.onActivity = onActivity ?? null
    this.onActivated = onActivated ?? null

    const entry = await this.pool.spawn(restoreSessionFile)
    this.activate(entry)

    onStatus?.({
      status: 'started',
      cwd,
      restoredSession: !!restoreSessionFile && entry.sessionFile === restoreSessionFile,
      sessionId: entry.sessionId ?? entry.job.id,
      sessionFile: entry.sessionFile ?? undefined,
      sandbox: launch.sandboxMode ?? undefined,
      security: launch.security,
      profileDigest: launch.profileDigest,
    })
  }

  private sessions(): AcpSessionStore {
    this.acpStore ??= new AcpSessionStore(join(agentConfigDir(), 'acp-sessions.json'))
    return this.acpStore
  }

  private rememberSessionDir(sessionFile: string | null): void {
    if (sessionFile) this.sessionDir = dirname(sessionFile)
  }

  /** 本工作区的 pi 会话目录;工作区还没起过 pi 会话时是 null。 */
  getSessionDir(): string | null {
    return this.sessionDir
  }

  private activate(entry: AgentEntry): void {
    this.active = entry
    entry.job.touch()
    this.rememberSessionDir(entry.sessionFile)
    this.lastSessionFile = entry.sessionFile
    this.onActivated?.(entryContext(entry))
    const pending = entry.pendingUi.splice(0)
    for (const event of pending) this.onEvent?.(event, entryContext(entry))
  }

  async stop(): Promise<void> {
    await this.pool.stopAll('workspace closed')
    this.active = null
    this.workspacePath = null
    this.sessionDir = null
    this.onActivated = null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  /** 还没确认放掉资源的 agent 数(诊断用);orphaned 的算在里面,它的进程可能还活着。 */
  liveAgentCount(): number {
    return this.pool.liveAgentCount()
  }

  /** owner、血缘、终态和资源回收证据 —— 诊断包里能看到后台到底剩了什么。 */
  agentJobs(): AgentJobSnapshot[] {
    return this.pool.agentJobs()
  }

  /**
   * 删除会话前先把占着它的 agent 收掉,否则那个进程还在往已删掉的文件里写。
   * 正在跑的一轮不给收 —— 调用方应据此拒绝删除。
   */
  async releaseSession(sessionFile: string): Promise<{ released: boolean; running: boolean }> {
    const entry = this.pool.find(sessionFile)
    if (!entry) return { released: true, running: false }
    if (entry.job.isRunActive()) return { released: false, running: true }
    await this.pool.stopEntry(entry, 'session deleted')
    return { released: true, running: false }
  }

  /** pi 独有能力的入口。ACP 会话在这里明确报错,而不是静默无效。 */
  private requirePi(what: string): RpcClient {
    return this.piOf(this.requireEntry(), what)
  }

  private piOf(entry: AgentEntry, what: string): RpcClient {
    if (!entry.pi) throw unsupportedByBackend(entry, what)
    return entry.pi
  }

  private requireEntry(): AgentEntry {
    if (!this.active) throw new Error(NO_WORKSPACE_ERROR)
    return this.active
  }

  getActiveSessionIdentity(): PiEventContext | null {
    return this.active ? entryContext(this.active) : null
  }

  getRuntimeCapabilities() {
    return this.active?.client.capabilities ?? null
  }

  getAgentStatusSnapshot(): AgentStatusSnapshot | null {
    return this.active?.status.snapshot() ?? null
  }

  getActiveApprovalIds(): ReadonlySet<string> {
    return new Set(
      [...(this.active?.outstandingUi ?? [])]
        .filter(([, method]) => method === 'confirm')
        .map(([id]) => id),
    )
  }

  getActiveUiRequestMethod(id: string): BlockingExtensionUiMethod | null {
    return this.active?.outstandingUi.get(id) ?? null
  }

  prompt(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    entry.firstMessage ??= message
    if (entry.acp) {
      this.sessions().touch(entry.acp.agentId, entry.sessionId ?? entry.job.id, {
        firstMessage: message,
        modified: new Date().toISOString(),
      })
    }
    const checkpoint = entry.status.prompt(message)
    return entry.client.send(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    const checkpoint = entry.status.prompt(message)
    // ACP 没有插话机制(不在规范里),但消息不能丢:交给连接排队,这轮完了再发。
    if (!entry.pi) return entry.client.send(message, images)
    return this.piOf(entry, '插话').steer(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    const checkpoint = entry.status.prompt(message)
    if (!entry.pi) return entry.client.send(message, images)
    return this.piOf(entry, '追问').followUp(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  abort(): Promise<void> {
    const entry = this.requireEntry()
    return entry.client.cancel('user requested abort').then(() => {
      entry.outstandingUi.clear()
    })
  }

  bash(command: string): ReturnType<RpcClient['bash']> {
    return this.requirePi('执行 bash 命令').bash(command)
  }

  respondExtensionUi(response: ExtensionUiResponse): { remainingBlockingRequests: number } {
    const entry = this.requireEntry()
    entry.client.respondExtensionUi(response)
    entry.outstandingUi.delete(response.id)
    entry.status.approvalResolved()
    return { remainingBlockingRequests: entry.outstandingUi.size }
  }

  /**
   * 还活着的外部 agent 会话,投影成会话列表项。
   *
   * 只列活着的:ACP 的会话存在 agent 那边,连接断了就恢复不了(要走 session/load,
   * 还没做)。列一条点不开的条目比不列更糟。
   */
  listAcpSessions(): SessionInfo[] {
    const cwd = this.workspacePath ?? ''
    const live = this.pool.acpEntries().map((entry) => ({
      path: acpSessionKey(entry.acp!.agentId, entry.sessionId ?? entry.job.id),
      id: entry.sessionId ?? entry.job.id,
      cwd,
      name: entry.acp!.agentName,
      firstMessage: entry.firstMessage ?? '(还没有消息)',
      messageCount: entry.firstMessage ? 1 : 0,
      modified: new Date(entry.job.activatedAt()).toISOString(),
    }))
    // 索引里也有的以活着的那份为准:进程在手上,时间和预览都更新。
    const liveKeys = new Set(live.map((info) => info.path))
    const stored = this.sessions()
      .list(cwd)
      .map(acpRecordToSessionInfo)
      .filter((info) => !liveKeys.has(info.path))
    return [...live, ...stored].sort((a, b) => b.modified.localeCompare(a.modified))
  }

  private findAcpEntry(key: string): AgentEntry | undefined {
    const parts = parseAcpSessionKey(key)
    if (!parts) return undefined
    return this.pool
      .acpEntries()
      .find(
        (entry) =>
          entry.acp?.agentId === parts.agentId &&
          (entry.sessionId ?? entry.job.id) === parts.sessionId,
      )
  }

  /**
   * 切到一个外部 agent 会话。
   *
   * 进程还在就直接换激活对象;已经断了(重启或被池子回收)就重新起一个连接,
   * 让 agent 走 session/load 把历史回放回来。
   */
  async switchAcpSession(key: string): Promise<{ cancelled: boolean; error?: string }> {
    const live = this.findAcpEntry(key)
    if (live) {
      this.activate(live)
      return { cancelled: false }
    }
    const parts = parseAcpSessionKey(key)
    if (!parts || !this.pool.launchContext()) return { cancelled: true }
    const record = this.sessions().find(parts.agentId, parts.sessionId)
    if (!record) return { cancelled: true, error: '找不到这个外部 agent 会话' }
    try {
      const agents = await this.acpRegistry.load()
      const agent = agents.find((candidate) => candidate.id === parts.agentId)
      if (!agent) throw new Error(`ACP 目录里没有 ${parts.agentId}`)
      const resolved = resolveAcpLaunchSpec(agent)
      if (!resolved.ok) throw new Error(resolved.error.message)
      const entry = await this.pool.spawnAcp(
        parts.agentId,
        record.agentName,
        resolved.spec,
        parts.sessionId,
      )
      entry.firstMessage = record.firstMessage || null
      this.activate(entry)
      return { cancelled: false }
    } catch (error) {
      appendAppLog('warn', 'acp.resume', 'Failed to resume an ACP session', {
        cwd: this.workspacePath,
        agentId: parts.agentId,
        error: normalizeError(error),
      })
      return { cancelled: true, error: `恢复失败:${(error as Error).message}` }
    }
  }

  /** 关掉一个外部 agent 会话。正在跑的一轮不给关,和 pi 会话一个口径。 */
  async closeAcpSession(key: string): Promise<{ ok: true } | { error: string }> {
    const parsed = parseAcpSessionKey(key)
    const entry = this.findAcpEntry(key)
    if (!entry) {
      // 进程已经没了,把索引里那条抹掉就是「关闭」。
      if (parsed) this.sessions().remove(parsed.agentId, parsed.sessionId)
      return { ok: true }
    }
    if (entry.job.isRunActive()) return { error: '该会话正在运行，先停止再关闭' }
    await this.pool.stopEntry(entry, 'session closed')
    const parts = parseAcpSessionKey(key)
    if (parts) this.sessions().remove(parts.agentId, parts.sessionId)
    return { ok: true }
  }

  /**
   * 新聊天 = 新进程,当前会话该跑还跑。
   *
   * 当前用的是外部 agent 的话,新聊天也用同一个 agent —— 否则「新建」会把用户
   * 悄悄踢回 pi,而他并没有要求换后端。
   */
  async newSession(): Promise<{ cancelled: boolean }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const acp = this.active?.acp
    if (acp) {
      await this.startAcpSession(acp.agentId)
      return { cancelled: false }
    }
    const entry = await this.pool.spawn(null)
    this.activate(entry)
    return { cancelled: false }
  }

  /** 切聊天 = 换看哪个进程;没有进程的会话就现起一个来接管。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const existing = this.pool.find(sessionPath)
    if (existing) {
      this.activate(existing)
      return { cancelled: false }
    }
    const entry = await this.pool.spawn(sessionPath)
    this.activate(entry)
    return { cancelled: false }
  }

  /**
   * ACP 会话没有 pi 的会话状态,但 sessionId 是知道的 —— 合成一份返回,不要抛。
   *
   * 会话侧栏是 `Promise.all([sessions.list(), pi.getState()])`,这里一抛错
   * 整个列表就加载不出来:只要当前会话是外部 agent,侧栏就废了。
   */
  private acpSessionState(entry: AgentEntry): Awaited<ReturnType<RpcClient['getState']>> {
    return {
      // 界面按 state.model 给模型菜单里那一行打勾,所以这里放 agentId
      // (菜单项的 key 就是 acp::<agentId>)。具体跑的哪个模型在 capabilities.model 里,
      // 那是 agent 自己报的。
      model: { provider: 'acp', id: entry.acp?.agentId ?? 'acp' } as never,
      thinkingLevel: 'medium',
      isStreaming: entry.job.isRunActive(),
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      sessionId: entry.sessionId ?? entry.job.id,
      autoCompactionEnabled: false,
      messageCount: 0,
      pendingMessageCount: 0,
    }
  }

  async getState(): Promise<Awaited<ReturnType<RpcClient['getState']>>> {
    const entry = this.requireEntry()
    if (!entry.pi) return this.acpSessionState(entry)
    const state = await entry.pi.getState()
    entry.sessionId = state.sessionId
    const sessionFile = this.pool.toHostSessionPath(state.sessionFile ?? null)
    entry.sessionFile = sessionFile
    this.rememberSessionDir(sessionFile)
    if (this.active === entry) this.lastSessionFile = sessionFile
    if (!state?.sessionFile) return state
    return sessionFile === state.sessionFile ? state : { ...state, sessionFile: sessionFile! }
  }

  async readActiveProjection(): Promise<{
    sessionId: string
    sessionFile: string | null
    messages: AgentMessage[]
  } | null> {
    const entry = this.requireEntry()
    if (!entry.pi) {
      // 外部 agent 的历史存在它自己那边,宿主读不到。当前这一轮由事件流驱动,
      // 所以回一份空投影而不是抛错 —— 抛错会让聊天区整个加载失败。
      if (this.active !== entry) return null
      return {
        sessionId: entry.sessionId ?? entry.job.id,
        sessionFile: null,
        messages: entry.client.conversation() ?? [],
      }
    }
    const pi = entry.pi
    const state = await pi.getState()
    const sessionFile = this.pool.toHostSessionPath(state.sessionFile ?? null)
    entry.sessionId = state.sessionId
    entry.sessionFile = sessionFile
    this.rememberSessionDir(sessionFile)
    const messages = await pi.getMessages()
    if (this.active !== entry) return null
    this.lastSessionFile = sessionFile
    return { sessionId: state.sessionId, sessionFile, messages }
  }

  getMessages(): ReturnType<RpcClient['getMessages']> {
    return this.requirePi('读取会话内容').getMessages()
  }

  /** pi 的模型 + 可用的 ACP agent。两边任意一边拉不到都不该让另一边消失。 */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const entry = this.requireEntry()
    if (entry.pi) {
      try {
        this.lastPiModels = (await entry.pi.getAvailableModels()) as ModelInfo[]
      } catch (error) {
        appendAppLog('warn', 'agent.models', 'Failed to list pi models', normalizeError(error))
      }
    }
    let acp: ModelInfo[] = []
    try {
      acp = acpModelEntries(await this.acpRegistry.load())
    } catch (error) {
      // 目录拉不到只是少一组外部 agent,不该让整个模型选择器报错。
      appendAppLog('warn', 'acp.registry', 'Failed to load the ACP agent registry', normalizeError(error))
    }
    return mergeModelEntries(this.lastPiModels, acp)
  }

  /**
   * 选中 ACP agent 不是「换个模型」,是用那个 agent 起一个新会话;反过来,从 ACP 会话
   * 选回普通模型也一样 —— 外部 agent 的对话在它自己那边,pi 接不过来,只能新起一个 pi 会话。
   * 两个方向对称:换后端 = 起一个新会话,而不是在当前会话上改模型。
   */
  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    if (isAcpModelRoute(provider)) return this.startAcpSession(modelId)
    if (this.active && !this.active.pi) return this.startPiSession(provider, modelId)
    const selected = await this.requirePi('切换模型').setModel(provider, modelId)
    saveSelectedModelRoute(provider, modelId)
    return selected
  }

  /** 从外部 agent 会话切回普通模型:起一个新的 pi 会话来接管,并把它切到目标模型。 */
  private async startPiSession(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const entry = await this.pool.spawn(null)
    this.activate(entry)
    const selected = await this.piOf(entry, '切换模型').setModel(provider, modelId)
    saveSelectedModelRoute(provider, modelId)
    return selected
  }

  private async startAcpSession(agentId: string): Promise<{ provider: string; id: string }> {
    const entry = await this.spawnAcpEntry(agentId)
    this.activate(entry)
    return { provider: ACP_MODEL_PROVIDER, id: agentId }
  }

  /** 起一个外部 agent 会话并记进会话索引,但不切到前台(任务会话就这样用)。 */
  private async spawnAcpEntry(agentId: string): Promise<AgentEntry> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const agents = await this.acpRegistry.load()
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) throw new Error(`ACP 目录里没有 ${agentId}`)
    const resolved = resolveAcpLaunchSpec(agent)
    if (!resolved.ok) throw new Error(resolved.error.message)
    const entry = await this.pool.spawnAcp(agentId, agent.name, resolved.spec)
    const nowIso = new Date().toISOString()
    this.sessions().upsert({
      agentId,
      agentName: agent.name,
      sessionId: entry.sessionId ?? entry.job.id,
      cwd: this.workspacePath ?? '',
      firstMessage: '',
      createdAt: nowIso,
      modified: nowIso,
    })
    appendAppLog('info', 'acp.session', 'Started an ACP-backed session', {
      cwd: this.workspacePath,
      agentId,
      command: resolved.spec.command,
      sessionId: entry.sessionId,
    })
    return entry
  }

  setThinkingLevel(level: Parameters<RpcClient['setThinkingLevel']>[0]): ReturnType<RpcClient['setThinkingLevel']> {
    return this.requirePi('调整推理深度').setThinkingLevel(level)
  }

  setSteeringMode(mode: Parameters<RpcClient['setSteeringMode']>[0]): ReturnType<RpcClient['setSteeringMode']> {
    return this.requirePi('设置插话模式').setSteeringMode(mode)
  }

  setFollowUpMode(mode: Parameters<RpcClient['setFollowUpMode']>[0]): ReturnType<RpcClient['setFollowUpMode']> {
    return this.requirePi('设置追问模式').setFollowUpMode(mode)
  }

  /**
   * 切换外部 agent 的权限模式。
   *
   * 这是 ACP 会话上唯一能调的权限旋钮 —— 宿主的沙箱管不住外部 agent,
   * 只能让它自己少放行或多放行。pi 会话没有档位可切,靠沙箱。
   */
  async setPermissionMode(modeId: string): Promise<void> {
    const entry = this.requireEntry()
    const set = entry.client.setPermissionMode
    if (!set) throw unsupportedByBackend(entry, '切换权限模式')
    await set.call(entry.client, modeId)
  }

  setAutoCompaction(enabled: boolean): ReturnType<RpcClient['setAutoCompaction']> {
    return this.requirePi('设置自动压缩').setAutoCompaction(enabled)
  }

  compact(): ReturnType<RpcClient['compact']> {
    return this.requirePi('压缩上下文').compact()
  }

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.requirePi('列出命令').getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.requirePi('重命名会话').setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()
