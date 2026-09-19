/**
 * 单一 IPC 契约源(见 优化.md「建立单一 IPC 契约源」)。
 *
 * 这里是 DesktopApi 及其全部请求/响应类型的**唯一**定义处:
 *  - preload 的 METHODS 清单受它反向约束,漏一个方法就编译失败(桥由清单生成,不手写);
 *  - renderer 直接 `Window.api: DesktopApi`,不再手写一份;
 *  - renderer/src/lib/api.ts 只做兼容再导出,组件的 import 路径不用改。
 *
 * 新增字段优先加成可选字段 —— 自动更新期间新旧 renderer/main 会短暂并存。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
} from '@earendil-works/pi-ai/compat'
import type {
  LlmProfileSavePayload,
  LlmProviderHealth,
  LlmProviderProfile,
  ModelCatalogView,
  SettingsSaveInput,
  SettingsView,
  Workspace,
} from '../contracts'

export type {
  LlmProfileWrite,
  LlmProfileSavePayload,
  LlmProviderHealth,
  LlmProviderProfile,
  ModelCatalogView,
  SettingsSaveInput,
  SettingsView,
  Workspace,
} from '../contracts'

// Type-safe wrapper around window.api (exposed by preload)

export type LocalBackupSummary = {
  name: string
  createdAt: string
  appVersion?: string | null
  kind?: 'daily' | 'pre-restore'
  fileCount?: number
  status: 'ready' | 'invalid'
  error?: string
}

export type DesktopApi = {
  platform: NodeJS.Platform
  win: {
    minimize: () => void
    maximize: () => void
    close: () => void
    flash: () => void
  }
  app: {
    version: () => Promise<string>
    piVersion: () => Promise<string>
  }
  clipboard: {
    writeText: (value: string) => Promise<void>
  }
  diagnostics: {
    getLogs: () => Promise<{
      ok: true
      content: string
      agentJobs: AgentJobSnapshot[]
      runtimeEvents?: RuntimeEventLogSnapshot
    }>
    save: (payload: {
      defaultPath: string
      content: string
    }) => Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
    listBackups?: () => Promise<{ ok: true; backups: LocalBackupSummary[] } | { error: string }>
    restoreBackup?: (payload: {
      name: string
    }) => Promise<{ ok: true; restarting?: boolean } | { error: string }>
  }
  settings: {
    load: () => Promise<SettingsView>
    save: (s: SettingsSaveInput) => Promise<{
      ok: boolean
      sandboxChanged?: boolean
      workspaceOpen?: boolean
    }>
    listCloudModels: (s: { relay: string; key: string }) => Promise<ProviderModelListResult>
    onChanged: (cb: () => void) => () => void
  }
  llmProfiles: {
    list: () => Promise<LlmProfileListResult>
    save: (
      payload: LlmProfileSavePayload,
    ) => Promise<{ ok: true; profile: LlmProviderProfile; warning?: string } | { error: string }>
    delete: (id: string) => Promise<{ ok: true; warning?: string } | { error: string }>
    refreshModels: (
      id: string,
    ) => Promise<{ ok: true; profile: LlmProviderProfile; warning?: string } | { error: string }>
    providerHealth: (
      id: string,
    ) => Promise<{ ok: true; health: LlmProviderHealth } | { error: string }>
  }
  modelCatalog: {
    loadProviderLabels: () => Promise<{ ok: true; view: ModelCatalogView } | { error: string }>
  }
  sandbox: {
    detect: () => Promise<SandboxDetect>
    imageStatus: () => Promise<SandboxImageStatus>
    buildImage: () => Promise<{ ok: true } | { error: string }>
    onBuildProgress: (cb: (line: string) => void) => () => void
  }
  remote: {
    getStatus: () => Promise<RemoteControlSnapshot>
    setEnabled: (enabled: boolean) => Promise<RemoteControlSnapshot>
    generatePairingCode: () => Promise<RemotePairingCode | { error: string }>
    resetPairings: () => Promise<{ ok: true } | { error: string }>
    onStatus: (cb: (snap: RemoteControlSnapshot) => void) => () => void
  }
  workspace: {
    list: () => Promise<Workspace[]>
    pickDirectory: () => Promise<string | null>
    open: (path: string) => Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }>
    remove: (path: string) => Promise<Workspace[]>
  }
  memory: {
    load: () => Promise<{ ok: true; memory: WorkspaceMemory } | { error: string }>
    save: (content: string) => Promise<{ ok: true; memory: WorkspaceMemory } | { error: string }>
    sharedStatus: () => Promise<{ ok: true; url: string; file: string; count: number } | { error: string }>
  }
  sessions: {
    list: () => Promise<SessionInfo[]>
    switch: (sessionPath: string) => Promise<{ cancelled: boolean }>
    rename: (name: string) => Promise<void>
    delete: (sessionPath: string) => Promise<{ ok: true } | { error: string }>
    exportCurrent: (
      format: SessionExportFormat,
    ) => Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
  }
  git: {
    diff: () => Promise<{ ok: true; snapshot: GitDiffSnapshot } | { error: string }>
    acceptChanges: () => Promise<{ ok: true } | { error: string }>
    discardChanges: () => Promise<{ ok: true; snapshot: GitDiffSnapshot } | { error: string }>
    showFile: (path: string) => Promise<{ ok: true } | { error: string }>
  }
  pi: {
    prompt: (message: string, images?: ImageContent[]) => Promise<void>
    steer: (message: string, images?: ImageContent[]) => Promise<void>
    followUp: (message: string, images?: ImageContent[]) => Promise<void>
    abort: () => Promise<void>
    bash: (command: string) => Promise<unknown>
    extensionUiResponse: (response: ExtensionUiResponse) => Promise<void>
    newSession: () => Promise<{ cancelled: boolean }>
    /** 后台会话(没在看的那些聊天)的运行状态变化。 */
    onSessionActivity: (cb: (event: SessionActivity) => void) => () => void
    getState: () => Promise<RpcSessionState>
    getMessages: () => Promise<AgentMessage[]>
    getArtifactChunk: (artifactId: string, offsetChars: number) => Promise<ArtifactChunk>
    getAvailableModels: () => Promise<ModelInfo[]>
    getCommands: () => Promise<SlashCommand[]>
    setModel: (provider: string, modelId: string) => Promise<{ provider: string; id: string }>
    setThinkingLevel: (level: ThinkingLevel) => Promise<void>
    setSteeringMode: (mode: QueueMode) => Promise<void>
    setFollowUpMode: (mode: QueueMode) => Promise<void>
    setAutoCompaction: (enabled: boolean) => Promise<void>
    /** 切换外部 agent 的权限模式(ACP 的 session/set_mode)。pi 会话上会报错。 */
    setPermissionMode: (modeId: string) => Promise<void>
    compact: () => Promise<unknown>
    onEvent: (cb: (event: PiRuntimeEvent) => void) => () => void
    onStatus: (cb: (event: AgentStatusEvent) => void) => () => void
    getRuntimeSnapshot: () => Promise<AgentRuntimeSnapshot>
    getAgentStatusSnapshot: () => Promise<AgentRunStatusSnapshot | null>
    getCapabilities: () => Promise<PiRuntimeCapabilities | null>
    onRuntime: (cb: (snapshot: AgentRuntimeSnapshot) => void) => () => void
    onAgentStatusSnapshot: (cb: (snapshot: AgentRunStatusSnapshot | null) => void) => () => void
    getSessionProjection: () => Promise<SessionProjectionSnapshot>
    getSessionChanges: (sessionId: string | null, afterSeq: number) => Promise<SessionProjectionChanges>
    onSessionProjection: (cb: (snapshot: SessionProjectionSnapshot) => void) => () => void
  }
  routines: {
    list: () => Promise<{ routines: Routine[]; runs: RoutineRun[] }>
    save: (
      routine: Partial<Routine> & Pick<Routine, 'name' | 'steps' | 'workspacePath' | 'schedule' | 'notify'>,
    ) => Promise<Routine[]>
    delete: (id: string) => Promise<Routine[]>
    toggle: (id: string, enabled: boolean) => Promise<Routine[]>
    runNow: (id: string) => Promise<{ ok: true } | { error: string }>
    cancel: (id: string) => Promise<{ ok: true } | { error: string }>
    state: () => Promise<{
      runningIds: string[]
      waitingIds: string[]
      cancellingIds: string[]
      queuedIds: string[]
      progress?: RoutineStepProgress[]
      pendingReviews: RoutineReviewRequest[]
    }>
    onRunFinished: (cb: (run: RoutineRun) => void) => () => void
    onStepProgress: (cb: (progress: RoutineStepProgress) => void) => () => void
    reviewRespond: (
      reviewId: string,
      decision: 'approve' | 'reject',
      comment?: string,
    ) => Promise<{ ok: true } | { error: string }>
    onReviewRequested: (cb: (request: RoutineReviewRequest) => void) => () => void
    onReviewCancelled: (cb: (payload: { reviewId: string; routineId: string; reason: string }) => void) => () => void
  }
  channels: {
    list: () => Promise<Channel[]>
    save: (channels: Channel[]) => Promise<Channel[]>
    test: (channel: Channel) => Promise<{ ok: true } | { error: string }>
  }
  imageGen: {
    health: () => Promise<ImageGenHealth>
    generate: (payload: {
      prompt: string
      engine: ImageGenEngine
      batchId?: string
      referenceUrls?: string[]
      maskDataUrl?: string
      size?: ImageGenSize
      aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
      imageSize?: GeminiImageResolution | GrokImageResolution
      n?: number
      quality?: ImageGenQuality
      background?: ImageGenBackground
      outputFormat?: ImageGenOutputFormat
      outputCompression?: number
      moderation?: ImageGenModeration
      responseFormat?: ImageGenResponseFormat
      providerStyle?: ImageGenProviderStyle
      user?: string
      model?: ImageModel
    }) => Promise<{ dataUrl: string; publicUrl: string | null; urls?: string[] } | { error: string }>
    history: (limit?: number) => Promise<ImageGenHistoryItem[] | { error: string }>
    historyDelete: (id: string) => Promise<{ ok: boolean }>
    historyDeleteBatch: (batchId: string) => Promise<{ ok: boolean }>
    uploadReference: (dataUrl: string) => Promise<{ ok: true; url: string } | { error: string }>
  }
  model3d: {
    health: () => Promise<Model3DHealth>
    generate: (payload: {
      mode: 'text' | 'image' | 'code' | 'blender'
      prompt: string
      imageDataUrl?: string
      /** 图生模式:true = 先用 gpt-image-2 按 prompt 生成参考图再图生 3D */
      aiImage?: boolean
      provider?: Model3DProvider
      options?: Model3DOptions
    }) => Promise<Model3DHistoryItem | { error: string }>
    generateBlender: (payload: { prompt: string; sourceId?: string }) => Promise<Model3DHistoryItem | { error: string }>
    blenderHealth: () => Promise<boolean>
    blenderStatus: () => Promise<BlenderSetupStatus>
    setupBlender: () => Promise<BlenderSetupStatus>
    generateCode: (payload: { prompt: string; sourceId?: string }) => Promise<Model3DHistoryItem | { error: string }>
    history: () => Promise<Model3DHistoryItem[]>
    historyDelete: (id: string) => Promise<{ ok: boolean }>
    saveThumbnail: (payload: { id: string; dataUrl: string }) => Promise<Model3DHistoryItem | { error: string }>
    /** 视觉闭环:存渲染截图 + 同步 AI 评审 + 返回分数 */
    reviewRound: (payload: {
      id: string
      dataUrl: string
      prompt: string
    }) => Promise<Model3DFidelity | { error: string }>
    onProgress: (
      cb: (data: { id: string; status: string; progress: number; prompt?: string; mode?: 'text' | 'image' }) => void,
    ) => () => void
    onScored: (cb: (data: { id: string; fidelity: Model3DFidelity }) => void) => () => void
  }
  dressup: {
    health: () => Promise<DressupHealth>
    generate: (payload: {
      firstFrameDataUrl: string
      tailFrameDataUrl: string
      prompt?: string
      mode?: 'std' | 'pro'
      duration?: '5' | '10'
      model?: string
    }) => Promise<DressupHistoryItem | { error: string }>
    // AI 试衣工作流:人物 + 衣服 → gpt-image-2 试衣 → Kling 换装视频。
    // firstFrameDataUrl 由渲染进程用 canvas 合成(人物 + 左上角衣服)。
    workflow: (payload: {
      personDataUrl: string
      garmentDataUrl: string
      firstFrameDataUrl: string
      prompt?: string
    }) => Promise<DressupHistoryItem | { error: string }>
    history: () => Promise<DressupHistoryItem[]>
    historyDelete: (id: string) => Promise<{ ok: boolean }>
    onProgress: (cb: (data: { id: string; status: string; progress: number; prompt?: string }) => void) => () => void
  }
  update: {
    onAvailable: (cb: (data: { version: string }) => void) => () => void
    onDownloaded: (cb: (data: { version: string }) => void) => () => void
    onError: (cb: (data: { message: string }) => void) => () => void
    install: () => void
  }
}

export type LlmProfileListResult = { ok: true; profiles: LlmProviderProfile[] } | { error: string }

export type ImageGenEngine = 'openai' | 'gemini' | 'grok'
export type ImageModel =
  | 'gpt-image-2'
  | 'gemini-3-pro-image-preview'
  | 'grok-imagine-image'
  | 'grok-imagine-image-quality'
  | 'grok-imagine-image-2.0'

export type GeminiImageAspectRatio = '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
export type GeminiImageResolution = '1K' | '2K' | '4K'

// Grok 只吃比例、不吃 size,而且比例集合比 Gemini 宽(有 20:9 这种超宽)。
// 分辨率只到 2K —— 4K 会被后端挡下。
export type GrokImageAspectRatio =
  | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  | '2:1' | '1:2' | '19.5:9' | '9:19.5' | '20:9' | '9:20' | 'auto'
export type GrokImageResolution = '1K' | '2K'
export type Model3DHealth = {
  configured: boolean
  /** 各 3D 服务商密钥是否就绪;探测失败时缺失 */
  providers?: Record<Model3DProvider, boolean>
}

export type BlenderSetupStatus = {
  connected: boolean
  blenderFound: boolean
  addonInstalled: boolean
  blenderPath?: string
  version?: string
  ok?: boolean
  error?: string
}

/** 云端 3D 服务商。Hi3D 是纯 image-to-3D,没有文生 3D 接口。 */
export type Model3DProvider = 'tripo' | 'hi3d'

export type Model3DOptions = {
  modelVersion?: string
  faceLimit?: number
  texture?: boolean
  pbr?: boolean
  style?: string
  /** Hi3D 专有:分辨率档位,合法值随 modelVersion 变化 */
  resolution?: string
  /** Tripo 专有:几何质量,仅 v3.0/v3.1 支持(P1 已预调优、不接受该参数) */
  geometryQuality?: string
}

export type Model3DFidelity = { score: number; notes: string; model: string }

export type DressupHealth = {
  configured: boolean
  /** 服务端 Kling 密钥是否就绪;探测失败时缺失 */
  klingReady?: boolean
}

export type DressupHistoryItem = {
  id: string
  prompt: string
  mode: 'std' | 'pro'
  duration: '5' | '10'
  videoUrl: string
  cloudVideoUrl?: string
  createdAt: number
}

export type Model3DHistoryItem = {
  id: string
  prompt: string
  mode: 'text' | 'image' | 'code' | 'blender'
  modelUrl: string
  cloudModelUrl?: string
  thumbnailUrl: string | null
  createdAt: number
  options?: Model3DOptions
  fidelity?: Model3DFidelity
}

/** TikHub/OpenAI-compatible images API documented size values. */
export type ImageGenSize =
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'
  | '1024x1792'
  | '1792x1024'
  | 'auto'

export type ImageGenQuality = 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
export type ImageGenBackground = 'auto' | 'transparent' | 'opaque'
export type ImageGenOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageGenModeration = 'auto' | 'low'
export type ImageGenResponseFormat = 'b64_json' | 'url'
export type ImageGenProviderStyle = 'vivid' | 'natural'

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  model: string
  r2: boolean
}

export type RoutineSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

export type RoutineNotify = 'always' | 'error' | 'never'

export type AppIconPlatform = 'android' | 'ios' | 'macos' | 'windows'

export type RoutineStepType =
  | 'agent'
  | 'folder-input'
  | 'imagegen'
  | 'app-icon'
  | 'model3d'
  | 'dressup'
  | 'review'
  | 'notify'
  | 'export'
  | 'feishu-doc'
  | 'wechat-draft'

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  prompt?: string
  engine?: ImageGenEngine
  channelId?: string
  message?: string
  path?: string
  format?: 'markdown' | 'html'
  /** model3d:图生 3D 服务商 */
  provider?: 'tripo' | 'hi3d'
  /** model3d / app-icon:输入图模板(默认 {{prev.imageUrl}});imagegen:可选参考图,留空即文生图 */
  imageRef?: string
  /** imagegen:输出尺寸,留空走服务端默认 */
  size?: ImageGenSize
  /** app-icon:资源包显示名称 */
  appName?: string
  /** app-icon:导出平台 */
  platforms?: AppIconPlatform[]
  /** app-icon:不透明底图背景色 */
  backgroundColor?: string
  /** app-icon:同一个工作流最多保留几次生成;留空或 <=0 就一直堆着 */
  keepHistory?: number
  personRef?: string
  garmentRef?: string
}

export type Routine = {
  id: string
  name: string
  input?: string
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  notifyChannelId?: string
  pushEachStep?: boolean
  createdAt: number
  lastRunAt?: number
}

export type RoutineStepResult = {
  id: string
  name: string
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'skipped'
  summary: string
  imageUrl?: string
  artifactPath?: string
  durationMs: number
}

export type RoutineReviewRequest = {
  reviewId: string
  routineId: string
  routineName: string
  stepId: string
  stepName: string
  message: string
  artifactPath?: string
  imageUrl?: string
  preview: string
}

export type ChannelType = 'feishu-webhook' | 'feishu-app' | 'wechat-official' | 'webhook' | 'local'

export type Channel = {
  id: string
  name: string
  type: ChannelType
  url?: string
  secret?: string
  appId?: string
  appSecret?: string
  chatId?: string
  folderToken?: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'interrupted'
  triggerSource?: 'manual' | 'schedule'
  summary: string
  steps?: RoutineStepResult[]
  error?: string
}

export type RoutineStepProgress = {
  routineId: string
  stepId: string
  stepIndex: number
  totalSteps: number
  status: 'running' | 'ok' | 'error' | 'timeout' | 'cancelled'
}

export type ImageGenHistoryItem = {
  id: string
  batch_id: string
  prompt: string
  engine: string
  model: string | null
  provider: string | null
  url: string
  created_at: number
}

export type ProviderConnectionResult =
  | { ok: true; message: string; details?: string }
  | { ok: false; message: string; details?: string }

export type ProviderModelListResult =
  | { ok: true; message: string; models: string[] }
  | { ok: false; message: string; details?: string }

/** 沙箱后端:macOS 走系统自带 Seatbelt,Windows 首选 WSL2+bwrap,Docker 是历史回退。 */
export type SandboxMode = 'wsl' | 'docker' | 'seatbelt'

export type SandboxDetect = {
  docker: { cliFound: boolean; daemonRunning: boolean; version: string }
  /** 首选执行路径:pi-studio-sandbox WSL 发行版是否就绪 */
  wslSandboxReady: boolean
  wsl: { available: boolean; distros: string[] }
  /** macOS 原生沙箱(sandbox-exec)是否可用 —— mac 上这是唯一路径,不走 Docker */
  seatbelt: boolean
}

export type SandboxImageStatus = {
  tag: string
  exists: boolean
  daemonRunning: boolean
}

export type RemoteControlSnapshot = {
  enabled: boolean
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  controllers: number
  lastError: string
}

export type RemotePairingCode = {
  code: string
  expiresAt: number
  qrPayload: string
}

export type WorkspaceMemory = {
  path: string
  exists: boolean
  content: string
}

export type QueueMode = 'all' | 'one-at-a-time'

export type RpcSessionState = {
  model?: { provider: string; id: string }
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
  autoCompactionEnabled: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  messageCount: number
  pendingMessageCount: number
}

export type ModelInfo = {
  provider: string
  id: string
  contextWindow: number
  reasoning: boolean
  // pi registry 的完整模型对象还带这些(RPC 原样透传;老版本/自定义条目可能缺,全部可选)
  name?: string
  api?: string
  baseUrl?: string
  input?: string[]
  maxTokens?: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type SlashCommand = {
  /** Command name (without leading slash) */
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
}

export type ExtensionUiRequest =
  | {
      type: 'extension_ui_request'
      id: string
      method: 'confirm'
      title: string
      message: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'notify'
      message: string
      notifyType?: 'info' | 'warning' | 'error'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'select'
      title: string
      options: string[]
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'input'
      title: string
      placeholder?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | 'editor'
      [key: string]: unknown
    }

export type ExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

/**
 * 由 `patches/@earendil-works__pi-coding-agent@0.84.2.patch` 注入。
 * 原版 rpc 模式在 prompt 预检通过之后再抛出的异常没有任何出口 —— 响应早就发过了,
 * 事件流里也不会有 agent_end,宿主只能看到这一轮凭空消失(两个会话同时"停住"就是这么来的)。
 * 补丁把它变成一条事件,ChatPane 才能把真实错误摆出来。
 */
export type PiRunFailedEvent = {
  type: 'run_failed'
  scope: 'prompt'
  message: string
}

export type PiRuntimeEvent = AgentSessionEvent | ExtensionUiRequest | PiRunFailedEvent

/** 每个聊天各自一个 agent 进程,后台那些只上报这个。 */
export type SessionActivity = { sessionFile: string | null; running: boolean }

export type AgentRuntimePhase = 'closed' | 'starting' | 'idle' | 'running' | 'awaiting_approval' | 'stopping' | 'error'

/** main 维护的 Agent 生命周期权威快照;revision 单调递增,乱序事件可弃 */
export type ExecutionSecuritySnapshot = {
  requested: 'confined' | 'full-access'
  filesystemMode: 'workspace-write' | 'danger-full-access'
  networkMode: 'allowlist' | 'unrestricted'
  backend: 'wsl-bwrap' | 'docker' | 'macos-seatbelt' | 'host'
  enforcement: 'full' | 'partial' | 'none'
  hostCodeExecution: boolean
  reason: string
}

export type AgentJobKind = 'chat' | 'routine' | 'code-model' | 'blender-model' | 'subagent'

/**
 * `done` 表示资源已经放掉,不只是那个函数返回了;`orphaned` 表示回收没被确认,
 * 进程可能还活着 —— 诊断包里要能看出这两者的差别。
 */
export type AgentJobState =
  | 'starting'
  | 'running'
  | 'idle'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'orphaned'

export type AgentJobOwner = { sessionId: string | null; sessionFile: string | null }

export type AgentJobSnapshot = {
  id: string
  kind: AgentJobKind
  /** 派生它的那个 job:子代理的父聊天。 */
  parentId: string | null
  owner: AgentJobOwner
  state: AgentJobState
  runActive: boolean
  pid: number | null
  startedAt: number
  lastActivatedAt: number
  runStartedAt: number | null
  endedAt: number | null
  finishReason: string | null
  forced: boolean
  cleanupError: string | null
}

export type RuntimeEventLogSnapshot = {
  path: string
  runs: RuntimeRunSummary[]
  invalidLines: number
  truncated: boolean
  readError?: string
}

export type RuntimeRunSummary = {
  runId: string
  kind: AgentJobKind | null
  cwd: string | null
  provider: string | null
  model: string | null
  sandboxMode: SandboxMode | null
  profileDigest: string | null
  audit: Record<string, unknown> | null
  startedAt: string | null
  lastEventAt: string | null
  settledAt: string | null
  cleanup: {
    at: string
    mode: 'dispose' | 'forceDispose'
    status: 'ok' | 'error'
    error: string | null
  } | null
  eventCount: number
  lastEventType: string | null
  recentEvents: Array<{ at: string; type: string | null; event: unknown }>
}

export type AgentRuntimeSnapshot = {
  revision: number
  phase: AgentRuntimePhase
  workspacePath: string | null
  sessionId: string | null
  sessionFile: string | null
  sandbox: SandboxMode | null
  security: ExecutionSecuritySnapshot | null
  profileDigest: string | null
  activeRun: { startedAt: number } | null
  error: { message: string } | null
}

/**
 * 当前会话背后是哪种 agent 后端。`pi` 是自家的 pi-coding-agent 子进程,
 * `acp` 是通过 Agent Client Protocol 接进来的外部 agent(Claude Code / Codex 等)。
 */
export type AgentEngine = 'pi' | 'acp'

export type PiRuntimeCapabilities = {
  engine: AgentEngine
  engineVersion: string
  protocolVersion: 'rpc-v1' | 'acp-v1'
  /** ACP 会话由外部 agent 自己存,宿主读不到,所以是 null。 */
  sessionFormatVersion: 'pi-jsonl-v1' | null
  handshake: {
    verified: boolean
    state: boolean
    messages: boolean
    commands: boolean
  }
  /**
   * 后端当前在用的模型,由后端自己上报。
   *
   * pi 的模型在会话状态 `state.model` 里,这里是 null。外部 ACP agent 的模型
   * 只有它自己知道(codex-acp 在 session/new 里报 currentModelId),问模型本人
   * 是不可信的 —— 它只知道训练时的身份,不知道被部署成哪个版本。
   */
  model?: { id: string; name?: string } | null
  /**
   * 后端的权限模式:当前档位和可选档位。
   *
   * 只有外部 ACP agent 有 —— 它自己决定什么操作要不要问,档位由它上报
   * (codex 三档、claude 六档,各家不一样)。pi 那边是 null:它的权限靠沙箱,
   * 没有可切换的档位。
   */
  permissionModes?: {
    currentId: string | null
    options: Array<{ id: string; name: string; description?: string }>
  } | null
  features: {
    listSessions: boolean
    resume: boolean
    fork: boolean
    subagents: boolean
    images: boolean
    compact: boolean
    approvals: boolean
    sessionRead: boolean
  }
}

export type StudioAgentEvent = {
  seq: number
  sessionId: string
  type:
    | 'session.changed'
    | 'session.cleared'
    | 'conversation.replaced'
    | 'approvals.replaced'
    | 'agent.started'
    | 'agent.ended'
    | 'agent.settled'
    | 'message.started'
    | 'message.updated'
    | 'message.finished'
    | 'tool.started'
    | 'tool.updated'
    | 'tool.finished'
    | 'approval.requested'
    | 'approval.decided'
    | 'run.failed'
    | 'agent.event'
  data: Record<string, unknown>
}

export type ArtifactChunk = {
  artifact: ToolOutputArtifact
  text: string
  offsetChars: number
  endChars: number
  totalChars: number
  complete: boolean
}

export type ToolOutputArtifact = {
  version: 1
  id: string
  toolCallId?: string
  toolName: string
  source?: 'runtime-tool-result' | 'session-projection'
  bytes: number
  sha256: string
  createdAt: string
  summary: string
}

export type ToolExecutionProjection = {
  callId: string
  sessionId: string
  runId: string | null
  toolName: string
  args?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  details?: unknown
  artifact?: ToolOutputArtifact
  startedAt: string
  endedAt?: string
}

export type ApprovalProjection = {
  id: string
  sessionId: string
  runId: string | null
  /** Real Pi tool call id when the request can be associated without guessing. */
  callId: string | null
  /** Stable audit correlation when no real tool call id is available. */
  correlation: {
    kind: 'tool-call' | 'extension-request'
    id: string
  }
  tool: string
  action: 'read' | 'write' | 'execute' | 'network' | 'credential' | 'external-side-effect'
  policy: { decision: 'ask'; reason?: string }
  title: string
  message: string
  command?: string
  reason?: string
  createdAt: string
  resolvedAt?: string
  outcome: 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  error?: string
}

export type SessionProjectionChanges = {
  sessionId: string | null
  afterSeq: number
  asOfSeq: number
  resetRequired: boolean
  events: StudioAgentEvent[]
}

export type SessionProjectionSnapshot = {
  revision: number
  /**
   * 只在 messages 被整体替换时递增(落库读取 / 换会话 / 清空)。
   * revision 每来一个 agent 事件都会动,分不出"消息变了"还是"只是工具进度变了";
   * 渲染层靠这个字段判断该不该用 projection 覆盖本地流式拼出来的消息。
   */
  messagesRevision: number
  asOfSeq: number
  workspacePath: string | null
  sessionFile: string | null
  sessionId: string | null
  source: 'durable-session'
  messages: AgentMessage[]
  tools: Record<string, ToolExecutionProjection>
  approvals: ApprovalProjection[]
  updatedAt: string | null
}

export type AgentRunStatusSnapshot = {
  version: 1
  cwd: string
  phase: 'idle' | 'running' | 'awaiting_approval' | 'stopped'
  prompt: string | null
  todo: AgentStatusTodo
  tools: Record<string, number>
  failures: number
  repeatedFailures: number
  activeApprovals: number
  startedAt: number | null
  updatedAt: string
  loopDetected: string | null
}

/** TODO 清单。只留计数的话界面就只能显示 "0/0",看不出在做什么、卡在哪一条。 */
export type AgentStatusTodo = {
  pending: number
  inProgress: number
  completed: number
  items: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export type AgentStatusEvent =
  | {
      status: 'started'
      cwd: string
      restoredSession: boolean
      sessionId?: string
      sessionFile?: string
      sandbox?: SandboxMode
      security?: ExecutionSecuritySnapshot
      profileDigest?: string
    }
  | {
      status: 'exited'
      cwd: string
      code: number | null
      signal: string | null
      expected: boolean
      message: string
    }
  | { status: 'error'; cwd: string; message: string }

export type SessionInfo = {
  path: string
  id: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  modified: string
}

export type SessionExportFormat = 'markdown' | 'json'

export type GitDiffSnapshot = {
  status: string
  files: GitChangedFile[]
  unstagedStat: string
  unstagedDiff: string
  stagedStat: string
  stagedDiff: string
  truncated: boolean
}

export type GitChangedFile = {
  path: string
  originalPath?: string
  statusCode: string
  staged: boolean
  unstaged: boolean
}

export type {
  AgentSessionEvent,
  AgentMessage,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
}
