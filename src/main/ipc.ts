import { ipcMain, BrowserWindow, app, clipboard, dialog, shell } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  listSessions,
  deleteSession,
  buildSessionExport,
  type SessionExportFormat,
} from './pi-sessions'
import { syncWebSearchExtension } from './web-search-extension'
import { getSharedMemoryConnection, getSharedMemoryStore, startSharedMemoryService } from './shared-memory'
import { sharedMemoryPath } from './workspace-memory'
import { syncAgentStatusExtension } from './agent-status-extension-sync'
import { AgentArtifactStore, materializeToolEvent } from './agent-artifact'
import {
  loadSettings,
  saveSettings,
  saveRemoteEnabled,
  addRecentWorkspace,
  removeRecentWorkspace,
  agentConfigDir,
} from './settings'
import { piClientManager, resolvePiCliPath, type AgentStatusEvent } from './pi-client'
import { syncSubagentRoles } from './subagent-roles'
import {
  acceptGitRunChanges,
  beginGitRunChanges,
  discardGitChanges,
  emptyGitDiffSnapshot,
  getGitDiffSnapshot,
  isGitWorkspace,
  sealGitRunChanges,
} from './git-diff'
import { appendAppLog, normalizeError, readRecentAppLog } from './app-log'
import { readRuntimeEventLog } from './runtime-event-log'
import { runtimeEventLogPath } from './runtime-event-recorder'
import {
  loadWorkspaceMemory,
  saveWorkspaceMemory,
  syncWorkspaceMemoryExtension,
} from './workspace-memory'
import { registerImageGenHandlers } from './image-gen'
import { getCloudConnection, getDraftCloudConnection } from './cloud-connection'
import { workspaceInventory } from './workspace-inventory'
import { fetchLlmCatalog, listEnabledLlmRoutes } from './llm-gateway'
import { ModelCatalogCoordinator } from './model-catalog'
import { parseLlmProfileSavePayload } from './ipc-contracts'
import {
  isRecord,
  oneOf,
  optionalString,
  parseArtifactId,
  parseModelSelection,
  parseNonNegativeSafeInteger,
  parsePrompt,
  parseSessionPath,
  parseSettingsSave,
  parseWorkspacePath,
  requiredString,
} from '../shared/ipc/validators'
import { isAcpSessionKey } from '../shared/acp-session-key'
import type { Workspace } from '../shared/contracts'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const QUEUE_MODES = ['all', 'one-at-a-time'] as const
import { registerRoutines } from './routines'
import { registerChannels } from './channels'
import { registerSandbox } from './sandbox'
import { registerModel3d } from './model3d'
import { registerDressup } from './dressup'
import { registerVideoGen } from './video-gen'
import { registerCodeModel } from './code-model'
import { registerBlenderModel } from './blender-model'
import { remoteControl } from './remote-control'
import { createSettingsView } from './settings-view'
import { listLocalDataBackups, scheduleDataRestore } from './local-data-backup'
import { AgentRuntimeTracker } from './agent-runtime'
import { SessionProjectionTracker } from './session-projection'
import { removeLegacySecurityGuardExtension } from './legacy-extension-cleanup'
import type { ApprovalProjection, ExtensionUiResponse, PiRuntimeEvent } from '../shared/ipc/contract'
import { approvalAuditJournal } from './approval-audit'
import { canRespondToOwnedUiRequest } from './extension-ui-ownership'

let dataRestoreRestartScheduled = false

// Agent Runtime 权威快照:renderer 重挂载/reload 后先取快照,再订阅变化
const agentRuntime = new AgentRuntimeTracker((snapshot) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agent:runtime', snapshot)
  }
})
const sessionProjection = new SessionProjectionTracker()
let agentArtifacts: AgentArtifactStore | null = null
function getAgentArtifacts(): AgentArtifactStore {
  return (agentArtifacts ??= new AgentArtifactStore(join(agentConfigDir(), 'artifacts')))
}
remoteControl.setProjectionProvider({
  snapshot: () => sessionProjection.snapshot(),
  changes: (sessionId, afterSeq) => sessionProjection.changes(sessionId, afterSeq),
})

function broadcastSessionProjection(): void {
  const snapshot = sessionProjection.snapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pi:sessionProjection', snapshot)
  }
}

function broadcastAgentStatusSnapshot(): void {
  const snapshot = piClientManager.getAgentStatusSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('agent:statusSnapshot', snapshot)
  }
}

async function refreshSessionProjection(): Promise<ReturnType<SessionProjectionTracker['snapshot']>> {
  const workspacePath = piClientManager.getWorkspacePath()
  if (!workspacePath) {
    const snapshot = sessionProjection.clear()
    broadcastSessionProjection()
    return snapshot
  }
  const identity = piClientManager.getActiveSessionIdentity()
  if (!identity) return sessionProjection.snapshot()
  // Capture the projection generation before either RPC read. Any live event
  // arriving while these promises are pending invalidates this cold load.
  const load = sessionProjection.beginLoad(
    workspacePath,
    identity.sessionFile,
    identity.sessionId,
  )
  broadcastSessionProjection()
  const source = await piClientManager.readActiveProjection()
  if (!source) return sessionProjection.snapshot()
  if (
    source.sessionId !== identity.sessionId ||
    source.sessionFile !== identity.sessionFile ||
    !sessionProjection.isCurrentLoad(load)
  ) {
    return sessionProjection.snapshot()
  }
  if (source.sessionFile) {
    const audited = approvalAuditJournal.load(source.sessionFile)
    const ownedApprovalIds = piClientManager.getActiveApprovalIds()
    const restored = sessionProjection.restoreApprovals(load, audited, ownedApprovalIds)
    const interrupted = new Set(
      audited
        .filter(
          (approval) =>
            approval.outcome === 'pending' && !ownedApprovalIds.has(approval.id),
        )
        .map((approval) => approval.id),
    )
    persistApprovalAudits(
      source.sessionFile,
      restored.approvals.filter((approval) => interrupted.has(approval.id)),
      'interrupted approval outcome',
    )
  }
  const snapshot = sessionProjection.commit(
    load,
    getAgentArtifacts().materializeMessages(workspacePath, source.messages) as AgentMessage[],
  )
  broadcastSessionProjection()
  return snapshot
}

function refreshSessionProjectionInBackground(): void {
  void refreshSessionProjection().catch((error) => {
    appendAppLog('warn', 'session.projection', 'Failed to refresh session projection', normalizeError(error))
  })
}

function selectActiveSessionProjection(): void {
  const workspacePath = piClientManager.getWorkspacePath()
  const identity = piClientManager.getActiveSessionIdentity()
  if (!workspacePath || !identity) return
  sessionProjection.beginLoad(workspacePath, identity.sessionFile, identity.sessionId)
  broadcastSessionProjection()
}

function persistApprovalAudits(
  sessionFile: string | null,
  approvals: ApprovalProjection[],
  action: string,
): void {
  if (!sessionFile) return
  for (const approval of approvals) {
    try {
      approvalAuditJournal.append(sessionFile, approval)
    } catch (error) {
      appendAppLog('warn', 'approval.audit', `Failed to append ${action}`, normalizeError(error))
    }
  }
}

export function registerIpcHandlers(): void {
  registerImageGenHandlers()
  registerRoutines()
  registerChannels()
  registerSandbox()
  registerModel3d()
  registerDressup()
  registerVideoGen()
  registerCodeModel()
  registerBlenderModel()

  // 远程控制:状态变化广播给所有窗口(设置页实时更新)
  remoteControl.setStatusListener((snap) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('remote:status', snap)
    }
  })
  ipcMain.handle('remote:getStatus', () => remoteControl.snapshot())
  ipcMain.handle('remote:setEnabled', async (_e, enabled: boolean) => {
    saveRemoteEnabled(enabled)
    if (enabled) await remoteControl.enable()
    else remoteControl.disable()
    return remoteControl.snapshot()
  })
  ipcMain.handle('remote:generatePairingCode', () => remoteControl.generatePairingCode())
  ipcMain.handle('remote:resetPairings', () => remoteControl.resetPairings())

  const sendAgentStatus = (win: BrowserWindow | null, event: AgentStatusEvent): void => {
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:status', event)
  }

  const sealRunChanges = async (workspacePath: string, reason: string): Promise<void> => {
    try {
      await sealGitRunChanges(workspacePath)
    } catch (err) {
      appendAppLog('warn', 'git.runChanges', 'Failed to seal agent run changes', {
        workspacePath,
        reason,
        rollbackDisabled: true,
        error: normalizeError(err),
      })
    }
  }

  const notifySettingsChanged = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed')
    }
  }

  const modelCatalog = new ModelCatalogCoordinator(undefined, notifySettingsChanged)

  // ── Window controls ──────────────────────────────────────────────
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // Taskbar flash for "agent finished while unfocused"; cleared on focus.
  ipcMain.on('win:flash', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || win.isFocused()) return
    win.flashFrame(true)
    win.once('focus', () => win.flashFrame(false))
  })

  // ── App ──────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('clipboard:writeText', (_event, value: unknown) => {
    if (typeof value !== 'string') throw new TypeError('clipboard text must be a string')
    clipboard.writeText(value)
  })
  // 底层 pi 引擎(@earendil-works/pi-coding-agent)的版本 —— pi-studio 基于它开发
  ipcMain.handle('app:piVersion', () => {
    try {
      // resolvePiCliPath() → .../pi-coding-agent/dist/cli.js;上两级是包根
      const pkg = join(dirname(dirname(resolvePiCliPath())), 'package.json')
      return (JSON.parse(readFileSync(pkg, 'utf8')).version as string) || ''
    } catch {
      return ''
    }
  })
  // agentJobs 才看得出后台还剩什么:owner、血缘、终态,以及 orphaned 的回收失败证据。
  ipcMain.handle('diagnostics:getLogs', () => ({
    ok: true,
    content: readRecentAppLog(),
    agentJobs: piClientManager.agentJobs(),
    runtimeEvents: readRuntimeEventLog(runtimeEventLogPath(app.getPath('userData'))),
  }))
  ipcMain.handle(
    'diagnostics:save',
    async (
      event,
      payload: {
        defaultPath: string
        content: string
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: '导出诊断包',
        defaultPath: payload.defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })

      if (result.canceled || !result.filePath) return { cancelled: true }

      try {
        writeFileSync(result.filePath, payload.content, 'utf-8')
        appendAppLog('info', 'diagnostics', 'Diagnostics bundle exported', {
          path: result.filePath,
        })
        return { ok: true, path: result.filePath }
      } catch (err) {
        appendAppLog('error', 'diagnostics', 'Diagnostics bundle export failed', normalizeError(err))
        return { error: (err as Error).message ?? '导出诊断包失败' }
      }
    },
  )
  ipcMain.handle('diagnostics:listBackups', () => {
    try {
      return { ok: true, backups: listLocalDataBackups(app.getPath('userData')) }
    } catch (error) {
      appendAppLog('error', 'backup', 'Failed to list local data backups', normalizeError(error))
      return { error: (error as Error).message ?? '读取备份列表失败' }
    }
  })
  ipcMain.handle('diagnostics:restoreBackup', (_event, payload: unknown) => {
    try {
      if (!isRecord(payload)) throw new Error('恢复参数无效')
      const name = requiredString(payload.name, '备份名称')
      scheduleDataRestore(app.getPath('userData'), name)
      appendAppLog('info', 'backup', 'Scheduled local data restore', { name })
      if (!dataRestoreRestartScheduled) {
        dataRestoreRestartScheduled = true
        setTimeout(() => {
          app.relaunch()
          app.quit()
        }, 250)
      }
      return { ok: true, restarting: true }
    } catch (error) {
      appendAppLog('error', 'backup', 'Failed to schedule local data restore', normalizeError(error))
      return { error: (error as Error).message ?? '安排数据恢复失败' }
    }
  })

  // ── Settings ────────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => {
    const settings = loadSettings()
    return createSettingsView(settings, getCloudConnection().available)
  })
  ipcMain.handle(
    'settings:save',
    (
      _e,
      payload: unknown,
    ) => {
      // 原来直接 ...settings 落盘:多余字段被持久化,非字符串的
      // cloudImageKey 会在 .trim() 上崩掉 handler
      const settings = parseSettingsSave(payload)
      const current = loadSettings()
      const sandboxWas = current.sandboxEnabled
      saveSettings({
        ...settings,
        cloudImageKey: settings.clearCloudImageKey
          ? ''
          : settings.cloudImageKey.trim() || current.cloudImageKey,
      })
      // 通知所有窗口设置已变,让聊天页模型切换器等即时同步(无需重开工作区)
      notifySettingsChanged()
      // 沙箱开关变化时旧 agent 子进程还跑在旧模式里——告知渲染进程触发工作区重启
      const sandboxChanged = sandboxWas !== settings.sandboxEnabled
      return {
        ok: true,
        sandboxChanged,
        workspaceOpen: sandboxChanged && !!piClientManager.getWorkspacePath(),
      }
    },
  )
  ipcMain.handle('llmProfiles:list', async () => {
    try {
      return { ok: true, profiles: await modelCatalog.listProfiles() }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('modelCatalog:loadProviderLabels', async () => {
    try {
      return { ok: true, view: await modelCatalog.loadProviderLabels() }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle(
    'llmProfiles:save',
    async (_event, payload: unknown) => {
      try {
        const result = await modelCatalog.saveProfile(parseLlmProfileSavePayload(payload))
        return { ok: true, profile: result.profile, warning: result.warning }
      } catch (err) {
        return { error: (err as Error).message ?? String(err) }
      }
    },
  )
  ipcMain.handle('llmProfiles:delete', async (_event, id: string) => {
    try {
      return { ok: true, ...(await modelCatalog.deleteProfile(id)) }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('llmProfiles:refreshModels', async (_event, id: string) => {
    try {
      const result = await modelCatalog.refreshProfileModels(id)
      return { ok: true, profile: result.profile, warning: result.warning }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('llmProfiles:providerHealth', async (_event, id: string) => {
    try {
      return { ok: true, health: await modelCatalog.providerHealth(id) }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })

  ipcMain.handle('settings:listCloudModels', async (_event, payload: unknown) => {
    try {
      if (!isRecord(payload)) throw new TypeError('云服务配置无效')
      const connection = getDraftCloudConnection({
        relay: optionalString(payload.relay, '云服务地址') ?? '',
        key: optionalString(payload.key, 'Pi Studio 应用令牌') ?? '',
      })
      if (!connection.available) {
        return { ok: false, message: '云服务配置无效', details: connection.error }
      }

      const models = listEnabledLlmRoutes(
        await fetchLlmCatalog(connection.relay, connection.key),
      )
      if (models.length === 0) {
        return { ok: false, message: '云端没有可用模型' }
      }
      return { ok: true, message: `已从云端读取 ${models.length} 个模型`, models }
    } catch (err) {
      return {
        ok: false,
        message: '云端模型读取失败',
        details: (err as Error).message ?? String(err),
      }
    }
  })

  // ── Workspaces ───────────────────────────────────────────────────
  ipcMain.handle('workspace:list', () => loadSettings().recentWorkspaces)

  ipcMain.handle('workspace:pickDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 开工作区的完整流程(备 runtime、装扩展、起 agent 子进程并挂上事件回调)。
  // 手机远程开工作区必须走同一条路,否则事件转发、run 变更封存这些都会漏,
  // 所以从 IPC handler 里拎出来复用。
  const openWorkspace = async (
    rawWorkspacePath: unknown,
    win: BrowserWindow | null,
  ): Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }> => {
    let workspacePath: string
    try {
      workspacePath = parseWorkspacePath(rawWorkspacePath)
      if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
        throw new TypeError('工作区必须是已存在的目录')
      }
    } catch (err) {
      appendAppLog('warn', 'ipc.contract', 'Rejected workspace:open', normalizeError(err))
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const settings = loadSettings()

    syncWebSearchExtension(!!settings.tavilyApiKey)
    removeLegacySecurityGuardExtension()
    syncWorkspaceMemoryExtension()
    syncAgentStatusExtension()
    let subagentsAvailable = false
    try {
      syncSubagentRoles(settings.subagentsEnabled)
      subagentsAvailable = settings.subagentsEnabled
    } catch (err) {
      appendAppLog('warn', 'workspace.open', 'Failed to sync subagent workflow', normalizeError(err))
      console.warn('Failed to sync pi-studio subagent workflow:', err)
    }

    agentRuntime.starting(workspacePath)
    sessionProjection.clear()
    broadcastSessionProjection()
    try {
      await piClientManager.startWorkspace(
        workspacePath,
        { subagentsAvailable },
        async (agentEvent, context) => {
          const normalizedAgentEvent = materializeToolEvent(
            getAgentArtifacts(),
            workspacePath,
            agentEvent as unknown as Record<string, unknown>,
          ) as unknown as PiRuntimeEvent
          const projected = sessionProjection.ingest(context.sessionId, normalizedAgentEvent)
          let projectionChanged = projected.projectionChanged
          const approvalId =
            normalizedAgentEvent.type === 'extension_ui_request' && normalizedAgentEvent.method === 'confirm'
              ? normalizedAgentEvent.id
              : undefined
          const approval = approvalId
            ? sessionProjection.snapshot().approvals.find((item) => item.id === approvalId)
            : undefined
          if (approval) persistApprovalAudits(context.sessionFile, [approval], 'approval request')
          if (normalizedAgentEvent.type === 'agent_settled') {
            const cancelled = sessionProjection.cancelPendingApprovals(
              context.sessionId,
              '运行已结束，审批已失效',
            )
            persistApprovalAudits(context.sessionFile, cancelled, 'settled approval outcome')
            projectionChanged ||= cancelled.length > 0
          }
          if (projectionChanged) {
            broadcastSessionProjection()
          }
          agentRuntime.agentEvent(context.sessionId, normalizedAgentEvent)
          broadcastAgentStatusSnapshot()
          // Forward before any await: otherwise a session switch can make this old,
          // unscoped Pi event mutate the newly selected renderer conversation.
          if (win && !win.isDestroyed()) win.webContents.send('pi:event', normalizedAgentEvent)
          if (projected.accepted) remoteControl.forwardEvent(projected.event)
          // willRetry 的 agent_end 只是重试前的一段间隙,这时封存基线,重试里新写的
          // 文件就落在任何一次运行变更之外 —— 回滚兜不住它们。
          if (normalizedAgentEvent.type === 'agent_end' && !normalizedAgentEvent.willRetry) {
            await sealRunChanges(workspacePath, 'agent ended')
          }
          if (normalizedAgentEvent.type === 'agent_settled') refreshSessionProjectionInBackground()
        },
        (statusEvent) => {
          agentRuntime.status(statusEvent)
          if (statusEvent.status === 'started') {
            sessionProjection.beginLoad(
              statusEvent.cwd,
              statusEvent.sessionFile ?? null,
              statusEvent.sessionId ?? statusEvent.sessionFile ?? `${statusEvent.cwd}:session`,
            )
            broadcastSessionProjection()
            broadcastAgentStatusSnapshot()
            sendAgentStatus(win, statusEvent)
            return
          }
          void sealRunChanges(statusEvent.cwd, `agent ${statusEvent.status}`).then(() => {
            sendAgentStatus(win, statusEvent)
          })
        },
        async (stoppedWorkspacePath) => {
          await sealRunChanges(stoppedWorkspacePath, 'workspace replaced')
        },
        // 后台会话不走完整事件流,只把"在跑/停了"报给侧栏
        (activity) => {
          if (win && !win.isDestroyed()) win.webContents.send('pi:sessionActivity', activity)
        },
        (context) => {
          agentRuntime.activate(
            context.sessionId,
            context.sessionFile,
            context.awaitingApproval ? 'awaiting_approval' : context.runActive ? 'running' : 'idle',
            context.runStartedAt,
          )
          selectActiveSessionProjection()
          broadcastAgentStatusSnapshot()
          refreshSessionProjectionInBackground()
        },
      )
      refreshSessionProjectionInBackground()
    } catch (err) {
      agentRuntime.startFailed((err as Error).message ?? '启动工作区失败')
      appendAppLog('error', 'workspace.open', 'Failed to start workspace', {
        workspacePath,
        error: normalizeError(err),
      })
      return { error: (err as Error).message ?? '启动工作区失败' }
    }

    const recentWorkspaces = addRecentWorkspace(workspacePath)
    appendAppLog('info', 'workspace.open', 'Workspace opened', { workspacePath })
    return { ok: true, recentWorkspaces }
  }

  ipcMain.handle('workspace:open', (event, workspacePath: unknown) =>
    openWorkspace(workspacePath, BrowserWindow.fromWebContents(event.sender)),
  )

  // 手机端的自救通道:桌面冷启动后没人点「打开工作区」时,除了这两条指令
  // 其余全会抛 NO_WORKSPACE,而人往往不在电脑前。
  remoteControl.setWorkspaceHost({
    list: () => ({
      current: piClientManager.getWorkspacePath(),
      recent: loadSettings().recentWorkspaces,
    }),
    inventory: () => workspaceInventory(
      piClientManager.getWorkspacePath(),
      loadSettings().recentWorkspaces,
    ),
    open: (path) => openWorkspace(path, BrowserWindow.getAllWindows()[0] ?? null),
  })

  ipcMain.handle('workspace:remove', (_e, workspacePath: unknown) => {
    return removeRecentWorkspace(parseWorkspacePath(workspacePath))
  })

  // ── Workspace memory ───────────────────────────────────────────
  ipcMain.handle('memory:load', () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      return { ok: true, memory: loadWorkspaceMemory(cwd) }
    } catch (err) {
      appendAppLog('error', 'memory.load', 'Failed to load workspace memory', normalizeError(err))
      return { error: (err as Error).message ?? '读取 Workspace Memory 失败' }
    }
  })
  ipcMain.handle('memory:save', (_e, content: string) => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      const memory = saveWorkspaceMemory(cwd, content)
      appendAppLog('info', 'memory.save', 'Workspace memory saved', { path: memory.path })
      return { ok: true, memory }
    } catch (err) {
      appendAppLog('error', 'memory.save', 'Failed to save workspace memory', normalizeError(err))
      return { error: (err as Error).message ?? '保存 Workspace Memory 失败' }
    }
  })
  ipcMain.handle('memory:sharedStatus', async () => {
    try {
      const memory =
        getSharedMemoryConnection() ??
        (await startSharedMemoryService(sharedMemoryPath(), (message, error) => {
          appendAppLog('warn', 'memory.snapshot', message, normalizeError(error))
        }))
      return { ok: true, url: memory.url, file: memory.file, count: getSharedMemoryStore()?.count() ?? 0 }
    } catch (err) {
      return { error: (err as Error).message ?? '共享记忆服务不可用' }
    }
  })

  // ── Sessions ─────────────────────────────────────────────────────
  ipcMain.handle('sessions:list', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return []
    // 目录取工作区级的缓存,不再从「当前会话的 sessionFile」现推 ——
    // ACP 会话没有 sessionFile,那样会让整个列表空掉。
    const acp = piClientManager.listAcpSessions()
    const sessionDir = piClientManager.getSessionDir()
    if (!sessionDir) return acp
    const pi = await listSessions(sessionDir, cwd)
    // 外部 agent 的会话排在一起按时间归并,列表里就是同一批东西。
    return [...pi, ...acp].sort((a, b) => b.modified.localeCompare(a.modified))
  })
  ipcMain.handle('sessions:switch', async (_e, sessionPath: unknown) => {
    // 外部 agent 会话不是文件路径,先分流再做路径校验。
    if (isAcpSessionKey(sessionPath)) {
      const result = await piClientManager.switchAcpSession(sessionPath)
      if (!result.cancelled) {
        selectActiveSessionProjection()
        refreshSessionProjectionInBackground()
      }
      return { cancelled: result.cancelled }
    }
    const sessionDir = piClientManager.getSessionDir()
    if (!sessionDir) return { cancelled: true }
    try {
      const result = await piClientManager.switchSession(
        parseSessionPath(sessionPath, sessionDir),
      )
      if (!result.cancelled) {
        selectActiveSessionProjection()
        refreshSessionProjectionInBackground()
      }
      return result
    } catch (err) {
      appendAppLog('warn', 'ipc.contract', 'Rejected sessions:switch', normalizeError(err))
      return { cancelled: true }
    }
  })
  ipcMain.handle('sessions:rename', (_e, name: unknown) =>
    piClientManager.setSessionName(requiredString(name, '会话名称')),
  )
  ipcMain.handle('sessions:delete', async (_e, sessionPath: unknown) => {
    // 外部 agent 会话没有文件可删,"删除"就是把连接收掉。
    if (isAcpSessionKey(sessionPath)) return piClientManager.closeAcpSession(sessionPath)
    const sessionDir = piClientManager.getSessionDir()
    if (!sessionDir) return { error: '当前没有会话' }
    // 路径由 main 判定:必须是本工作区会话目录下的 .jsonl,
    // 否则这个接口等于把 unlinkSync 暴露给了 renderer。
    let target: string
    try {
      target = parseSessionPath(sessionPath, sessionDir)
    } catch (err) {
      appendAppLog('warn', 'ipc.contract', 'Rejected sessions:delete', normalizeError(err))
      return { error: (err as Error).message }
    }
    // Never delete the file the running agent is writing to。取前台会话的身份而不是
    // getState:当前会话是 ACP 时 getState 没有 sessionFile,这条保护会失效。
    const activeSessionFile = piClientManager.getActiveSessionIdentity()?.sessionFile
    if (activeSessionFile && resolve(activeSessionFile) === target) {
      return { error: '不能删除当前会话' }
    }
    // 后台会话也各自占着一个 agent 进程,先收掉它再删文件
    const release = await piClientManager.releaseSession(target)
    if (!release.released) return { error: '该会话正在后台运行，先停止再删除' }
    deleteSession(target)
    approvalAuditJournal.remove(target)
    return { ok: true }
  })
  ipcMain.handle('sessions:exportCurrent', async (event, format: SessionExportFormat) => {
    const state = await piClientManager.getState()
    if (!state.sessionFile) return { error: '当前会话还没有可导出的记录' }
    const normalizedFormat: SessionExportFormat = format === 'json' ? 'json' : 'markdown'

    try {
      const exported = buildSessionExport(state.sessionFile, normalizedFormat)
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: normalizedFormat === 'json' ? '导出会话 JSON' : '导出会话 Markdown',
        defaultPath: exported.fileName,
        filters:
          normalizedFormat === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      })

      if (result.canceled || !result.filePath) return { cancelled: true }

      writeFileSync(result.filePath, exported.content, 'utf-8')
      appendAppLog('info', 'sessions.export', 'Session exported', {
        path: result.filePath,
        format: normalizedFormat,
        sessionFile: state.sessionFile,
      })
      return { ok: true, path: result.filePath }
    } catch (err) {
      appendAppLog('error', 'sessions.export', 'Session export failed', normalizeError(err))
      return { error: (err as Error).message ?? '导出会话失败' }
    }
  })

  ipcMain.handle('git:diff', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      return { ok: true, snapshot: await getGitDiffSnapshot(cwd) }
    } catch (err) {
      appendAppLog('warn', 'git.diff', 'Failed to read git diff snapshot', normalizeError(err))
      return { error: (err as Error).message ?? '读取 Git 变更失败' }
    }
  })
  ipcMain.handle('git:discardChanges', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      const before = await getGitDiffSnapshot(cwd)
      if (!before.status.trim()) return { ok: true, snapshot: before }
      await discardGitChanges(cwd)
      const snapshot = emptyGitDiffSnapshot()
      appendAppLog('warn', 'git.discard', 'Workspace changes discarded', {
        cwd,
        changedFiles: before.files.map((file) => file.path),
      })
      return { ok: true, snapshot }
    } catch (err) {
      appendAppLog('error', 'git.discard', 'Failed to discard workspace changes', normalizeError(err))
      return { error: (err as Error).message ?? '回滚工作区变更失败' }
    }
  })
  ipcMain.handle('git:acceptChanges', () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    acceptGitRunChanges(cwd)
    return { ok: true }
  })
  ipcMain.handle('git:showFile', async (_event, filePath: unknown) => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }

    const workspaceRoot = resolve(cwd)
    const target = resolve(workspaceRoot, requiredString(filePath, '文件路径'))
    const workspaceRootKey = workspaceRoot.toLowerCase()
    const targetKey = target.toLowerCase()
    if (targetKey !== workspaceRootKey && !targetKey.startsWith(`${workspaceRootKey}${sep}`)) {
      return { error: '文件路径不在当前工作区内' }
    }

    try {
      if (existsSync(target)) {
        shell.showItemInFolder(target)
      } else {
        await shell.openPath(workspaceRoot)
      }
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message ?? '打开文件失败' }
    }
  })

  // ── Pi agent session ─────────────────────────────────────────────
  ipcMain.handle('pi:prompt', async (_e, rawMessage: unknown, images?: ImageContent[]) => {
    const message = parsePrompt(rawMessage)
    const cwd = piClientManager.getWorkspacePath()
    let baselineCaptured = false
    if (cwd && (await isGitWorkspace(cwd))) {
      try {
        await beginGitRunChanges(cwd)
        baselineCaptured = true
      } catch (err) {
        appendAppLog('warn', 'git.runChanges', 'Failed to capture agent run baseline', {
          workspacePath: cwd,
          error: normalizeError(err),
        })
        throw err
      }
    }
    try {
      await piClientManager.prompt(message, images)
    } catch (err) {
      if (baselineCaptured && cwd) await sealRunChanges(cwd, 'prompt rejected')
      throw err
    } finally {
      broadcastAgentStatusSnapshot()
    }
  })
  ipcMain.handle('pi:steer', async (_e, rawMessage: unknown, images?: ImageContent[]) => {
    const message = parsePrompt(rawMessage)
    try {
      await piClientManager.steer(message, images)
    } finally {
      broadcastAgentStatusSnapshot()
    }
  })
  ipcMain.handle('pi:followUp', async (_e, rawMessage: unknown, images?: ImageContent[]) => {
    const message = parsePrompt(rawMessage)
    try {
      await piClientManager.followUp(message, images)
    } finally {
      broadcastAgentStatusSnapshot()
    }
  })
  ipcMain.handle('pi:abort', async () => {
    await piClientManager.abort()
    const identity = piClientManager.getActiveSessionIdentity()
    if (!identity) return
    const cancelled = sessionProjection.cancelPendingApprovals(
      identity.sessionId,
      '用户停止运行，审批已取消',
    )
    persistApprovalAudits(identity.sessionFile, cancelled, 'cancelled approval outcome')
    if (cancelled.length > 0) broadcastSessionProjection()
    broadcastAgentStatusSnapshot()
  })
  ipcMain.handle(
    'pi:extensionUiResponse',
    (_e, response: ExtensionUiResponse) => {
      const identity = piClientManager.getActiveSessionIdentity()
      const requestMethod = piClientManager.getActiveUiRequestMethod(response.id)
      const approval = sessionProjection
        .snapshot()
        .approvals.find((item) => item.id === response.id)
      if (!identity || !canRespondToOwnedUiRequest(identity.sessionId, requestMethod, approval)) {
        throw new Error('扩展 UI 请求已失效或不属于当前会话')
      }
      const { remainingBlockingRequests } = piClientManager.respondExtensionUi(response)
      if (requestMethod === 'confirm') {
        const projected = sessionProjection.resolveApproval(identity.sessionId, response.id, response)
        if (projected.projectionChanged) {
          const decided = sessionProjection.snapshot().approvals.find((item) => item.id === response.id)
          if (decided) persistApprovalAudits(identity.sessionFile, [decided], 'approval decision')
          broadcastSessionProjection()
        }
      }
      agentRuntime.uiResponded(identity.sessionId, remainingBlockingRequests)
      broadcastAgentStatusSnapshot()
    },
  )
  ipcMain.handle('pi:newSession', async () => {
    const result = await piClientManager.newSession()
    if (!result.cancelled) {
      selectActiveSessionProjection()
      broadcastAgentStatusSnapshot()
      refreshSessionProjectionInBackground()
    }
    return result
  })
  ipcMain.handle('pi:getRuntimeSnapshot', () => agentRuntime.snapshot())
  ipcMain.handle('pi:getAgentStatusSnapshot', () => piClientManager.getAgentStatusSnapshot())
  ipcMain.handle('pi:getCapabilities', () => piClientManager.getRuntimeCapabilities())
  ipcMain.handle('pi:getSessionProjection', async () => {
    try {
      return await refreshSessionProjection()
    } catch (error) {
      appendAppLog('warn', 'session.projection', 'Failed to load session projection', normalizeError(error))
      return sessionProjection.snapshot()
    }
  })
  ipcMain.handle('pi:getState', () => piClientManager.getState())
  ipcMain.handle('pi:getArtifactChunk', (_event, artifactId: unknown, offsetChars: unknown) => {
    const parsedArtifactId = parseArtifactId(artifactId)
    const parsedOffsetChars = parseNonNegativeSafeInteger(offsetChars, 'offsetChars')
    const workspacePath = piClientManager.getWorkspacePath()
    const identity = piClientManager.getActiveSessionIdentity()
    if (!workspacePath || !identity) throw new Error('No workspace is open')
    return getAgentArtifacts().readChunk(workspacePath, parsedArtifactId, parsedOffsetChars)
  })
  ipcMain.handle('pi:getAvailableModels', () => piClientManager.getAvailableModels())
  ipcMain.handle('pi:getCommands', () => piClientManager.getCommands())
  ipcMain.handle('pi:setModel', (_e, provider: unknown, modelId: unknown) =>
    piClientManager.setModel(
      parseModelSelection(provider, '模型提供方'),
      parseModelSelection(modelId, '模型 ID'),
    ),
  )
  // 这几个值原样透传给 agent,必须先确认落在枚举内(原来是 `level as never`)
  ipcMain.handle('pi:setThinkingLevel', (_e, level: unknown) =>
    piClientManager.setThinkingLevel(oneOf(level, THINKING_LEVELS, '推理等级') as never),
  )
  ipcMain.handle('pi:setSteeringMode', (_e, mode: unknown) =>
    piClientManager.setSteeringMode(oneOf(mode, QUEUE_MODES, '插话模式')),
  )
  ipcMain.handle('pi:setFollowUpMode', (_e, mode: unknown) =>
    piClientManager.setFollowUpMode(oneOf(mode, QUEUE_MODES, '排队模式')),
  )
  ipcMain.handle('pi:setPermissionMode', (_e, modeId: unknown) =>
    piClientManager.setPermissionMode(requiredString(modeId, '权限模式')),
  )
  ipcMain.handle('pi:setAutoCompaction', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new TypeError('自动压缩开关无效')
    return piClientManager.setAutoCompaction(enabled)
  })
  ipcMain.handle('pi:compact', () => piClientManager.compact())
}
