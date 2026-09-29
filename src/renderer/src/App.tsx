import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp } from 'antd'
import { createStyles } from 'antd-style'
import TitleBar from './components/TitleBar'
import NavRail from './components/NavRail'
import ChatPane from './components/ChatPane'
import RoutinesPage from './components/RoutinesPage'
import ImageGenPage from './components/ImageGenPage'
import Model3DPage from './components/Model3DPage'
import SessionSidebar from './components/SessionSidebar'
import { useAppShortcuts } from './keyboard/use-app-shortcuts'
import DesktopLayoutContainer from './components/DesktopLayoutContainer'
import SettingsModal from './components/SettingsModal'
import WorkspacePicker from './components/WorkspacePicker'
import {
  api,
  type AgentStatusEvent,
  type ExecutionSecuritySnapshot,
  type SandboxMode,
  type Workspace,
} from './lib/api'
import { exportGlobalDiagnostics } from './lib/diagnostics-export'

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

type AgentIssue = Exclude<AgentStatusEvent, { status: 'started' }>
type ActiveView = 'chat' | 'routines' | 'imagegen' | 'model3d'

const useStyles = createStyles(({ token, css }) => ({
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${token.colorBgLayout};
    font-family: ${token.fontFamily};
  `,

  contentRow: css`
    display: flex;
    flex: 1;
    min-height: 0;
  `,
}))

type AppProps = {
  appearance: 'dark' | 'light'
  onToggleTheme: () => void
}

export default function App({ appearance, onToggleTheme }: AppProps) {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<Workspace[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(true)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [restartingAgent, setRestartingAgent] = useState(false)
  const [agentIssue, setAgentIssue] = useState<AgentIssue | null>(null)
  const [diagnosticsExporter, setDiagnosticsExporter] = useState<(() => void) | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  // 当前工作区 agent 的沙箱运行模式(null=直跑主机);来自 agent:status started 事件
  const [sandboxMode, setSandboxMode] = useState<SandboxMode | null>(null)
  const [executionSecurity, setExecutionSecurity] = useState<ExecutionSecuritySnapshot | null>(null)
  // Bumped when the active session changes; remounts ChatPane so it reloads messages.
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const [agentRunning, setAgentRunning] = useState(false)

  useEffect(() => {
    void (async () => {
      let workspaces: Workspace[] = []
      try {
        const [recent, settings] = await Promise.all([api.workspace.list(), api.settings.load()])
        workspaces = recent
        setRecentWorkspaces(recent)
        if (!settings.modelAccessConfigured) {
          setShowWorkspacePicker(false)
          setWorkspaceError('请先配置模型服务 API Key，然后再打开工作区。')
          setShowSettings(true)
          return
        }
      } catch {
        return
      }

      // renderer reload / 重挂载后,main 里的 agent 可能还活着 —— 先取权威快照
      // 恢复工作区与沙箱状态,而不是让用户回到选工作区、agent 却在后台空转。
      const snap = await api.pi.getRuntimeSnapshot().catch(() => null)
      if (snap?.workspacePath && snap.phase !== 'closed' && snap.phase !== 'error') {
        adoptWorkspacePath(snap.workspacePath)
        setSandboxMode(snap.sandbox)
        setExecutionSecurity(snap.security)
        return
      }
      if (snap?.phase === 'error' && snap.error) {
        setWorkspaceError(snap.error.message)
        return
      }

      // 冷启动没有活着的 agent:直接打开最近一个工作区。停在选择器上时,手机远程
      // 连过来每条指令都是 NO_WORKSPACE,而人多半不在电脑前,没法点那一下。
      if (workspaces[0]) await openWorkspace(workspaces[0].path)
    })()

    // agent 是否在跑以 main 的权威快照为准,快捷键条件(Ctrl+.)据此启用
    const offRuntime = api.pi.onRuntime((snap) => {
      setAgentRunning(snap.phase === 'running' || snap.phase === 'awaiting_approval')
      setExecutionSecurity(snap.security)
      // 工作区也可能是手机远程开的,桌面这边得跟上 —— 否则界面停在选择器上,
      // agent 却已经在后台跑起来了。
      if (snap.workspacePath && snap.phase !== 'closed' && snap.phase !== 'error') {
        adoptWorkspacePath(snap.workspacePath)
      }
    })

    const offAvail = api.update.onAvailable(({ version }) =>
      setUpdate({ status: 'available', version }),
    )
    const offDone = api.update.onDownloaded(({ version }) =>
      setUpdate({ status: 'downloaded', version }),
    )
    const offErr = api.update.onError(({ message }) =>
      setUpdate({ status: 'error', message }),
    )

    return () => {
      offRuntime()
      offAvail()
      offDone()
      offErr()
    }
  }, [])

  useEffect(() => {
    const off = api.pi.onStatus((event) => {
      if (!workspace || event.cwd !== workspace.path) return
      if (event.status === 'started') {
        setAgentIssue(null)
        setRestartingAgent(false)
        setSandboxMode(event.sandbox ?? null)
        setExecutionSecurity(event.security ?? null)
        return
      }
      if (event.status === 'exited' && event.expected) return
      setAgentIssue(event)
      setRestartingAgent(false)
      api.win.flash()
    })
    return off
  }, [workspace?.path])

  // UI 已经认下的工作区路径。本地打开和远程打开都更新它,runtime 事件据此分辨
  // 「这是个新工作区」还是「刚才那次打开的回声」,免得白白 remount 一次 ChatPane。
  const adoptedPathRef = useRef<string | null>(null)

  function adoptWorkspacePath(path: string): void {
    if (adoptedPathRef.current === path) return
    adoptedPathRef.current = path
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    setWorkspace({ path, name, lastOpenedAt: new Date().toISOString() })
    setWorkspaceError(null)
    setShowWorkspacePicker(false)
    setSessionEpoch((n) => n + 1)
  }

  // Optimistic open: close the picker immediately and show a "starting"
  // chat pane — the agent subprocess takes 1–3s to boot, and blocking the
  // modal on it reads as a UI freeze.
  async function openWorkspace(path: string) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    setWorkspaceError(null)
    setAgentIssue(null)
    setShowWorkspacePicker(false)
    setOpening(true)
    adoptedPathRef.current = path
    setWorkspace({ path, name, lastOpenedAt: new Date().toISOString() })
    const result = await api.workspace.open(path)
    setOpening(false)
    if ('error' in result) {
      // startWorkspace stops the old subprocess before failing, so no
      // workspace is actually open now — reflect that honestly.
      adoptedPathRef.current = null
      setWorkspace(null)
      setSandboxMode(null)
      setExecutionSecurity(null)
      setWorkspaceError(result.error)
      if (result.error.includes('API Key')) {
        setShowWorkspacePicker(false)
        setShowSettings(true)
      } else {
        setShowWorkspacePicker(true)
      }
      return
    }
    setRecentWorkspaces(result.recentWorkspaces)
    setSessionEpoch((n) => n + 1)
  }

  async function restartAgent() {
    if (!workspace || opening || restartingAgent) return
    setRestartingAgent(true)
    const result = await api.workspace.open(workspace.path)
    setRestartingAgent(false)
    if ('error' in result) {
      setAgentIssue({ status: 'error', cwd: workspace.path, message: result.error })
      return
    }
    setAgentIssue(null)
    setRecentWorkspaces(result.recentWorkspaces)
    setSessionEpoch((n) => n + 1)
  }

  async function removeWorkspace(path: string) {
    const next = await api.workspace.remove(path)
    setRecentWorkspaces(next)
  }

  function closeSettings() {
    setShowSettings(false)
    if (!workspace && !opening) setShowWorkspacePicker(true)
  }

  const exportStartupDiagnostics = useCallback(async () => {
    try {
      const result = await exportGlobalDiagnostics(api)
      if ('error' in result) message.error(result.error)
      else if ('ok' in result) message.success('诊断包已导出')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出诊断包失败')
    }
  }, [message])

  // 动作全部复用页面已有的 command,不另写一套业务逻辑
  useAppShortcuts(
    {
      view: activeView,
      workspace: !!workspace,
      agentRunning,
      modalOpen: showSettings || showWorkspacePicker,
    },
    {
      'view.chat': () => setActiveView('chat'),
      'view.routines': () => setActiveView('routines'),
      'view.imagegen': () => setActiveView('imagegen'),
      'view.model3d': () => setActiveView('model3d'),
      'workspace.open': () => setShowWorkspacePicker(true),
      'settings.toggle': () => setShowSettings((v) => !v),
      'theme.toggle': onToggleTheme,
      'agent.stop': () => void api.pi.abort(),
      'composer.focus': () => {
        const el = document.querySelector<HTMLTextAreaElement>(
          '[data-shortcut-scope="composer"] textarea',
        )
        el?.focus()
      },
    },
  )

  return (
    <div className={styles.shell}>
      <TitleBar
        workspace={workspace}
        sandboxMode={sandboxMode}
        executionSecurity={executionSecurity}
        update={update}
        onInstall={() => api.update.install()}
        onDismissUpdate={() => setUpdate({ status: 'idle' })}
        onSwitchWorkspace={() => setShowWorkspacePicker(true)}
      />

      <div className={styles.contentRow}>
        <NavRail
          workspace={workspace}
          activeView={activeView}
          appearance={appearance}
          onSwitchWorkspace={() => setShowWorkspacePicker(true)}
          onChat={() => setActiveView('chat')}
          onRoutines={() => setActiveView('routines')}
          onImageGen={() => setActiveView('imagegen')}
          onModel3D={() => setActiveView('model3d')}
          onSettings={() => setShowSettings(true)}
          onToggleTheme={onToggleTheme}
        />
        {activeView === 'chat' && workspace && !opening && (
          <SessionSidebar
            workspace={workspace}
            onSessionChanged={() => setSessionEpoch((n) => n + 1)}
          />
        )}
        <DesktopLayoutContainer>
          {/* ChatPane 常驻不卸载(display 切换):agent 长任务运行中切去别的视图再回来,
              运行状态/停止按钮/排队上下文都不能丢 */}
          <div
            style={{
              display: activeView === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <ChatPane
              key={`${workspace?.path ?? ''}#${sessionEpoch}`}
              workspace={workspace}
              starting={opening || restartingAgent}
              agentIssue={agentIssue}
              restarting={restartingAgent}
              onRestartAgent={restartAgent}
              onDiagnosticsExporterChange={(exporter) => setDiagnosticsExporter(() => exporter)}
            />
          </div>
          {activeView === 'routines' && <RoutinesPage workspace={workspace} />}
          {activeView === 'imagegen' && <ImageGenPage />}
          {activeView === 'model3d' && <Model3DPage />}
        </DesktopLayoutContainer>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={closeSettings}
          onExportDiagnostics={diagnosticsExporter ?? exportStartupDiagnostics}
          onSandboxToggled={() => void restartAgent()}
        />
      )}
      {showWorkspacePicker && !showSettings && (
        <WorkspacePicker
          recentWorkspaces={recentWorkspaces}
          currentPath={workspace?.path ?? null}
          opening={opening}
          error={workspaceError}
          onPick={async () => {
            const path = await api.workspace.pickDirectory()
            if (path) openWorkspace(path)
          }}
          onOpen={openWorkspace}
          onRemove={removeWorkspace}
          onClose={() => setShowWorkspacePicker(false)}
        />
      )}
    </div>
  )
}
