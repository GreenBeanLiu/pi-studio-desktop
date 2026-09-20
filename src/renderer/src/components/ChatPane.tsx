import { memo, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { Spin, Popover, Segmented, Switch, Button, App as AntApp, Modal, Tabs, Empty, Input } from 'antd'
import { Markdown } from '@lobehub/ui'
import {
  SendHorizontal,
  ArrowDown,
  Square,
  FolderOpen,
  X,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Check,
  Loader2,
  SlashSquare,
  Puzzle,
  FileText,
  Download,
  GitCompare,
  ExternalLink,
  RotateCcw,
  ShieldCheck,
  ShieldAlert,
  Activity,
  Wrench,
  Copy,
  Search,
} from 'lucide-react'
import {
  api,
  type Workspace,
  type AgentMessage,
  type ImageContent,
  type ModelInfo,
  type SlashCommand,
  type ThinkingLevel,
  type QueueMode,
  type PiRuntimeEvent,
  type SessionExportFormat,
  type AgentRunStatusSnapshot,
  type PiRuntimeCapabilities,
  type ToolCall,
} from '../lib/api'
import { diagnosticFileName, sanitizeForDiagnostics } from '../lib/diagnostics-export'
import ToolCallCard, { type ToolExecutionState } from './ToolCallCard'
import { type ModelRoute } from '../../../shared/model-route'
import { buildModelChip, buildModelMenuGroups } from './model-menu'
import { acpModeLabel, describeAcpModes } from '../../../shared/acp-modes'
import { DEFAULT_THINKING_LEVEL } from '../../../shared/agent-defaults'
import { runStatusColor, useStyles, type CxType, type StylesType } from './ChatPane.styles'
import {
  type AgentIssue,
  type ApprovalDecision,
  type ApprovalStatus,
  type MemorySuggestion,
  type RunRecord,
  type RunStatus,
  type ToolApprovalRequest,
} from './chat-types'
import {
  agentIssueMessage,
  approvalStatusLabel,
  firstLine,
  formatAgentElapsed,
  formatClock,
  formatDuration,
  gitStatusLabel,
  runStatusLabel,
  shortId,
  summarizeToolArgs,
  textOf,
} from './chat-format'
import { approvalFromProjection, planProjectionApply, toolsFromProjection } from './chat-projection'
import {
  appendTimelineEvent,
  completeRun,
  endTool,
  failRun,
  resolveRunStatus,
  startRun,
  startTool,
  updateToolResult,
} from './chat-run-records'
import { applyStreamingMessage, assistantErrorOf, beginStreamingMessage } from './chat-stream'
import { useGitDiff, type GitDiffDeps } from './use-git-diff'
import { buildMemorySuggestion } from './chat-memory-note'

type Props = {
  workspace: Workspace | null
  /** Agent subprocess is still booting for this workspace */
  starting?: boolean
  /** Non-recovering agent process failure reported by the main process */
  agentIssue?: AgentIssue | null
  restarting?: boolean
  onRestartAgent?: () => void
  onDiagnosticsExporterChange?: (exporter: (() => void) | null) => void
}

export default function ChatPane({
  workspace,
  starting = false,
  agentIssue = null,
  restarting = false,
  onRestartAgent,
  onDiagnosticsExporterChange,
}: Props) {
  const { styles, cx, theme: token } = useStyles()
  // 静态 message/Modal 消费不到 ThemeProvider 的 context(切主题时不跟着变),
  // 走 App provider 拿实例 —— provider 在 main.tsx 的 <AntApp> 上。
  const { message, modal } = AntApp.useApp()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolExecutions, setToolExecutions] = useState<Record<string, ToolExecutionState>>({})
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<PiRuntimeCapabilities | null>(null)
  const [agentStatus, setAgentStatus] = useState<AgentRunStatusSnapshot | null>(null)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<{ provider: string; id: string } | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [steeringMode, setSteeringMode] = useState<QueueMode>('all')
  const [followUpMode, setFollowUpMode] = useState<QueueMode>('all')
  const [autoCompaction, setAutoCompaction] = useState(true)
  const [compacting, setCompacting] = useState(false)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [favoriteModels, setFavoriteModels] = useState<ModelRoute[]>([])
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({})
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  /**
   * useGitDiff 只认注入进来的环境(见 use-git-diff.ts)。这里把它接到真的 IPC 和 antd 上。
   * useApp() 给的 message/modal 引用是稳定的,所以这个 memo 实际只算一次 ——
   * hook 里的 useCallback 不会每次渲染都失效。
   */
  const gitDiffDeps = useMemo<GitDiffDeps>(
    () => ({
      git: api.git,
      notifyError: (text) => message.error(text),
      notifySuccess: (text) => message.success(text),
      confirmDiscard: (onOk) => {
        modal.confirm({
          title: '撤销本次 Agent 运行变更？',
          content: '只会恢复到本次运行开始时的工作区快照；运行前已有的未提交修改和文件会保留。',
          okText: '撤销本次变更',
          cancelText: '取消',
          okButtonProps: { danger: true },
          onOk,
        })
      },
    }),
    [message, modal],
  )
  const gitDiff = useGitDiff(workspace, gitDiffDeps)
  // 事件订阅那个 effect 的依赖是 [],只能捕获引用稳定的东西。showSnapshot 是
  // useCallback([]),满足条件;gitDiff 对象本身每次渲染都是新的,别整个捕。
  const { showSnapshot: showDiffSnapshot } = gitDiff
  const [sessionExportLoading, setSessionExportLoading] = useState<SessionExportFormat | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySaving, setMemorySaving] = useState(false)
  const [memoryPath, setMemoryPath] = useState('')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memorySuggestionOpen, setMemorySuggestionOpen] = useState(false)
  const [memorySuggestionSaving, setMemorySuggestionSaving] = useState(false)
  const [memorySuggestion, setMemorySuggestion] = useState<MemorySuggestion | null>(null)
  const [memorySuggestionDraft, setMemorySuggestionDraft] = useState('')
  const [runTimelineOpen, setRunTimelineOpen] = useState(false)
  const [runRecords, setRunRecords] = useState<RunRecord[]>([])
  const [approvalRequests, setApprovalRequests] = useState<ToolApprovalRequest[]>([])
  // Follow the stream only while the user is at the bottom; scrolling up
  // pauses following so reading history isn't fought by auto-scroll.
  const [autoFollow, setAutoFollow] = useState(true)
  /** 模型与参数弹层受控:选中模型后要能立刻收起,不然看着像没选上。 */
  const [paramsOpen, setParamsOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // pi 的自动重试(默认 3 次、2/4/8s 退避)期间进程只是在 sleep,不显示出来
  // 用户看到的就是"卡住了"。
  const [retryNotice, setRetryNotice] = useState<{
    attempt: number
    maxAttempts: number
    message: string
  } | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Index of the message currently being streamed (set by message_start),
  // so update/end events replace the right slot even if other messages
  // (e.g. tool results) land in between.
  const streamingIndexRef = useRef<number | null>(null)
  // 最后一次真正应用过的 projection messagesRevision;null = 还没应用过任何一份
  const appliedMessagesRevisionRef = useRef<number | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  /** 本轮最后一条 assistant 消息的报错(stopReason === 'error'),正常结束时为 null。 */
  const lastAssistantErrorRef = useRef<string | null>(null)
  const messagesStateRef = useRef(messages)
  const runRecordsRef = useRef(runRecords)
  messagesStateRef.current = messages
  runRecordsRef.current = runRecords

  // 更大的会话在快照里只带尾部(见 olderMessagesOffset/getMessagesPage):把更早的消息取回一次,
  // 拼在前面,整段会话仍然可见(plan T2.4)。
  const olderPrefixRef = useRef<AgentMessage[]>([])
  const applyProjectionMessages = useCallback(async (list: AgentMessage[], offset: number) => {
    if (offset > 0 && olderPrefixRef.current.length < offset) {
      try {
        olderPrefixRef.current = await api.pi.getMessagesPage(0, offset)
      } catch {
        // 拿不到更早的就只显示尾部窗口
      }
    }
    setMessages([...olderPrefixRef.current, ...list])
  }, [])

  const refreshModelSwitcherState = useCallback(async (): Promise<void> => {
    const [settingsResult, labelsResult] = await Promise.allSettled([
      api.settings.load(),
      api.modelCatalog.loadProviderLabels(),
    ])
    if (settingsResult.status === 'fulfilled') {
      setFavoriteModels(settingsResult.value.favoriteModelRoutes ?? [])
    }
    if (labelsResult.status === 'fulfilled' && !('error' in labelsResult.value)) {
      setProviderLabels(labelsResult.value.view.providerLabels)
    }
  }, [])

  /**
   * 后端相关的状态一起刷。
   *
   * 「当前模型」和「后端能力」是同一件事的两个面 —— 之前它俩由不同路径更新:
   * 挂载时取 capabilities,而 pickModel 直接把 setModel 的返回值塞进 currentModel。
   * 于是在下拉里选一个外部 agent(那会换掉整个后端、但组件不重挂载)之后,
   * chip 上有 agent 名却没有模型名。分开刷就迟早会不一致。
   */
  const refreshBackendState = useCallback(async (): Promise<void> => {
    const [caps, state] = await Promise.allSettled([api.pi.getCapabilities(), api.pi.getState()])
    setRuntimeCapabilities(caps.status === 'fulfilled' ? caps.value : null)
    if (state.status !== 'fulfilled' || !state.value) return
    const s = state.value
    setCurrentModel(s.model ? { provider: s.model.provider, id: s.model.id } : null)
    if (s.thinkingLevel) setThinking(s.thinkingLevel as ThinkingLevel)
    if (s.steeringMode) setSteeringMode(s.steeringMode)
    if (s.followUpMode) setFollowUpMode(s.followUpMode)
    if (typeof s.autoCompactionEnabled === 'boolean') setAutoCompaction(s.autoCompactionEnabled)
    // 组件重挂载(切视图/切会话)时从 agent 恢复真实运行状态,
    // 否则 agent 还在跑但停止按钮消失、新输入被误当成新提问直发。
    if (typeof s.isStreaming === 'boolean') setSending(s.isStreaming)
  }, [])

  useEffect(() => {
    if (!agentIssue) return
    setSending(false)
    const runId = activeRunIdRef.current
    activeRunIdRef.current = null
    if (!runId) return

    const timestamp = new Date().toISOString()
    setRunRecords((prev) =>
      prev.map((run) =>
        run.id === runId
          ? {
              ...run,
              status: 'error',
              endedAt: timestamp,
              timeline: [
                ...run.timeline,
                {
                  id: `${runId}:agent-disconnect:${shortId()}`,
                  type: 'event',
                  label: 'Agent 已断开',
                  detail: agentIssueMessage(agentIssue),
                  timestamp,
                  status: 'error',
                },
              ],
            }
          : run,
      ),
    )
  }, [agentIssue])

  useEffect(() => {
    // Switching workspaces kills the old agent subprocess, so its agent_end
    // never arrives — reset streaming state here or the input stays disabled.
    setSending(false)
    setError(null)
    setRetryNotice(null)
    streamingIndexRef.current = null
    appliedMessagesRevisionRef.current = null
    olderPrefixRef.current = []
    if (!workspace || starting) {
      setMessages([])
      setToolExecutions({})
      setRuntimeCapabilities(null)
      setAgentStatus(null)
      setRunRecords([])
      setApprovalRequests([])
      setMemorySuggestion(null)
      setMemorySuggestionDraft('')
      activeRunIdRef.current = null
      return
    }
    api.pi
      .getSessionProjection()
      .then((projection) => {
        appliedMessagesRevisionRef.current = projection.messagesRevision
        void applyProjectionMessages(projection.messages, projection.olderMessagesOffset ?? 0)
        setToolExecutions(toolsFromProjection(projection.tools))
        setApprovalRequests(projection.approvals.map(approvalFromProjection))
      })
      .catch(() => {})
    api.pi.getAgentStatusSnapshot().then(setAgentStatus).catch(() => setAgentStatus(null))
    api.pi.getAvailableModels().then(setModels).catch(() => {})
    api.pi.getCommands().then(setCommands).catch(() => {})
    void refreshModelSwitcherState()
    void refreshBackendState()
  }, [workspace?.path, refreshModelSwitcherState, refreshBackendState, applyProjectionMessages])

  useEffect(() => {
    return api.pi.onAgentStatusSnapshot(setAgentStatus)
  }, [])

  useEffect(() => {
    return api.pi.onSessionProjection((projection) => {
      // 该改什么由 planProjectionApply 决定(纯函数,见 chat-projection.ts);
      // 这里只负责把计划落到 state 上。
      const plan = planProjectionApply(projection, {
        workspacePath: workspace?.path,
        appliedMessagesRevision: appliedMessagesRevisionRef.current,
      })
      if (plan.kind === 'ignore') return
      if (plan.messages) {
        appliedMessagesRevisionRef.current = plan.messages.revision
        streamingIndexRef.current = null
        void applyProjectionMessages(plan.messages.list, projection.olderMessagesOffset ?? 0)
      }
      setToolExecutions(plan.tools)
      setApprovalRequests(plan.approvals)
    })
  }, [workspace?.path, applyProjectionMessages])

  // 主进程拥有收藏模型补录策略；渲染层只触发幂等协调并刷新展示数据。
  const syncedCustomModelsRef = useRef(false)
  useEffect(() => {
    syncedCustomModelsRef.current = false
  }, [workspace?.path])

  // 设置页保存后即时同步(无需重开工作区):重载模型切换列表 + 可用模型清单,
  // 并让上面的自定义模型注册重新评估(新增的第三方 id 立刻可选)。
  useEffect(() => {
    const off = api.settings.onChanged(() => {
      void refreshModelSwitcherState()
      syncedCustomModelsRef.current = false
      api.pi.getAvailableModels().then(setModels).catch(() => {})
    })
    return off
  }, [refreshModelSwitcherState])

  // For the completion notification — the event subscription effect runs once,
  // so it reads the current workspace through a ref.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [modelQuery, setModelQuery] = useState('')
  /** 「更多」那一栏默认收起:插话/排队/自动压缩不是每次对话都要动的。 */
  const [paramsMoreOpen, setParamsMoreOpen] = useState(false)
  /** 正在切模型。选外部 agent 会起进程,不能让连点变成开一堆。 */
  const switchingModelRef = useRef(false)
  /** 正在切到哪个 key —— 驱动那一行显示「切换中…」。外部 agent 首次要下包,可能十几秒。 */
  const [switchingModelKey, setSwitchingModelKey] = useState<string | null>(null)
  const currentModelRef = useRef(currentModel)
  currentModelRef.current = currentModel
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking

  useEffect(() => {
    /** 往指定运行记录里补一条时间线事件;没有目标 run 时静默跳过。 */
    const appendRunEventTo = (
      runId: string | null,
      label: string,
      detail: string | undefined,
      status: RunStatus,
    ): void => {
      if (!runId) return
      const timestamp = new Date().toISOString()
      setRunRecords((prev) =>
        appendTimelineEvent(prev, runId, {
          id: `${runId}:${label}:${shortId()}`,
          type: 'event',
          label,
          detail,
          timestamp,
          status,
        }),
      )
    }

    const appendRunEvent = (label: string, detail: string | undefined, status: RunStatus): void =>
      appendRunEventTo(activeRunIdRef.current, label, detail, status)

    /**
     * 异常收尾:把这一轮标成失败并解锁输入框(正常路径走 agent_end)。
     * 最终失败的 auto_retry_end 排在 agent_end 之后,那时 activeRunIdRef 已经清空,
     * 所以回退到最新一条记录,失败原因才不会丢。
     */
    const failActiveRun = (label: string, detail: string | undefined): void => {
      const runId = activeRunIdRef.current ?? runRecordsRef.current[0]?.id ?? null
      appendRunEventTo(runId, label, detail, 'error')
      if (runId) {
        const timestamp = new Date().toISOString()
        setRunRecords((prev) => failRun(prev, runId, timestamp))
      }
      activeRunIdRef.current = null
      setRetryNotice(null)
      setSending(false)
    }

    const off = api.pi.onEvent((event: PiRuntimeEvent) => {
      if (event.type === 'extension_ui_request') {
        const runId = activeRunIdRef.current
        const timestamp = new Date().toISOString()
        if (runId) {
          setRunRecords((prev) =>
            appendTimelineEvent(prev, runId, {
              id: `${timestamp}:ui:${shortId()}`,
              type: 'event',
              label:
                event.method === 'confirm'
                  ? '等待工具审批'
                  : event.method === 'notify'
                    ? '扩展通知'
                    : '扩展请求',
              detail: 'message' in event ? String(event.message) : event.method,
              timestamp,
              status: event.method === 'confirm' ? 'running' : undefined,
            }),
          )
        }
        if (event.method === 'notify') {
          const notify = event.notifyType === 'error' ? message.error : event.notifyType === 'warning' ? message.warning : message.info
          notify(event.message)
        } else if (event.method === 'input' || event.method === 'select' || event.method === 'editor') {
          api.pi
            .extensionUiResponse({
              type: 'extension_ui_response',
              id: event.id,
              cancelled: true,
            })
            .catch(() => {})
        }
        return
      }

      switch (event.type) {
        case 'agent_start':
          // 重试和压缩后的续跑都会再发一次 agent_start。上一轮还挂着就说明是同一个
          // 提问的延续,记进同一条运行记录,而不是凭空多出几条"运行中"。
          if (activeRunIdRef.current) {
            appendRunEvent('继续本轮', undefined, 'running')
            setSending(true)
            break
          }
          {
            const timestamp = new Date().toISOString()
            const id = `${timestamp}:run:${shortId()}`
            const model = currentModelRef.current
            activeRunIdRef.current = id
            lastAssistantErrorRef.current = null
            setRunRecords((prev) =>
              startRun(prev, {
                id,
                workspaceName: workspaceRef.current?.name,
                workspacePath: workspaceRef.current?.path,
                startedAt: timestamp,
                status: 'running',
                model: model?.id,
                provider: model?.provider,
                thinking: thinkingRef.current,
                tools: [],
                timeline: [
                  {
                    id: `${id}:start`,
                    type: 'event',
                    label: 'Agent 开始',
                    detail: workspaceRef.current?.name,
                    timestamp,
                    status: 'running',
                  },
                ],
              }),
            )
          }
          setSending(true)
          break
        case 'agent_end':
          // 自动重试会先发一轮 agent_end(willRetry=true)再退避重发 —— 这不是真结束。
          // 照常收尾会误报"任务完成"、提前弹 diff 审阅,还会把运行记录标成 done。
          if (event.willRetry) {
            appendRunEvent('本轮出错，等待自动重试', undefined, 'running')
            break
          }
          // 重试用尽(或没开重试)的失败也走 agent_end,只有最后一条 assistant 消息
          // 带着 stopReason: 'error'。不分流的话它会被当成完成:弹"任务完成"通知、
          // 弹 diff 审阅、运行记录标 done —— 用户唯一看得到的线索就是"没有回复"。
          if (lastAssistantErrorRef.current) {
            const failure = lastAssistantErrorRef.current
            lastAssistantErrorRef.current = null
            setError(`模型调用失败：${failure}`)
            failActiveRun('模型调用失败', failure)
            break
          }
          let completedRunId: string | null = null
          let completedRunForMemory: RunRecord | undefined
          {
            const runId = activeRunIdRef.current
            const timestamp = new Date().toISOString()
            if (runId) {
              completedRunId = runId
              const currentRun = runRecordsRef.current.find((run) => run.id === runId)
              if (currentRun) {
                completedRunForMemory = {
                  ...currentRun,
                  endedAt: timestamp,
                  status: resolveRunStatus(currentRun),
                }
              }
              setRunRecords((prev) => completeRun(prev, runId, timestamp))
            }
            activeRunIdRef.current = null
          }
          setSending(false)
          // 完整 toolResult 由 main 在 agent_settled 后从持久 session 重建 projection；
          // projection 广播会替换实时消息，补齐 subagent details 等持久字段。
          api.git
            .diff()
            .then((result) => {
              const snapshot = 'ok' in result ? result.snapshot : null
              if ('ok' in result && result.snapshot.status.trim()) {
                // showSnapshot 是 useCallback([]),引用稳定,可以安全地被这个 [] deps 的 effect 捕获
                showDiffSnapshot(result.snapshot)
                message.info('Agent 修改了工作区，请检查后接受或回滚')
                if (completedRunId) {
                  const timestamp = new Date().toISOString()
                  setRunRecords((prev) =>
                    appendTimelineEvent(prev, completedRunId, {
                      id: `${completedRunId}:git:${shortId()}`,
                      type: 'event',
                      label: '检测到 Git 变更',
                      detail: `${result.snapshot.files.length} 个文件变更`,
                      timestamp,
                      status: 'done',
                    }),
                  )
                }
              }
              const suggestion = buildMemorySuggestion(
                workspaceRef.current,
                messagesStateRef.current,
                completedRunForMemory,
                snapshot,
              )
              if (suggestion) {
                setMemorySuggestion(suggestion)
                setMemorySuggestionDraft(suggestion.content)
                message.info('已生成 Workspace Memory 建议，可在“记忆建议”中确认')
              }
            })
            .catch(() => {
              const suggestion = buildMemorySuggestion(
                workspaceRef.current,
                messagesStateRef.current,
                completedRunForMemory,
                null,
              )
              if (suggestion) {
                setMemorySuggestion(suggestion)
                setMemorySuggestionDraft(suggestion.content)
                message.info('已生成 Workspace Memory 建议，可在“记忆建议”中确认')
              }
            })
          if (!document.hasFocus()) {
            api.win.flash()
            try {
              new Notification('任务完成', {
                body: workspaceRef.current ? `${workspaceRef.current.name} 的 agent 已完成` : 'agent 已完成',
                silent: false,
              })
            } catch {
              // Notification unavailable — taskbar flash already covers it
            }
          }
          break
        case 'auto_retry_start':
          // agent_end 已经把 sending 关掉了,重试期间要重新亮起来。
          setSending(true)
          setRetryNotice({
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            message: event.errorMessage,
          })
          appendRunEvent(
            `自动重试 ${event.attempt}/${event.maxAttempts}`,
            event.errorMessage,
            'running',
          )
          break
        case 'auto_retry_end':
          setRetryNotice(null)
          if (event.success) {
            appendRunEvent(`重试成功（第 ${event.attempt} 次）`, undefined, 'done')
            break
          }
          setError(`模型调用失败，重试 ${event.attempt} 次后放弃：${event.finalError ?? '未知错误'}`)
          failActiveRun(`重试 ${event.attempt} 次后失败`, event.finalError)
          break
        case 'run_failed':
          // 补丁事件:pi 在 prompt 预检之后抛的异常,原本会被 rpc 模式整个吞掉。
          setError(`本轮运行异常结束：${event.message}`)
          failActiveRun('运行异常结束', event.message)
          break
        case 'agent_settled':
          // 兜底。settled 在每轮 finally 里必发,而 agent_end 在异常路径上不会到 ——
          // 走到这里还挂着 run,就说明这轮没有正常结束过。
          if (activeRunIdRef.current) {
            setError('本轮运行意外结束（agent 没有发出结束事件），可重发最后一条消息继续。')
            failActiveRun('运行意外结束', undefined)
          }
          break
        case 'message_start':
          setMessages((prev) => {
            const next = beginStreamingMessage(prev, event.message)
            streamingIndexRef.current = next.streamingIndex
            return next.messages
          })
          break
        case 'message_update':
        case 'message_end':
          if (event.type === 'message_end') {
            // undefined = 不是 assistant 消息,保留已记下的失败(见 assistantErrorOf)
            const failure = assistantErrorOf(event.message)
            if (failure !== undefined) lastAssistantErrorRef.current = failure
          }
          setMessages((prev) => {
            const next = applyStreamingMessage(prev, streamingIndexRef.current, event.message)
            streamingIndexRef.current = next.streamingIndex
            return next.messages
          })
          break
        case 'tool_execution_start':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              const timestamp = new Date().toISOString()
              const detail = summarizeToolArgs(event.args)
              setRunRecords((prev) =>
                appendTimelineEvent(startTool(prev, runId, event, timestamp), runId, {
                  id: `${timestamp}:tool-start:${event.toolCallId}`,
                  type: 'tool',
                  label: `开始 ${event.toolName}`,
                  detail,
                  timestamp,
                  status: 'running',
                }),
              )
            }
          }
          break
        case 'tool_execution_update':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              setRunRecords((prev) =>
                updateToolResult(prev, runId, event.toolCallId, event.partialResult),
              )
            }
          }
          break
        case 'tool_execution_end':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              const timestamp = new Date().toISOString()
              setRunRecords((prev) =>
                appendTimelineEvent(endTool(prev, runId, event, timestamp), runId, {
                  id: `${timestamp}:tool-end:${event.toolCallId}`,
                  type: 'tool',
                  label: `${event.isError ? '失败' : '完成'} ${event.toolName}`,
                  timestamp,
                  status: event.isError ? 'error' : 'done',
                }),
              )
            }
          }
          break
        default:
          break
      }
    })
    return off
  }, [])

  useEffect(() => {
    // Scroll the messages container directly — scrollIntoView also scrolls
    // every scrollable ANCESTOR (overflow:hidden ones included), which
    // shoved the whole app shell up: title bar and input box vanished.
    const el = messagesRef.current
    if (el && autoFollow) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, autoFollow])

  const [statusNow, setStatusNow] = useState(() => Date.now())

  useEffect(() => {
    if (!agentStatus || (agentStatus.phase !== 'running' && agentStatus.phase !== 'awaiting_approval') || !agentStatus.startedAt) {
      return
    }
    setStatusNow(Date.now())
    const timer = setInterval(() => setStatusNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [agentStatus?.phase, agentStatus?.startedAt])

  // Elapsed-time ticker for the run status strip
  useEffect(() => {
    if (!sending) return
    setElapsed(0)
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(timer)
  }, [sending])

  const runningTool = useMemo(() => {
    const running = Object.values(toolExecutions).filter((t) => t.status === 'running')
    return running.length > 0 ? running[running.length - 1].toolName : null
  }, [toolExecutions])

  const latestRun = runRecords[0]
  const latestRunErrors = latestRun?.tools.filter((tool) => tool.status === 'error').length ?? 0
  const pendingApprovals = approvalRequests.filter((item) => item.status === 'pending')

  const appendApprovalTimeline = useCallback(
    (approval: ToolApprovalRequest, label: string, status: RunStatus) => {
      if (!approval.runId) return
      const timestamp = new Date().toISOString()
      setRunRecords((prev) =>
        prev.map((run) =>
          run.id === approval.runId
            ? {
                ...run,
                timeline: [
                  ...run.timeline,
                  {
                    id: `${timestamp}:approval:${approval.id}:${shortId()}`,
                    type: 'event',
                    label,
                    detail: approval.command ?? firstLine(approval.message),
                    timestamp,
                    status,
                  },
                ],
              }
            : run,
        ),
      )
    },
    [],
  )

  const decideApproval = useCallback(
    async (approval: ToolApprovalRequest, decision: ApprovalDecision) => {
      if (approval.status !== 'pending') return

      try {
        const confirmed = decision === 'allow-once'
        await api.pi.extensionUiResponse({
          type: 'extension_ui_response',
          id: approval.id,
          confirmed,
        })

        const nextStatus: ApprovalStatus = confirmed ? 'allowed' : 'denied'
        appendApprovalTimeline(
          { ...approval, runId: activeRunIdRef.current ?? approval.runId },
          approvalStatusLabel(nextStatus),
          confirmed ? 'done' : 'aborted',
        )
      } catch (err) {
        const failure = (err as Error).message ?? '审批处理失败'
        message.error(failure)
      }
    },
    [appendApprovalTimeline],
  )

  const copyRunTimeline = useCallback(async () => {
    if (runRecords.length === 0) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(runRecords, null, 2))
      message.success('运行记录 JSON 已复制')
    } catch (err) {
      message.error((err as Error).message ?? '复制运行记录失败')
    }
  }, [runRecords])

  const abortCurrentRun = useCallback(async () => {
    const runId = activeRunIdRef.current
    if (runId) {
      const timestamp = new Date().toISOString()
      setRunRecords((prev) =>
        prev.map((run) =>
          run.id === runId
            ? {
                ...run,
                status: 'aborted',
                timeline: [
                  ...run.timeline,
                  {
                    id: `${runId}:abort:${shortId()}`,
                    type: 'event',
                    label: '用户停止',
                    timestamp,
                    status: 'aborted',
                  },
                ],
              }
            : run,
        ),
      )
    }
    await api.pi.abort()
  }, [])

  const exportDiagnostics = useCallback(async () => {
    if (!workspace) return

    try {
      const [state, runtimeSnapshot, appVersion, settings, logs] = await Promise.all([
        api.pi.getState().catch(() => null),
        api.pi.getRuntimeSnapshot().catch(() => null),
        api.app.version().catch(() => 'unknown'),
        api.settings.load().catch(() => null),
        api.diagnostics.getLogs().catch((err) => ({
          error: (err as Error).message ?? 'Failed to read app logs',
        })),
      ])
      const diagnostic = {
        exportedAt: new Date().toISOString(),
        app: {
          version: appVersion,
        },
        workspace: {
          name: workspace.name,
          path: workspace.path,
        },
        settings: settings
          ? {
              selectedModelRoute: settings.selectedModelRoute,
              modelAccessConfigured: settings.modelAccessConfigured,
              tavilyConfigured: !!settings.tavilyApiKey,
              subagentsEnabled: settings.subagentsEnabled,
            }
          : null,
        session: sanitizeForDiagnostics(state),
        runtime: {
          authority: sanitizeForDiagnostics(runtimeSnapshot),
          sending,
          compacting,
          thinking,
          steeringMode,
          followUpMode,
          autoCompaction,
          currentModel,
          commandCount: commands.length,
          commands,
          messageCount: messages.length,
          toolExecutionCount: Object.keys(toolExecutions).length,
          runningTool,
          runRecordCount: runRecords.length,
          pendingApprovalCount: pendingApprovals.length,
          agentIssue: sanitizeForDiagnostics(agentIssue),
        },
        logs,
        toolExecutions: sanitizeForDiagnostics(toolExecutions),
        approvalRequests: sanitizeForDiagnostics(approvalRequests),
        runRecords: sanitizeForDiagnostics(runRecords),
        messages: sanitizeForDiagnostics(messages.slice(-80)),
      }

      const result = await api.diagnostics.save({
        defaultPath: diagnosticFileName(workspace.name),
        content: JSON.stringify(diagnostic, null, 2),
      })

      if ('error' in result) {
        message.error(result.error)
      } else if ('ok' in result) {
        message.success('诊断包已导出')
      }
    } catch (err) {
      message.error((err as Error).message ?? '导出诊断包失败')
    }
  }, [
    workspace,
    sending,
    compacting,
    agentIssue,
    thinking,
    steeringMode,
    followUpMode,
    autoCompaction,
    currentModel,
    commands,
    messages,
    toolExecutions,
    runningTool,
    runRecords,
    approvalRequests,
    pendingApprovals.length,
  ])

  useEffect(() => {
    onDiagnosticsExporterChange?.(workspace ? exportDiagnostics : null)
    return () => onDiagnosticsExporterChange?.(null)
  }, [workspace, exportDiagnostics, onDiagnosticsExporterChange])

  const exportCurrentSession = useCallback(
    async (format: SessionExportFormat) => {
      if (!workspace || sessionExportLoading) return
      setSessionExportLoading(format)
      try {
        const result = await api.sessions.exportCurrent(format)
        if ('error' in result) {
          message.error(result.error)
        } else if ('ok' in result) {
          message.success(format === 'json' ? '会话 JSON 已导出' : '会话 Markdown 已导出')
        }
      } catch (err) {
        message.error((err as Error).message ?? '导出会话失败')
      } finally {
        setSessionExportLoading(null)
      }
    },
    [workspace, sessionExportLoading],
  )

  const openWorkspaceMemory = useCallback(async () => {
    if (!workspace || memoryLoading) return
    setMemoryOpen(true)
    setMemoryLoading(true)
    try {
      const result = await api.memory.load()
      if ('error' in result) {
        message.error(result.error)
        setMemoryOpen(false)
        return
      }
      setMemoryPath(result.memory.path)
      setMemoryDraft(result.memory.content)
    } catch (err) {
      message.error((err as Error).message ?? '读取 Workspace Memory 失败')
      setMemoryOpen(false)
    } finally {
      setMemoryLoading(false)
    }
  }, [workspace, memoryLoading])

  const saveWorkspaceMemory = useCallback(async () => {
    if (!workspace || memorySaving) return
    setMemorySaving(true)
    try {
      const result = await api.memory.save(memoryDraft)
      if ('error' in result) {
        message.error(result.error)
        return
      }
      setMemoryPath(result.memory.path)
      setMemoryDraft(result.memory.content)
      setMemoryOpen(false)
      message.success('Workspace Memory 已保存，下一轮任务生效')
    } catch (err) {
      message.error((err as Error).message ?? '保存 Workspace Memory 失败')
    } finally {
      setMemorySaving(false)
    }
  }, [workspace, memorySaving, memoryDraft])

  const applyMemorySuggestion = useCallback(async () => {
    if (!workspace || !memorySuggestionDraft.trim() || memorySuggestionSaving) return
    setMemorySuggestionSaving(true)
    try {
      const loaded = await api.memory.load()
      if ('error' in loaded) {
        message.error(loaded.error)
        return
      }

      const current = loaded.memory.content.trimEnd()
      const nextContent = `${current}\n\n${memorySuggestionDraft.trim()}\n`
      const saved = await api.memory.save(nextContent)
      if ('error' in saved) {
        message.error(saved.error)
        return
      }

      setMemoryPath(saved.memory.path)
      setMemoryDraft(saved.memory.content)
      setMemorySuggestion(null)
      setMemorySuggestionDraft('')
      setMemorySuggestionOpen(false)
      message.success('记忆建议已写入 Workspace Memory，下一轮任务生效')
    } catch (err) {
      message.error((err as Error).message ?? '保存记忆建议失败')
    } finally {
      setMemorySuggestionSaving(false)
    }
  }, [workspace, memorySuggestionDraft, memorySuggestionSaving])

  // While the agent runs, Enter queues a follow-up and Ctrl+Enter steers
  // (interrupts); when idle both are a plain prompt.
  const sendMessage = useCallback(
    async (mode: 'queue' | 'steer' = 'queue') => {
      const text = input.trim()
      if ((!text && images.length === 0) || !workspace || starting || agentIssue) return
      if (images.length > 0 && runtimeCapabilities?.features.images === false) {
        setError('当前 Pi Runtime 不支持图片输入')
        return
      }
      const imgs = images.length > 0 ? images : undefined
      setInput('')
      setImages([])
      setError(null)
      try {
        if (!sending) {
          setSending(true)
          await api.pi.prompt(text, imgs)
        } else if (mode === 'steer') {
          await api.pi.steer(text, imgs)
        } else {
          await api.pi.followUp(text, imgs)
        }
      } catch (err) {
        const failure = (err as Error).message ?? '发送失败'
        setError(failure)
        if (!sending) {
          setSending(false)
          setInput(text)
          setImages(imgs ?? [])
          if (failure.includes('must be accepted or reverted')) {
            void gitDiff.openDiff()
          }
        }
      }
    },
    [input, images, sending, workspace, starting, agentIssue, runtimeCapabilities, gitDiff.openDiff],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 输入法组字期间不拦任何键:此时 Enter 是"确认候选词"、方向键是"翻候选",
    // 都不该触发发送或驱动 slash 面板。否则中文输入按回车选词会把半截消息发出去。
    if (e.nativeEvent.isComposing) return

    // Slash palette captures navigation keys while open
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectSlash(slashMatches[Math.min(slashIndex, slashMatches.length - 1)])
        return
      }
    }
    if (slashFilter !== null && e.key === 'Escape') {
      setSlashDismissed(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(e.ctrlKey || e.metaKey ? 'steer' : 'queue')
    }
  }

  // ── Slash command palette ────────────────────────────────────────
  // Visible while the first token is being typed (`/…` with no space yet).
  const slashFilter =
    workspace && /^\/\S*$/.test(input) && !slashDismissed ? input.slice(1).toLowerCase() : null
  // 流式期间每个 token 一次 setMessages。原来这一行内联在 JSX 里,每个 token 都把整个
  // 会话重新分段一遍;MessageBubble 有 memo 挡着,但分段本身和下面的 ToolStepsGroup 挡不住。
  const renderSegments = useMemo(() => segmentMessages(messages), [messages])

  const slashMatches = useMemo(() => {
    if (slashFilter === null || commands.length === 0) return []
    return commands
      .filter(
        (c) =>
          c.name.toLowerCase().includes(slashFilter) ||
          (c.description ?? '').toLowerCase().includes(slashFilter),
      )
      .slice(0, 12)
  }, [slashFilter, commands])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashFilter])

  function selectSlash(cmd: SlashCommand) {
    setInput(`/${cmd.name} `)
    inputRef.current?.focus()
  }

  // ── Model switcher ───────────────────────────────────────────────
  /** 后端自己上报的当前模型;pi 会话是 null(它的模型在 currentModel 里)。 */
  const backendModel = runtimeCapabilities?.model ?? null
  /** 外部 agent 的权限档位;pi 会话没有(它的权限靠沙箱)。 */
  const permissionModes = useMemo(
    () => describeAcpModes(runtimeCapabilities?.permissionModes?.options),
    [runtimeCapabilities],
  )
  const currentPermissionMode = runtimeCapabilities?.permissionModes?.currentId ?? null
  /** 当前模型支持推理才显示那一档 —— 原来这个判断藏在 hover 浮层里。 */
  const thinkingSupported = useMemo(() => {
    if (!currentModel) return false
    const known = models.find(
      (m) => m.provider === currentModel.provider && m.id === currentModel.id,
    )
    // 外部 agent 的推理深度由它自己管,宿主的 setThinkingLevel 对它无效
    return known ? known.reasoning : false
  }, [currentModel, models])
  const backendModelTitle = backendModel
    ? `模型与参数 · 当前由 ${backendModel.name ?? backendModel.id} 驱动`
    : '模型与参数'
  // 分组规则(收藏过滤、ACP 组豁免)抽在 model-menu.ts 里,那边有测试。
  const modelMenuItems = useMemo(
    () => buildModelMenuGroups({ models, favoriteModels, providerLabels, currentModel, query: modelQuery }),
    [models, favoriteModels, providerLabels, currentModel, modelQuery],
  )

  /**
   * 模型规格,给行的原生 title 用。
   *
   * 原来这是一张 hover 卡片,挂在模型行上的第二层 Popover 里 —— 面板本身已经是
   * 一层浮层了,再套一层 hover 浮层,鼠标走偏就全关。改成原生 title:
   * 常看的上下文窗口已经平铺在行尾,完整规格降级成 tooltip。
   */
  function modelSpecText(m: ModelInfo): string {
    const fmtTokens = (n?: number) =>
      !n ? null : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
    const cost = m.cost ?? {}
    const hasCost = (cost.input ?? 0) > 0 || (cost.output ?? 0) > 0
    const host = (() => {
      try {
        return m.baseUrl ? new URL(m.baseUrl).host : null
      } catch {
        return null
      }
    })()
    const rows: [string, string][] = []
    if (m.name && m.name !== m.id) rows.push(['名称', m.name])
    rows.push(['服务商', m.provider])
    if (host) rows.push(['接入点', host])
    if (m.api) rows.push(['协议', m.api])
    const ctx = fmtTokens(m.contextWindow)
    if (ctx) rows.push(['上下文', `${ctx} tokens`])
    const maxOut = fmtTokens(m.maxTokens)
    if (maxOut) rows.push(['最大输出', `${maxOut} tokens`])
    rows.push(['推理', m.reasoning ? '支持' : '不支持'])
    if (m.input?.length) rows.push(['输入', m.input.join(' + ')])
    if (hasCost) rows.push(['价格/M', `入 $${cost.input ?? 0} · 出 $${cost.output ?? 0}`])
    return rows.map(([k, v]) => `${k}:${v}`).join('\n')
  }

  // ── Thinking level ───────────────────────────────────────────────
  const THINKING_LEVELS: { key: ThinkingLevel; label: string }[] = [
    { key: 'off', label: '关闭' },
    { key: 'minimal', label: '极简' },
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
    { key: 'xhigh', label: '极高' },
  ]
  const thinkingLabel = THINKING_LEVELS.find((t) => t.key === thinking)?.label ?? '关闭'

  const modelChip = useMemo(
    () =>
      buildModelChip({
        currentModel,
        models,
        backendModel,
        thinkingLabel,
        thinkingEnabled: thinkingSupported && thinking !== 'off',
      }),
    [currentModel, models, backendModel, thinkingLabel, thinkingSupported, thinking],
  )

  async function handleThinkingSelect(level: ThinkingLevel) {
    try {
      await api.pi.setThinkingLevel(level)
      setThinking(level)
    } catch (err) {
      setError((err as Error).message ?? '切换推理深度失败')
    }
  }

  async function handlePermissionMode(modeId: string) {
    try {
      await api.pi.setPermissionMode(modeId)
      await refreshBackendState()
    } catch (err) {
      setError((err as Error).message ?? '切换权限模式失败')
    }
  }

  async function pickModel(key: string) {
    // 防重入。选外部 agent 会真的起一个进程,连点几下就攒下几个 ——
    // 日志里见过一次点击起三个 agent 的。用状态而不是只用 ref,好让那一行显示
    // 「切换中…」:外部 agent 首次要下包、握手,可能十几秒,不给反馈会像"点了没反应"。
    if (switchingModelRef.current) return
    switchingModelRef.current = true
    setSwitchingModelKey(key)
    const sep = key.indexOf('::')
    try {
      await api.pi.setModel(key.slice(0, sep), key.slice(sep + 2))
      // 选外部 agent 会换掉整个后端(能力、模型、推理档全变),组件又不重挂载,
      // 所以这里必须重新取,不能只把返回值塞进 currentModel。
      await refreshBackendState()
      // 选完就收起。弹层赖着不走的话,得点旁边空白处才关,像是"没选上"。
      setParamsOpen(false)
    } catch (err) {
      // setModel 会失败(外部 agent 启动/握手超时、ENOENT、被上游拒),必须把错抛到界面上,
      // 不能吞掉 —— 否则面板停在旧模型、没有任何提示,正是"选不中"的样子。
      setError((err as Error).message ?? '切换模型失败')
    } finally {
      switchingModelRef.current = false
      setSwitchingModelKey(null)
    }
  }

  async function handleSteering(mode: QueueMode) {
    setSteeringMode(mode)
    api.pi.setSteeringMode(mode).catch(() => {})
  }
  async function handleFollowUp(mode: QueueMode) {
    setFollowUpMode(mode)
    api.pi.setFollowUpMode(mode).catch(() => {})
  }
  async function handleAutoCompaction(enabled: boolean) {
    setAutoCompaction(enabled)
    api.pi.setAutoCompaction(enabled).catch(() => {})
  }
  async function handleCompact() {
    setCompacting(true)
    try {
      await api.pi.compact()
    } catch (err) {
      setError((err as Error).message ?? '压缩失败')
    } finally {
      setCompacting(false)
    }
  }

  const paramsPanel = (
    <div className={styles.paramsPanel}>
      <Input
        size="small"
        allowClear
        prefix={<Search size={12} />}
        placeholder="搜索模型或 agent"
        value={modelQuery}
        onChange={(e) => setModelQuery(e.target.value)}
      />

      <div className={styles.modelList}>
        {modelMenuItems.length === 0 && (
          <div className={styles.paramHint}>{modelQuery.trim() ? '没有匹配的模型' : '暂无可选模型'}</div>
        )}
        {modelMenuItems.map((group) => (
          <div key={group.provider}>
            <div className={styles.modelGroupLabel}>{group.label}</div>
            {group.children.map((m) => {
              const active = !!(
                currentModel && `${currentModel.provider}::${currentModel.id}` === m.key
              )
              const switching = switchingModelKey === m.key
              return (
                <button
                  key={m.key}
                  className={cx(styles.modelRow, active && styles.modelRowActive)}
                  onClick={() => pickModel(m.key)}
                  title={modelSpecText(m.info)}
                  aria-busy={switching}
                >
                  <span className={styles.modelCheckSlot}>
                    {switching ? <Loader2 size={13} className={styles.spin} /> : active && <Check size={13} />}
                  </span>
                  <span className={styles.modelRowLabel}>{m.label}</span>
                  {switching && <span className={styles.modelRowTag}>切换中…</span>}
                  {!switching && m.info.reasoning && <span className={styles.modelRowTag}>推理</span>}
                  {m.meta && <span className={styles.modelRowMeta}>{m.meta}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 会话参数原来埋在「模型列表的当前行的悬停浮层」里 —— 二级 hover 浮层,
          鼠标走偏就全关,而且这些设置跟选哪个模型根本是两回事。现在平铺。 */}
      {thinkingSupported && (
        <div>
          <div className={styles.paramLabel}>推理深度</div>
          <Segmented
            size="small"
            block
            value={thinking}
            onChange={(v) => handleThinkingSelect(v as ThinkingLevel)}
            options={THINKING_LEVELS.map((t) => ({ label: t.label, value: t.key }))}
          />
        </div>
      )}

      {permissionModes.length > 0 && (
        <div>
          <div className={styles.paramLabel}>
            权限模式
            <span style={{ color: token.colorTextQuaternary }}> · 外部 agent 自己决定要不要问</span>
          </div>
          <div className={styles.modeList}>
            {permissionModes.map((mode) => {
              const active = mode.id === currentPermissionMode
              return (
                <button
                  key={mode.id}
                  className={cx(styles.modeRow, active && styles.modelRowActive)}
                  onClick={() => handlePermissionMode(mode.id)}
                  title={mode.description}
                >
                  <span className={styles.modelCheckSlot}>{active && <Check size={13} />}</span>
                  <span className={styles.modelRowLabel}>{acpModeLabel(mode)}</span>
                  {mode.hint && <span className={styles.modeHint}>{mode.hint}</span>}
                  {/* 选中这一档等于关掉唯一的控制点:外部 agent 不走宿主的
                      fs/terminal 通道,权限请求是唯一能拦住它的地方。 */}
                  {mode.risky && <span className={styles.modeRiskTag}>放行</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <button className={styles.paramsMoreToggle} onClick={() => setParamsMoreOpen((v) => !v)}>
        {paramsMoreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        更多:插话 / 排队 / 自动压缩
      </button>

      {paramsMoreOpen && (
        <>
          <div className={styles.paramGrid}>
            <div style={{ flex: 1 }}>
              <div className={styles.paramLabel}>插话模式</div>
              <Segmented
                size="small"
                block
                value={steeringMode}
                onChange={(v) => handleSteering(v as QueueMode)}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '逐条', value: 'one-at-a-time' },
                ]}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div className={styles.paramLabel}>排队模式</div>
              <Segmented
                size="small"
                block
                value={followUpMode}
                onChange={(v) => handleFollowUp(v as QueueMode)}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '逐条', value: 'one-at-a-time' },
                ]}
              />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className={styles.paramLabel} style={{ marginBottom: 0 }}>自动压缩上下文</span>
            <Switch size="small" checked={autoCompaction} onChange={handleAutoCompaction} />
          </div>
          <Button
            size="small"
            block
            loading={compacting}
            disabled={runtimeCapabilities?.features.compact === false}
            title={
              runtimeCapabilities?.features.compact === false
                ? '当前后端不支持上下文压缩'
                : undefined
            }
            onClick={handleCompact}
          >
            立即压缩上下文
          </Button>
        </>
      )}
    </div>
  )

  const sessionExportPanel = (
    <div className={styles.paramsPanel} style={{ width: 180 }}>
      <Button
        size="small"
        block
        loading={sessionExportLoading === 'markdown'}
        onClick={() => exportCurrentSession('markdown')}
      >
        <FileText size={13} />
        Markdown
      </Button>
      <Button
        size="small"
        block
        loading={sessionExportLoading === 'json'}
        onClick={() => exportCurrentSession('json')}
      >
        <Download size={13} />
        JSON
      </Button>
    </div>
  )

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length === 0) return
    e.preventDefault()
    if (runtimeCapabilities?.features.images === false) {
      message.warning('当前 Pi Runtime 不支持图片输入')
      return
    }
    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        setImages((prev) => [...prev, { type: 'image', data: base64, mimeType: file.type }])
      }
      reader.readAsDataURL(file)
    }
  }

  const isEmpty = messages.length === 0
  const {
    snapshot: diffSnapshot,
    hasChanges: hasGitChanges,
    changedFiles,
    stagedCount,
    unstagedCount,
  } = gitDiff
  const diffReviewModal = (
    <Modal
      open={gitDiff.open}
      onCancel={gitDiff.close}
      title="本次 Agent 运行变更"
      width={1120}
      centered
      footer={[
        <Button key="refresh" onClick={gitDiff.openDiff} loading={gitDiff.loading}>
          刷新
        </Button>,
        <Button key="discard" danger disabled={!hasGitChanges || gitDiff.loading} onClick={gitDiff.discard}>
          <RotateCcw size={13} />
          撤销本次变更
        </Button>,
        <Button key="accept" type="primary" disabled={!hasGitChanges || gitDiff.loading} onClick={gitDiff.accept}>
          <ShieldCheck size={13} />
          接受变更
        </Button>,
      ]}
    >
      {gitDiff.loading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : !diffSnapshot ? (
        <Empty description="暂无 Git 信息" />
      ) : !hasGitChanges ? (
        <Empty description="本次运行没有变更" />
      ) : (
        <>
          <div className={styles.reviewHeader}>
            <div className={styles.reviewTitle}>
              <div className={styles.reviewName}>{workspace?.name ?? 'Workspace'}</div>
              <div className={styles.reviewHint}>
                {changedFiles.length} 个文件变更，未暂存 {unstagedCount}，已暂存 {stagedCount}
              </div>
            </div>
            <div className={styles.reviewHint}>
              接受会保留本次 Agent 变更；撤销只恢复运行期间的改动，运行前和完成后的用户修改会保留。
            </div>
          </div>

          {diffSnapshot.truncated && (
            <div className={styles.errorText} style={{ marginBottom: 12 }}>
              Diff 内容较大，已截断显示。完整内容可在终端用 git diff 查看。
            </div>
          )}

          <div className={styles.reviewBody}>
            <div className={styles.reviewSidebar}>
              <div className={styles.diffMetaBlock} style={{ marginBottom: 10 }}>
                <div className={styles.diffMetaTitle}>文件</div>
                <div className={styles.fileList}>
                  {changedFiles.map((file) => (
                    <div key={`${file.statusCode}:${file.path}`} className={styles.fileRow}>
                      <span className={styles.fileStatus}>{gitStatusLabel(file)}</span>
                      <span
                        className={styles.filePath}
                        title={file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
                      >
                        {file.path}
                      </span>
                      <button
                        className={styles.fileAction}
                        onClick={() => gitDiff.openChangedFile(file)}
                        title="在文件夹中显示"
                      >
                        <ExternalLink size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.diffMetaBlock}>
                <div className={styles.diffMetaTitle}>统计</div>
                <pre className={styles.diffPre} style={{ maxHeight: 150 }}>
                  {[diffSnapshot.unstagedStat, diffSnapshot.stagedStat].filter(Boolean).join('\n') || '无'}
                </pre>
              </div>
            </div>

            <div className={styles.reviewDiffPane}>
              <Tabs
                items={[
                  {
                    key: 'unstaged',
                    label: '未暂存 diff',
                    children: diffSnapshot.unstagedDiff ? (
                      <pre className={styles.diffPre}>{diffSnapshot.unstagedDiff}</pre>
                    ) : (
                      <Empty description="没有未暂存 diff" />
                    ),
                  },
                  {
                    key: 'staged',
                    label: '已暂存 diff',
                    children: diffSnapshot.stagedDiff ? (
                      <pre className={styles.diffPre}>{diffSnapshot.stagedDiff}</pre>
                    ) : (
                      <Empty description="没有已暂存 diff" />
                    ),
                  },
                  {
                    key: 'status',
                    label: '状态',
                    children: <pre className={styles.diffPre}>{diffSnapshot.status || '无'}</pre>,
                  },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </Modal>
  )

  const workspaceMemoryModal = (
    <Modal
      open={memoryOpen}
      onCancel={() => setMemoryOpen(false)}
      title="Workspace Memory"
      width={780}
      centered
      footer={[
        <Button key="cancel" onClick={() => setMemoryOpen(false)}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={memorySaving} onClick={saveWorkspaceMemory}>
          保存记忆
        </Button>,
      ]}
    >
      {memoryLoading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : (
        <>
          <div className={styles.memoryPath} title={memoryPath}>
            {memoryPath || '.pi-studio/memory.md'}
          </div>
          <textarea
            className={styles.memoryTextarea}
            value={memoryDraft}
            onChange={(e) => setMemoryDraft(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
    </Modal>
  )

  const memorySuggestionModal = (
    <Modal
      open={memorySuggestionOpen}
      onCancel={() => setMemorySuggestionOpen(false)}
      title="Workspace Memory 建议"
      width={760}
      centered
      footer={[
        <Button
          key="discard"
          onClick={() => {
            setMemorySuggestion(null)
            setMemorySuggestionDraft('')
            setMemorySuggestionOpen(false)
          }}
        >
          丢弃建议
        </Button>,
        <Button key="cancel" onClick={() => setMemorySuggestionOpen(false)}>
          稍后处理
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={memorySuggestionSaving}
          disabled={!memorySuggestionDraft.trim()}
          onClick={applyMemorySuggestion}
        >
          写入记忆
        </Button>,
      ]}
    >
      {memorySuggestion ? (
        <>
          <div className={styles.memorySuggestionHint}>
            Pi Studio 根据刚结束的任务生成了这段候选记忆。请编辑后再写入；保存后会追加到当前工作区的
            .pi-studio/memory.md，并从下一轮任务开始注入上下文。
          </div>
          <textarea
            className={styles.memoryTextarea}
            value={memorySuggestionDraft}
            onChange={(e) => setMemorySuggestionDraft(e.target.value)}
            spellCheck={false}
            style={{ minHeight: 260 }}
          />
        </>
      ) : (
        <Empty description="暂无记忆建议" />
      )}
    </Modal>
  )

  const runTimelineModal = (
    <Modal
      open={runTimelineOpen}
      onCancel={() => setRunTimelineOpen(false)}
      title="运行记录"
      width={900}
      centered
      footer={[
        <Button key="copy" disabled={runRecords.length === 0} onClick={copyRunTimeline}>
          <Download size={13} />
          复制 JSON
        </Button>,
        <Button key="close" type="primary" onClick={() => setRunTimelineOpen(false)}>
          关闭
        </Button>,
      ]}
    >
      {runRecords.length === 0 ? (
        <Empty description="还没有运行记录" />
      ) : (
        <>
          <div className={styles.runSummaryGrid}>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>最近状态</div>
              <div className={styles.runMetricValue}>{runStatusLabel(latestRun.status)}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>耗时</div>
              <div className={styles.runMetricValue}>{formatDuration(latestRun.startedAt, latestRun.endedAt)}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>工具调用</div>
              <div className={styles.runMetricValue}>{latestRun.tools.length}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>失败工具</div>
              <div className={styles.runMetricValue}>{latestRunErrors}</div>
            </div>
          </div>

          <div className={styles.runList}>
            {runRecords.map((run) => {
              const statusColor = runStatusColor(run.status, token)
              return (
                <div key={run.id} className={styles.runItem}>
                  <div className={styles.runItemHeader}>
                    <div className={styles.runItemTitle}>
                      <div className={styles.runItemName}>
                        {run.workspaceName ?? 'Workspace'} · {formatDuration(run.startedAt, run.endedAt)}
                      </div>
                      <div className={styles.runItemMeta}>
                        {formatClock(run.startedAt)}
                        {run.model ? ` · ${run.provider ?? 'model'}:${run.model}` : ''}
                        {` · 推理 ${run.thinking}`}
                        {` · ${run.tools.length} 个工具`}
                      </div>
                    </div>
                    <span
                      className={styles.runStatusBadge}
                      style={{ color: statusColor, borderColor: `${statusColor}55` }}
                    >
                      {runStatusLabel(run.status)}
                    </span>
                  </div>

                  <div className={styles.runTimeline}>
                    {run.timeline.map((item) => {
                      const itemColor = item.status ? runStatusColor(item.status, token) : token.colorBorder
                      return (
                        <div key={item.id} className={styles.runTimelineRow}>
                          <span className={styles.runTimelineTime}>{formatClock(item.timestamp)}</span>
                          <span className={styles.runTimelineDot} style={{ background: itemColor }} />
                          <div className={styles.runTimelineText}>
                            <div className={styles.runTimelineLabel}>{item.label}</div>
                            {item.detail && (
                              <div className={styles.runTimelineDetail} title={item.detail}>
                                {item.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )

  return (
    <div className={styles.pane}>
      {diffReviewModal}
      {workspaceMemoryModal}
      {memorySuggestionModal}
      {runTimelineModal}
      {error && (
        <div className={styles.errorBanner}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className={styles.errorDismiss} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {retryNotice && (
        <div className={styles.retryBanner}>
          <span style={{ flex: 1 }}>
            {`模型调用失败，正在自动重试（${retryNotice.attempt}/${retryNotice.maxAttempts}）：${retryNotice.message}`}
          </span>
        </div>
      )}
      {agentIssue && (
        <div className={styles.errorBanner}>
          <span style={{ flex: 1 }}>{agentIssueMessage(agentIssue)}</span>
          {onRestartAgent && (
            <Button size="small" type="primary" loading={restarting} onClick={onRestartAgent}>
              重启 agent
            </Button>
          )}
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          className={styles.messages}
          ref={messagesRef}
          // Wheel-up means "I want to read" — pause following immediately.
          // The scroll-position check alone can't do this: one wheel notch
          // (~100px) stays inside any reasonable near-bottom threshold, so
          // the next stream tick would snap the view right back.
          onWheel={(e) => {
            if (e.deltaY < 0) setAutoFollow(false)
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight
            setShowScrollBtn(dist > 200)
            if (dist < 20) setAutoFollow(true) // truly back at the bottom
            else if (dist > 150) setAutoFollow(false) // scrollbar drags etc.
          }}
        >
          <div className={styles.messagesInner}>
            {!workspace ? (
              <div className={styles.emptyState}>
                <FolderOpen size={36} color={token.colorTextTertiary} />
                <p className={styles.emptyTitle}>还没有打开工作区</p>
                <p className={styles.emptyHint}>从左上角选择一个项目目录，开始和 agent 对话。</p>
              </div>
            ) : starting ? (
              <div className={styles.emptyState}>
                <Spin size="small" />
                <p className={styles.emptyTitle}>{workspace.name}</p>
                <p className={styles.emptyHint}>正在启动 agent 进程…</p>
              </div>
            ) : isEmpty ? (
              <div className={styles.emptyState}>
                <p className={styles.emptyTitle}>{workspace.name}</p>
                <p className={styles.emptyHint}>向 agent 描述你想做的事，它可以读文件、跑命令、改代码。</p>
              </div>
            ) : (
              renderSegments.map((seg) =>
                seg.kind === 'toolSteps' ? (
                  <ToolStepsGroup
                    key={`ts-${seg.steps[0].index}`}
                    steps={seg.steps}
                    toolExecutions={toolExecutions}
                    styles={styles}
                    cx={cx}
                  />
                ) : (
                  <MessageBubble
                    key={seg.index}
                    msg={seg.msg}
                    toolExecutions={toolExecutions}
                    styles={styles}
                    cx={cx}
                  />
                ),
              )
            )}

          </div>
        </div>

        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, pointerEvents: 'none',
          background: `linear-gradient(to bottom, transparent, ${token.colorBgBase})`,
        }} />

        {showScrollBtn && (
          <button
            className={styles.scrollBottomBtn}
            onClick={() => {
              const el = messagesRef.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>

      <div className={styles.inputArea}>
        <div className={styles.inputAreaInner}>
          {agentStatus && (
            <div className={styles.agentStatusPanel}>
              {agentStatus.prompt && (
                <div className={styles.agentStatusTask} title={agentStatus.prompt}>
                  {agentStatus.prompt}
                </div>
              )}
              {agentStatus.startedAt && (
                <span className={styles.agentStatusItem}>
                  用时 {formatAgentElapsed(agentStatus.startedAt, statusNow)}
                </span>
              )}
              <span className={styles.agentStatusItem}>
                {agentStatus.phase === 'awaiting_approval'
                  ? '等待审批'
                  : agentStatus.phase === 'stopped'
                    ? '已停止'
                    : agentStatus.phase === 'running'
                      ? '运行中'
                      : '空闲'}
              </span>
              {(() => {
                const total =
                  agentStatus.todo.pending + agentStatus.todo.inProgress + agentStatus.todo.completed
                const label = `TODO ${agentStatus.todo.completed}/${total}`
                // 只有数字看不出在做什么、卡在哪一条 —— 有清单就能点开看
                if (agentStatus.todo.items.length === 0) {
                  return <span className={styles.agentStatusItem}>{label}</span>
                }
                return (
                  <Popover
                    trigger="click"
                    placement="top"
                    content={
                      <div className={styles.agentStatusDetail}>
                        {agentStatus.todo.items.map((item) => (
                          <div
                            key={item.id}
                            className={cx(
                              styles.agentStatusTodoRow,
                              item.status === 'completed' && styles.agentStatusTodoDone,
                            )}
                          >
                            <span className={styles.agentStatusTodoMark}>
                              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '○'}
                            </span>
                            <span>{item.content || '(无描述)'}</span>
                          </div>
                        ))}
                      </div>
                    }
                  >
                    <span className={cx(styles.agentStatusItem, styles.agentStatusClickable)}>{label}</span>
                  </Popover>
                )
              })()}
              {(() => {
                const entries = Object.entries(agentStatus.tools).sort((a, b) => b[1] - a[1])
                const total = entries.reduce((sum, [, count]) => sum + count, 0)
                const label = `工具 ${total}`
                // 工具名一直都在数据里,以前只是被加总成一个数字
                if (entries.length === 0) return <span className={styles.agentStatusItem}>{label}</span>
                return (
                  <Popover
                    trigger="click"
                    placement="top"
                    content={
                      <div className={styles.agentStatusDetail}>
                        {entries.map(([name, count]) => (
                          <div key={name} className={styles.agentStatusToolRow}>
                            <span>{name}</span>
                            <span className={styles.agentStatusToolCount}>{count}</span>
                          </div>
                        ))}
                      </div>
                    }
                  >
                    <span className={cx(styles.agentStatusItem, styles.agentStatusClickable)}>{label}</span>
                  </Popover>
                )
              })()}
              {agentStatus.failures > 0 && (
                <span className={styles.agentStatusItem}>失败 {agentStatus.failures}</span>
              )}
              {agentStatus.repeatedFailures > 0 && (
                <span className={cx(styles.agentStatusItem, styles.agentStatusAlert)}>
                  重复失败 {agentStatus.repeatedFailures}
                </span>
              )}
              {agentStatus.activeApprovals > 0 && (
                <span className={styles.agentStatusItem}>审批 {agentStatus.activeApprovals}</span>
              )}
              {agentStatus.loopDetected && (
                <span className={cx(styles.agentStatusItem, styles.agentStatusAlert)}>
                  循环已拦截
                </span>
              )}
            </div>
          )}
          {sending && (
            <div className={styles.runStatus}>
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className={styles.runStatusDot}
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
              <span>
                {runningTool ? `正在执行 ${runningTool}` : '思考中'} · 已运行 {elapsed}s
              </span>
            </div>
          )}
          {pendingApprovals.length > 0 && (
            <div className={styles.approvalStack}>
              {pendingApprovals.map((approval) => (
                <div key={approval.id} className={styles.approvalCard}>
                  <div className={styles.approvalHeader}>
                    <ShieldAlert size={15} color={token.colorWarning} />
                    <div className={styles.approvalTitle}>{approval.title}</div>
                    <div className={styles.approvalMeta}>{formatClock(approval.createdAt)}</div>
                  </div>
                  <div className={styles.approvalCommand}>
                    {approval.command ?? approval.message}
                  </div>
                  {approval.reason && (
                    <div className={styles.approvalReason}>原因：{approval.reason}</div>
                  )}
                  {approval.error && (
                    <div className={styles.approvalReason} style={{ color: token.colorError }}>
                      {approval.error}
                    </div>
                  )}
                  <div className={styles.approvalActions}>
                    <Button size="small" onClick={() => decideApproval(approval, 'deny')}>
                      拒绝
                    </Button>
                    <Button size="small" onClick={() => decideApproval(approval, 'allow-once')}>
                      允许一次
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {slashFilter !== null && slashMatches.length === 0 && (
            <div className={styles.slashPanel}>
              <div className={styles.slashItem} style={{ cursor: 'default' }}>
                <span className={styles.slashDesc}>
                  {commands.length === 0
                    ? '此工作区没有可用命令 — 把 skills / prompt 模板放进工作区的 .pi/ 目录或 pi 的配置目录后重新打开'
                    : '没有匹配的命令'}
                </span>
              </div>
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className={styles.slashPanel}>
              {slashMatches.map((c, i) => {
                const SourceIcon =
                  c.source === 'extension' ? Puzzle : c.source === 'prompt' ? FileText : SlashSquare
                return (
                  <div
                    key={`${c.source}:${c.name}`}
                    className={cx(styles.slashItem, i === slashIndex && styles.slashItemActive)}
                    onMouseEnter={() => setSlashIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault() // keep textarea focus
                      selectSlash(c)
                    }}
                  >
                    <SourceIcon size={13} color={token.colorTextTertiary} />
                    <span className={styles.slashName}>/{c.name}</span>
                    {c.description && <span className={styles.slashDesc}>{c.description}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <div
            className={cx(styles.inputBox, inputFocused && styles.inputBoxFocused)}
            data-shortcut-scope="composer"
          >
            {images.length > 0 && (
              <div className={styles.imageStrip}>
                {images.map((img, i) => (
                  <div key={i} className={styles.imageThumb}>
                    <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                    <button
                      className={styles.imageRemove}
                      onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setSlashDismissed(false)
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={
                !workspace
                  ? '请先打开一个工作区'
                  : starting
                    ? '正在启动 agent…'
                    : agentIssue
                      ? 'Agent 已断开，请重启后继续'
                      : sending
                        ? 'Agent 运行中，Enter 排队 · Ctrl+Enter 立即插话'
                        : '向 agent 描述任务，/ 唤起命令，可粘贴截图'
              }
              rows={1}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className={styles.inputTextarea}
              disabled={!workspace || starting || !!agentIssue}
            />
            <div className={styles.inputControls}>
              {workspace && (
                <Popover
                  trigger={['hover', 'click']}
                  placement="topLeft"
                  mouseEnterDelay={0.15}
                  mouseLeaveDelay={0.25}
                  open={paramsOpen}
                  onOpenChange={setParamsOpen}
                  content={paramsPanel}
                >
                  {/* 原来是一串 `·` 拼接:`codex-acp · GPT-5.6-Sol (medium) · 推理:高`,
                      越拼越长还会把整行挤爆。改成名字 + 弱化的后端模型 + 推理徽标。 */}
                  <button className={styles.modelChip} title={backendModelTitle}>
                    <SlidersHorizontal size={11} />
                    <span className={styles.modelChipName}>{modelChip.name}</span>
                    {modelChip.sub && <span className={styles.modelChipSub}>{modelChip.sub}</span>}
                    {modelChip.badge && (
                      <span className={styles.modelChipBadge}>{modelChip.badge}</span>
                    )}
                    <ChevronDown size={11} />
                  </button>
                </Popover>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={() => setRunTimelineOpen(true)} title="查看运行记录">
                  <Activity size={11} />
                  运行
                </button>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={openWorkspaceMemory} title="编辑 Workspace Memory">
                  <FileText size={11} />
                  记忆
                </button>
              )}
              {workspace && memorySuggestion && (
                <button
                  className={styles.modelChip}
                  onClick={() => setMemorySuggestionOpen(true)}
                  title="查看 Workspace Memory 建议"
                  style={{ color: token.colorPrimary }}
                >
                  <Check size={11} />
                  记忆建议
                </button>
              )}
              {workspace && (
                <Popover
                  trigger={['click']}
                  placement="top"
                  content={sessionExportPanel}
                >
                  <button className={styles.modelChip} title="导出当前会话">
                    <FileText size={11} />
                    会话
                  </button>
                </Popover>
              )}
              {workspace && hasGitChanges && (
                <button className={styles.modelChip} onClick={gitDiff.openDiff} title="查看工作区变更">
                  <GitCompare size={11} />
                  变更
                </button>
              )}
              <div style={{ flex: 1 }} />
              {sending && (
                <button
                  onClick={abortCurrentRun}
                  className={styles.sendBtn}
                  style={{ background: token.colorFill, color: token.colorTextSecondary }}
                  title="停止"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                onClick={() => sendMessage('queue')}
                disabled={(!input.trim() && images.length === 0) || !workspace || starting || !!agentIssue}
                className={styles.sendBtn}
                title={sending ? '排队（跑完后执行）' : '发送'}
                style={{
                  background:
                    input.trim() || images.length > 0
                      ? token.colorPrimary
                      : token.colorFillSecondary,
                  color: input.trim() || images.length > 0 ? '#ffffff' : token.colorTextTertiary,
                }}
              >
                <SendHorizontal size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Thinking is collapsed by default — it's the model's scratch reasoning,
// useful on demand but noise in the normal read.
function ThinkingBlock({ text, styles, cx }: { text: string; styles: StylesType; cx: CxType }) {
  // 思考过程默认展开(用户要看推理);嫌长可点标题收起
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div className={styles.thinkingToggle} onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={11}
          className={cx(styles.thinkingChevron, open && styles.thinkingChevronOpen)}
        />
        思考过程
      </div>
      {open && <div className={styles.thinkingBlock}>{text}</div>}
    </div>
  )
}

/** 把 assistant 一轮里连续的工具调用归成一组,默认折叠成一条,避免一堆卡片刷屏。 */
function ToolCallGroup({
  calls,
  toolExecutions,
  styles,
  cx,
}: {
  calls: ToolCall[]
  toolExecutions: Record<string, ToolExecutionState>
  styles: StylesType
  cx: CxType
}) {
  const [open, setOpen] = useState(false)
  const statusOf = (id: string): string => toolExecutions[id]?.status ?? 'running'
  const done = calls.filter((c) => statusOf(c.id) === 'done').length
  const errors = calls.filter((c) => statusOf(c.id) === 'error').length
  const running = calls.length - done - errors
  const label =
    running > 0
      ? `执行中 · ${done + errors}/${calls.length}`
      : `执行了 ${calls.length} 个操作`
  return (
    <div className={styles.toolGroup}>
      <div className={styles.toolGroupHead} onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={12}
          className={cx(styles.thinkingChevron, open && styles.thinkingChevronOpen)}
        />
        <Wrench size={12} />
        <span className={styles.toolGroupLabel}>{label}</span>
        {errors > 0 && <span className={styles.toolGroupError}>{errors} 失败</span>}
      </div>
      {open && (
        <div className={styles.toolGroupBody}>
          {calls.map((c) => (
            <ToolCallCard key={c.id} call={c} execution={toolExecutions[c.id]} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 气泡里可复制的原文:用户消息取文本块,assistant 取正文(不含思考和工具调用)。 */
function copyableTextOf(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (block as { type?: string }).type === 'text')
    .map((block) => (block as { text?: string }).text ?? '')
    .join('')
    .trim()
}

/** 一轮断掉之后想把刚发出去的原文捞回来,现在只能靠手选 —— 给个按钮。 */
function CopyMessageButton({
  text,
  styles,
}: {
  text: string
  styles: StylesType
}): ReactNode {
  const { message } = AntApp.useApp()
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={styles.msgActionBtn}
      title="复制这条消息的原文"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch (err) {
          message.error((err as Error).message ?? '复制失败')
        }
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

// memo: during streaming only the message being updated changes reference,
// so earlier bubbles skip re-rendering (and re-parsing their Markdown).
const MessageBubble = memo(function MessageBubble({
  msg,
  toolExecutions,
  styles,
  cx,
}: {
  msg: AgentMessage
  toolExecutions: Record<string, ToolExecutionState>
  styles: StylesType
  cx: CxType
}) {
  if (msg.role !== 'user' && msg.role !== 'assistant') return null

  const isUser = msg.role === 'user'
  const copyable = copyableTextOf(msg)

  return (
    <div className={cx('chat-msg-row', styles.msgRow, isUser && styles.msgRowUser)}>
      <div className={cx(styles.avatarBox, isUser ? styles.userAvatar : styles.agentAvatar)}>
        {isUser ? '我' : 'π'}
      </div>

      <div className={cx(styles.msgContent, isUser && styles.msgContentUser)}>
        {isUser ? (
          <div className={cx(styles.msgBubble, styles.msgBubbleUser)}>
            {Array.isArray(msg.content) &&
              msg.content.some((c) => (c as { type: string }).type === 'image') && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {(msg.content as Array<{ type: string; data?: string; mimeType?: string }>)
                    .filter((c) => c.type === 'image' && c.data)
                    .map((c, j) => (
                      <img
                        key={j}
                        src={`data:${c.mimeType};base64,${c.data}`}
                        alt=""
                        style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, display: 'block' }}
                      />
                    ))}
                </div>
              )}
            {textOf(msg.content as never)}
          </div>
        ) : (
          <div className={cx(styles.msgBubble, styles.msgBubbleAssistant)}>
            {(() => {
              // 连续的工具调用归组:>=2 折叠成一条,单个保留卡片,避免一堆卡刷屏
              const items: React.ReactNode[] = []
              let toolRun: ToolCall[] = []
              const flushTools = (): void => {
                if (toolRun.length === 0) return
                if (toolRun.length === 1) {
                  const c = toolRun[0]
                  items.push(<ToolCallCard key={c.id} call={c} execution={toolExecutions[c.id]} />)
                } else {
                  items.push(
                    <ToolCallGroup
                      key={`tg-${toolRun[0].id}`}
                      calls={toolRun}
                      toolExecutions={toolExecutions}
                      styles={styles}
                      cx={cx}
                    />,
                  )
                }
                toolRun = []
              }
              msg.content.forEach((block, i) => {
                if (block.type === 'toolCall') {
                  toolRun.push(block)
                  return
                }
                flushTools()
                if (block.type === 'text' && block.text) {
                  items.push(
                    <Markdown key={i} variant="chat" fontSize={15} style={{ margin: 0 }} enableLatex={false} enableMermaid={false} enableImageGallery={false}>
                      {block.text}
                    </Markdown>,
                  )
                } else if (block.type === 'thinking' && block.thinking) {
                  items.push(<ThinkingBlock key={i} text={block.thinking} styles={styles} cx={cx} />)
                }
              })
              flushTools()
              return items
            })()}
            {msg.role === 'assistant' && msg.errorMessage && (
              <div className={styles.errorText}>{msg.errorMessage}</div>
            )}
          </div>
        )}
        {copyable && (
          <div className={styles.msgActions}>
            <CopyMessageButton text={copyable} styles={styles} />
          </div>
        )}
      </div>
    </div>
  )
})

/** agent 的一步"工具步骤"= 只有 thinking+toolCall、没有最终文本回复的 assistant 消息。 */
function isToolStepMessage(msg: AgentMessage): boolean {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return false
  const blocks = msg.content as Array<{ type: string; text?: string }>
  const hasTool = blocks.some((b) => b.type === 'toolCall')
  const hasText = blocks.some((b) => b.type === 'text' && !!b.text)
  return hasTool && !hasText
}

type RenderSegment =
  | { kind: 'message'; msg: AgentMessage; index: number }
  | { kind: 'toolSteps'; steps: Array<{ msg: AgentMessage; index: number }> }

/** 把连续的工具步骤消息(>=2)归成一段,供列表层折叠;其余消息各自成段。 */
function segmentMessages(messages: AgentMessage[]): RenderSegment[] {
  const segments: RenderSegment[] = []
  let run: Array<{ msg: AgentMessage; index: number }> = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) segments.push({ kind: 'message', msg: run[0].msg, index: run[0].index })
    else segments.push({ kind: 'toolSteps', steps: run })
    run = []
  }
  messages.forEach((msg, index) => {
    // toolResult 等消息在 UI 上不渲染(MessageBubble 返回 null),不能让它们
    // 打断连续的工具步骤分组 —— 每个工具步骤后都跟一条 toolResult。
    if (msg.role !== 'user' && msg.role !== 'assistant') return
    if (isToolStepMessage(msg)) {
      run.push({ msg, index })
      return
    }
    flush()
    segments.push({ kind: 'message', msg, index })
  })
  flush()
  return segments
}

/** 连续工具步骤折叠成一条"执行了 N 步",点开逐条展开(每步含各自思考+工具卡)。 */
const ToolStepsGroup = memo(function ToolStepsGroup({
  steps,
  toolExecutions,
  styles,
  cx,
}: {
  steps: Array<{ msg: AgentMessage; index: number }>
  toolExecutions: Record<string, ToolExecutionState>
  styles: StylesType
  cx: CxType
}) {
  const [open, setOpen] = useState(false)
  const calls = steps.flatMap((s) =>
    ((s.msg as { content?: Array<{ type: string; id?: string }> }).content ?? []).filter(
      (b) => b.type === 'toolCall',
    ),
  )
  const statusOf = (id?: string): string => (id ? toolExecutions[id]?.status ?? 'running' : 'running')
  const done = calls.filter((c) => statusOf(c.id) === 'done').length
  const errors = calls.filter((c) => statusOf(c.id) === 'error').length
  const running = calls.length - done - errors
  const label =
    running > 0 ? `执行中 · ${done + errors}/${calls.length}` : `执行了 ${calls.length} 步`
  return (
    <div className={styles.toolGroup}>
      <div className={styles.toolGroupHead} onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={12}
          className={cx(styles.thinkingChevron, open && styles.thinkingChevronOpen)}
        />
        <Wrench size={12} />
        <span className={styles.toolGroupLabel}>{label}</span>
        {errors > 0 && <span className={styles.toolGroupError}>{errors} 失败</span>}
      </div>
      {open && (
        <div className={styles.toolGroupBody}>
          {steps.map((s) => (
            <MessageBubble
              key={s.index}
              msg={s.msg}
              toolExecutions={toolExecutions}
              styles={styles}
              cx={cx}
            />
          ))}
        </div>
      )}
    </div>
  )
})
