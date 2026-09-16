import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import { Alert, App as AntApp, Input, Button, Modal, Select, Switch, Tag, Popconfirm } from 'antd'
import { Activity, Bot, Globe, Info, Trash2, Plus, Image as ImageIcon, Pencil, RefreshCw } from 'lucide-react'
import {
  api,
  type Channel,
  type ChannelType,
  type SettingsView,
  type LlmProviderHealth,
  type LlmProfileWrite,
  type LlmProviderProfile,
  type ProviderConnectionResult,
  type ProviderModelListResult,
  type SandboxDetect,
  type SandboxImageStatus,
  type RemoteControlSnapshot,
  type RemotePairingCode,
  type LocalBackupSummary,
  type RuntimeEventLogSnapshot,
  type RuntimeRunSummary,
} from '../lib/api'
import { createDefaultSettingsView } from '../../../shared/contracts'
import {
  DEEPSEEK_OFFICIAL_MODELS,
  DEEPSEEK_PROFILE_ID,
  createDeepSeekProfileWrite,
} from '../../../shared/deepseek-profile'
import {
  favoriteRouteKey,
  formatFavoriteModelRoutes,
  parseFavoriteModelRoutes,
} from '../../../shared/model-route'
import { formatLlmProfileModels, parseLlmProfileModels } from './llm-profile-models'
import { QRCodeSVG } from 'qrcode.react'

type Settings = SettingsView & { clearCloudImageKey?: boolean }

/** 线路编辑草稿。models 以原始文本持有,保存时才解析 —— 见 llm-profile-models.ts。 */
type LlmProfileDraft = Omit<LlmProfileWrite, 'models'> & { modelsText: string; create: boolean }

// 云端线路管理界面已开放:用于维护 provider 分组、同步模型、查看 Cloudflare Agent health。
// 本地直连已于 2026-08-19 整体退役,不再有可恢复的开关。
const SHOW_CLOUD_LANE_ADMIN: boolean = true

// 安全策略分类已移除(2026-07-17):隔离职责交给沙箱(WSL2+bubblewrap),
// 规则式软拦截(securityGuard/策略编辑器)不再暴露,后端代码保留但不启用。
type Category = 'model' | 'tools' | 'imagegen' | 'about'

const CATEGORIES: { key: Category; label: string; icon: typeof Bot }[] = [
  { key: 'model', label: '模型服务', icon: Bot },
  { key: 'tools', label: '扩展工具', icon: Globe },
  { key: 'imagegen', label: '生图', icon: ImageIcon },
  { key: 'about', label: '关于', icon: Info },
]

function formatBackupLabel(backup: LocalBackupSummary): string {
  const createdAt = new Date(backup.createdAt)
  const timestamp = Number.isNaN(createdAt.getTime()) ? backup.createdAt : createdAt.toLocaleString()
  const kind = backup.kind === 'pre-restore' ? '恢复前保护点' : '每日备份'
  return `${timestamp} · ${kind}${backup.status === 'invalid' ? ' · 已损坏' : ''}`
}

function formatRuntimeTimestamp(value: string | null): string {
  if (!value) return '未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function runtimeRunStatus(run: RuntimeRunSummary): { label: string; color: string } {
  if (run.cleanup?.status === 'error') return { label: '清理失败', color: 'red' }
  if (run.lastEventType === 'run_failed') return { label: '失败', color: 'red' }
  if (run.cleanup) return { label: '已清理', color: 'default' }
  if (run.settledAt) return { label: '已结束', color: 'green' }
  if (run.lastEventAt) return { label: '运行中', color: 'blue' }
  return { label: '已启动', color: 'processing' }
}

function runtimeRunName(run: RuntimeRunSummary): string {
  const kind = run.kind ?? 'unknown'
  const model = run.model ? ` · ${run.model}` : ''
  return `${kind}${model}`
}

function formatLlmProviderHealth(health: LlmProviderHealth): string {
  if (!health.supported) {
    return `这条线路还没有 provider health 端点。\n\n${health.error}`
  }

  const state = health.state
  const routeLines = Object.entries(state.routeStats).map(([routeId, stats]) => {
    const successRate = stats.requestCount > 0
      ? `，成功率 ${Math.round((stats.successCount / stats.requestCount) * 100)}%`
      : ''
    const lastStatus = stats.lastStatus === undefined || stats.lastStatus === null
      ? ''
      : `，最后状态 ${stats.lastStatus}`
    const lastError = stats.lastError ? `，最后错误 ${stats.lastError}` : ''
    return `${routeId}: 请求 ${stats.requestCount}，成功 ${stats.successCount}，失败 ${stats.failureCount}，失败尝试 ${stats.failedAttemptCount}${successRate}${lastStatus}${lastError}`
  })
  const failureLines = state.recentFailures.slice(0, 6).map((failure) => {
    const at = formatRuntimeTimestamp(failure.at ?? null)
    const route = failure.routeId ?? 'unknown-route'
    const model = failure.model ?? 'unknown-model'
    const status = failure.status === undefined ? '无状态码' : `HTTP ${failure.status}`
    const message = failure.message ? `: ${failure.message}` : ''
    return `${at} · ${route} · ${model} · ${status}${message}`
  })

  return [
    `状态: ${health.ok ? 'ok' : 'degraded'}`,
    `总请求: ${state.requestCount}`,
    `失败尝试: ${state.failedAttemptCount}`,
    `最后请求: ${formatRuntimeTimestamp(state.lastRequestAt ?? null)}`,
    `最后路由: ${state.lastRouteId ?? '暂无'}`,
    `暴露模型: ${health.advertisedModels.length}`,
    `上游线路: ${health.upstreams.length}`,
    '',
    'Route stats',
    routeLines.length > 0 ? routeLines.join('\n') : '暂无 route stats',
    '',
    'Recent failures',
    failureLines.length > 0 ? failureLines.join('\n') : '最近没有失败记录',
  ].join('\n')
}

const useStyles = createStyles(({ token, css }) => ({
  main: css`
    display: flex;
    height: 440px;
    margin: 0 -24px;
    border-top: 1px solid ${token.colorBorderSecondary};
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  nav: css`
    width: 148px;
    flex-shrink: 0;
    border-right: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgLayout};
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,

  navItem: css`
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-radius: ${token.borderRadius}px;
    border: none;
    background: transparent;
    color: ${token.colorTextSecondary};
    font-size: 13px;
    font-family: ${token.fontFamily};
    cursor: pointer;
    outline: none;
    text-align: left;
    transition: all ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,

  navItemActive: css`
    background: ${token.colorFillSecondary} !important;
    color: ${token.colorText} !important;
    font-weight: 500;
  `,

  content: css`
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 20px 24px;
  `,

  form: css`
    display: flex;
    flex-direction: column;
    gap: 18px;
  `,

  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,

  label: css`
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  `,

  labelHint: css`
    font-size: 12px;
    font-weight: 400;
    color: ${token.colorTextTertiary};
  `,

  actionRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  `,

  switchItem: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

  aboutRow: css`
    display: flex;
    justify-content: space-between;
    padding: 10px 0;
    font-size: 13px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};

    span:last-child {
      color: ${token.colorText};
    }
  `,

  runtimePanel: css`
    padding: 12px 0 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,

  runtimeHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  `,

  runtimeList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,

  runtimeRun: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  `,

  runtimeRunTop: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  `,

  runtimeRunTitle: css`
    min-width: 0;
    color: ${token.colorText};
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  runtimeRunMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    color: ${token.colorTextTertiary};
    font-size: 12px;
  `,

  runtimePath: css`
    min-width: 0;
    overflow-wrap: anywhere;
  `,

  mono: css`
    font-family: ${token.fontFamilyCode};
  `,

  profileCard: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: ${token.colorBgContainer};
  `,

  profileMeta: css`
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,

}))

export default function SettingsModal({
  onClose,
  onExportDiagnostics,
  onSandboxToggled,
}: {
  onClose: () => void
  onExportDiagnostics?: () => void
  /** 沙箱开关变化且有工作区在开时调用 —— 旧 agent 还跑在旧模式里,需要重启工作区 */
  onSandboxToggled?: () => void
}) {
  const { styles } = useStyles()
  // 静态 message/Modal 消费不到 ThemeProvider 的 context(切主题时不跟着变),
  // 走 App provider 拿实例 —— provider 在 main.tsx 的 <AntApp> 上。
  const { message, modal } = AntApp.useApp()

  const [category, setCategory] = useState<Category>('model')
  const [settings, setSettings] = useState<Settings>(() => createDefaultSettingsView())
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState('')
  const [piVersion, setPiVersion] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchResult, setModelFetchResult] = useState<ProviderModelListResult | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelDraft, setChannelDraft] = useState<Channel | null>(null)
  const [channelTesting, setChannelTesting] = useState<string | null>(null)
  const [channelTestResult, setChannelTestResult] = useState<Record<string, string>>({})
  // 三条执行路径各自的平台:Windows 走 WSL+bwrap(整盘只读、白名单代理),
  // macOS 走系统自带 Seatbelt(只收窄写权限),其余平台才是 Docker。
  // 文案不能互相照抄 —— 它们给的保证不一样。
  const sandboxOnWsl = api.platform === 'win32'
  const sandboxOnSeatbelt = api.platform === 'darwin'
  const sandboxUsesDocker = !sandboxOnWsl && !sandboxOnSeatbelt
  const sandboxFallbackWord = sandboxOnWsl ? '(回退)' : ''
  const [sandboxDetect, setSandboxDetect] = useState<SandboxDetect | null>(null)
  const [sandboxDetecting, setSandboxDetecting] = useState(false)
  const [sandboxImage, setSandboxImage] = useState<SandboxImageStatus | null>(null)
  const [remoteSnap, setRemoteSnap] = useState<RemoteControlSnapshot | null>(null)
  const [pairing, setPairing] = useState<RemotePairingCode | null>(null)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingResetting, setPairingResetting] = useState(false)
  const [sandboxBuilding, setSandboxBuilding] = useState(false)
  const [sandboxBuildLog, setSandboxBuildLog] = useState('')
  const [llmProfiles, setLlmProfiles] = useState<LlmProviderProfile[]>([])
  const [llmProfilesLoading, setLlmProfilesLoading] = useState(false)
  const [llmProfilesError, setLlmProfilesError] = useState('')
  const [llmProfileHealthLoading, setLlmProfileHealthLoading] = useState<string | null>(null)
  const [llmProfileDraft, setLlmProfileDraft] = useState<LlmProfileDraft | null>(null)
  const [llmProfileSaving, setLlmProfileSaving] = useState(false)
  const [deepSeekApiKey, setDeepSeekApiKey] = useState('')
  const [deepSeekSaving, setDeepSeekSaving] = useState(false)
  const [deepSeekResult, setDeepSeekResult] = useState<ProviderConnectionResult | null>(null)
  const [sharedMemoryStatus, setSharedMemoryStatus] = useState<{ url: string; file: string; count: number } | null>(null)
  const [backups, setBackups] = useState<LocalBackupSummary[]>([])
  const [selectedBackup, setSelectedBackup] = useState<string>()
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [backupRestoring, setBackupRestoring] = useState(false)
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeEventLogSnapshot | null>(null)
  const [runtimeDiagnosticsLoading, setRuntimeDiagnosticsLoading] = useState(false)

  async function loadBackups() {
    const listBackups = api.diagnostics.listBackups
    if (!listBackups) return
    setBackupsLoading(true)
    try {
      const result = await listBackups()
      if ('error' in result) {
        message.error(result.error)
        return
      }
      setBackups(result.backups)
      setSelectedBackup((current) => {
        if (current && result.backups.some((backup) => backup.name === current && backup.status === 'ready')) {
          return current
        }
        return result.backups.find((backup) => backup.status === 'ready')?.name
      })
    } catch {
      message.error('读取备份列表失败')
    } finally {
      setBackupsLoading(false)
    }
  }

  async function loadRuntimeDiagnostics() {
    setRuntimeDiagnosticsLoading(true)
    try {
      const result = await api.diagnostics.getLogs()
      setRuntimeDiagnostics(result.runtimeEvents ?? null)
    } catch {
      message.error('读取运行记录失败')
    } finally {
      setRuntimeDiagnosticsLoading(false)
    }
  }

  function restoreSelectedBackup() {
    const restoreBackup = api.diagnostics.restoreBackup
    if (!restoreBackup || !selectedBackup) return
    const backup = backups.find((item) => item.name === selectedBackup)
    modal.confirm({
      title: '恢复本地数据并重启？',
      content: `将恢复到 ${backup ? formatBackupLabel(backup) : selectedBackup}。当前数据会先保存为保护点，应用随后重启。`,
      okText: '恢复并重启',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBackupRestoring(true)
        try {
          const result = await restoreBackup({ name: selectedBackup })
          if ('error' in result) throw new Error(result.error)
          message.loading({ content: '正在重启并恢复数据…', duration: 0, key: 'backup-restore' })
        } catch (error) {
          message.error(error instanceof Error ? error.message : '安排数据恢复失败')
          throw error
        } finally {
          setBackupRestoring(false)
        }
      },
    })
  }

  async function detectSandbox() {
    setSandboxDetecting(true)
    try {
      const [d, img] = await Promise.all([api.sandbox.detect(), api.sandbox.imageStatus()])
      setSandboxDetect(d)
      setSandboxImage(img)
    } catch {
      setSandboxDetect(null)
    } finally {
      setSandboxDetecting(false)
    }
  }

  async function buildSandboxImage() {
    setSandboxBuilding(true)
    setSandboxBuildLog('开始构建镜像（首次约几分钟，拉取 node 基础镜像 + 安装 pi）…')
    const off = api.sandbox.onBuildProgress((line) => setSandboxBuildLog(line))
    try {
      const r = await api.sandbox.buildImage()
      if ('error' in r) {
        setSandboxBuildLog(`构建失败：${r.error}`)
      } else {
        setSandboxBuildLog('构建完成 ✓')
        await detectSandbox()
      }
    } finally {
      off()
      setSandboxBuilding(false)
    }
  }

  useEffect(() => {
    api.settings.load().then(setSettings)
    detectSandbox()
    api.channels.list().then(setChannels).catch(() => {})
    api.app.version().then(setVersion).catch(() => {})
    api.app.piVersion().then(setPiVersion).catch(() => {})
    void loadLlmProfiles()
    api.memory.sharedStatus().then((result) => {
      if ('url' in result) setSharedMemoryStatus({ url: result.url, file: result.file, count: result.count })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    api.remote.getStatus().then(setRemoteSnap).catch(() => {})
    return api.remote.onStatus(setRemoteSnap)
  }, [])

  useEffect(() => {
    if (category === 'about') {
      void loadBackups()
      void loadRuntimeDiagnostics()
    }
  }, [category])

  async function toggleRemote(enabled: boolean) {
    patch({ remoteEnabled: enabled })
    if (!enabled) setPairing(null)
    try {
      setRemoteSnap(await api.remote.setEnabled(enabled))
    } catch {
      /* 状态会通过 onStatus 更新 */
    }
  }

  async function generatePairingCode() {
    setPairingLoading(true)
    try {
      const r = await api.remote.generatePairingCode()
      if ('error' in r) setPairing(null)
      else setPairing(r)
    } finally {
      setPairingLoading(false)
    }
  }

  async function loadLlmProfiles() {
    setLlmProfilesLoading(true)
    setLlmProfilesError('')
    try {
      const result = await api.llmProfiles.list()
      if ('error' in result) {
        setLlmProfilesError(result.error)
        return
      }
      setLlmProfiles(result.profiles)
    } finally {
      setLlmProfilesLoading(false)
    }
  }

  function addLlmProfile() {
    setLlmProfileDraft({
      id: '',
      display_name: '',
      base_url: '',
      api_type: 'openai-completions',
      api_key: '',
      modelsText: '',
      enabled: true,
      sort_order: llmProfiles.length,
      create: true,
    })
  }

  function editLlmProfile(profile: LlmProviderProfile) {
    setLlmProfileDraft({
      id: profile.id,
      display_name: profile.display_name,
      base_url: profile.base_url ?? '',
      api_type: profile.api_type,
      api_key: '',
      modelsText: formatLlmProfileModels(profile.models),
      enabled: profile.enabled,
      sort_order: profile.sort_order,
      create: false,
    })
  }

  async function saveLlmProfile() {
    if (!llmProfileDraft) return
    setLlmProfileSaving(true)
    setLlmProfilesError('')
    try {
      const { create, modelsText, ...rest } = llmProfileDraft
      const profile: LlmProfileWrite = { ...rest, models: parseLlmProfileModels(modelsText) }
      const result = await api.llmProfiles.save(
        create ? { profile, create: true } : { profile, create: false },
      )
      if ('error' in result) {
        setLlmProfilesError(result.error)
        return
      }
      setLlmProfileDraft(null)
      await loadLlmProfiles()
      if (result.warning) setLlmProfilesError(result.warning)
    } finally {
      setLlmProfileSaving(false)
    }
  }

  async function removeLlmProfile(id: string) {
    const result = await api.llmProfiles.delete(id)
    if ('error' in result) setLlmProfilesError(result.error)
    else {
      await loadLlmProfiles()
      if (result.warning) setLlmProfilesError(result.warning)
    }
  }

  async function refreshLlmModels(id: string) {
    setLlmProfilesLoading(true)
    try {
      const result = await api.llmProfiles.refreshModels(id)
      if ('error' in result) setLlmProfilesError(result.error)
      else {
        await loadLlmProfiles()
        // 刷新只做减法:探活剔除调不通的,新模型只报不加(上游一个分组里混着图像和
        // 视频模型,整表覆盖会把它们灌进聊天列表)。两边都得说一声,否则用户只会
        // 看见模型莫名其妙少了几个、或者压根不知道上游出了新模型。
        const dropped = result.profile?.unavailable_models ?? []
        const discovered = result.profile?.new_models ?? []
        if (dropped.length > 0) {
          message.warning(`实际调用不通，已剔除：${dropped.join('、')}`)
        }
        if (discovered.length > 0) {
          message.info(`上游新增（未自动添加，可手动填入）：${discovered.join('、')}`)
        }
        if (dropped.length === 0 && discovered.length === 0) {
          message.success('模型列表已是最新，全部可用')
        }
        if (result.warning) setLlmProfilesError(result.warning)
      }
    } finally {
      setLlmProfilesLoading(false)
    }
  }

  async function showLlmProviderHealth(profile: LlmProviderProfile) {
    setLlmProfileHealthLoading(profile.id)
    setLlmProfilesError('')
    try {
      const result = await api.llmProfiles.providerHealth(profile.id)
      if ('error' in result) {
        setLlmProfilesError(result.error)
        return
      }
      Modal.info({
        title: `${profile.display_name} 线路健康`,
        width: 680,
        content: (
          <pre className={styles.mono} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {formatLlmProviderHealth(result.health)}
          </pre>
        ),
      })
    } finally {
      setLlmProfileHealthLoading(null)
    }
  }

  async function resetRemotePairings() {
    setPairingResetting(true)
    try {
      const result = await api.remote.resetPairings()
      if ('error' in result) {
        message.error(result.error)
        return
      }
      setPairing(null)
      setRemoteSnap((current) => (current ? { ...current, controllers: 0 } : current))
      message.success('已解除所有手机绑定，需要重新配对后才能控制这台电脑')
    } finally {
      setPairingResetting(false)
    }
  }

  async function saveDeepSeekOfficial() {
    const existing = llmProfiles.find((profile) => profile.id === DEEPSEEK_PROFILE_ID)
    const apiKey = deepSeekApiKey.trim()
    if (!existing && !apiKey) return
    setDeepSeekSaving(true)
    setDeepSeekResult(null)
    try {
      const profile = createDeepSeekProfileWrite(
        apiKey,
        existing?.sort_order ?? llmProfiles.length,
      )
      const result = await api.llmProfiles.save(
        existing ? { create: false, profile } : { create: true, profile },
      )
      if ('error' in result) {
        setDeepSeekResult({
          ok: false,
          message: 'DeepSeek 配置失败',
          details: result.error,
        })
        return
      }
      setDeepSeekApiKey('')
      await loadLlmProfiles()
      setSettings((current) => {
        const routes = parseFavoriteModelRoutes(current.favoriteModels, DEEPSEEK_PROFILE_ID)
        const seen = new Set(
          routes.map((route) => favoriteRouteKey(route.provider, route.model)),
        )
        for (const model of DEEPSEEK_OFFICIAL_MODELS) {
          const route = { provider: DEEPSEEK_PROFILE_ID, model }
          const key = favoriteRouteKey(route.provider, route.model)
          if (!seen.has(key)) {
            seen.add(key)
            routes.push(route)
          }
        }
        return { ...current, favoriteModels: formatFavoriteModelRoutes(routes) }
      })
      setDeepSeekResult({
        ok: true,
        message: existing ? 'DeepSeek 官方线路已更新' : 'DeepSeek 官方线路已接入',
        details:
          result.warning ||
          '点击底部“保存设置”后，两个 V4 模型会出现在聊天页的模型切换器中。',
      })
    } catch (error) {
      setDeepSeekResult({
        ok: false,
        message: 'DeepSeek 配置失败',
        details: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDeepSeekSaving(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const saveResult = await api.settings.save(settings)
      onClose()
      // 沙箱开关变了且有工作区在开:旧 agent 还跑在旧模式,自动重启工作区切换生效
      if (saveResult.sandboxChanged && saveResult.workspaceOpen) onSandboxToggled?.()
    } finally {
      setSaving(false)
    }
  }

  function patch(update: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...update }))
    setModelFetchResult(null)
  }


  const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
    'feishu-webhook': '飞书群机器人',
    'feishu-app': '飞书应用',
    'wechat-official': '微信公众号',
    webhook: '通用 Webhook',
    local: '系统通知',
  }

  const emptyChannelDraft = (type: ChannelType): Channel => ({
    id: '',
    name: CHANNEL_TYPE_LABEL[type],
    type,
  })

  const channelDraftComplete = (c: Channel): boolean => {
    if (!c.name.trim()) return false
    if (c.type === 'feishu-webhook' || c.type === 'webhook') return !!c.url?.trim()
    if (c.type === 'feishu-app') return !!c.appId?.trim() && !!c.appSecret?.trim()
    if (c.type === 'wechat-official') return !!c.appId?.trim() && !!c.appSecret?.trim()
    return true
  }

  async function addChannel() {
    if (!channelDraft || !channelDraftComplete(channelDraft)) return
    setChannels(await api.channels.save([...channels, channelDraft]))
    setChannelDraft(null)
  }

  async function removeChannel(id: string) {
    setChannels(await api.channels.save(channels.filter((c) => c.id !== id)))
  }

  async function testChannel(channel: Channel) {
    const key = channel.id || 'draft'
    setChannelTesting(key)
    setChannelTestResult((prev) => ({ ...prev, [key]: '' }))
    try {
      const result = await api.channels.test(channel)
      setChannelTestResult((prev) => ({
        ...prev,
        [key]: 'ok' in result ? '✅ 已发送' : `❌ ${result.error}`,
      }))
    } catch (err) {
      setChannelTestResult((prev) => ({ ...prev, [key]: `❌ ${(err as Error).message ?? String(err)}` }))
    } finally {
      setChannelTesting(null)
    }
  }

  async function handleFetchModels() {
    setFetchingModels(true)
    setModelFetchResult(null)
    try {
      const result = await api.settings.listCloudModels({
        relay: settings.cloudImageRelay,
        key: settings.cloudImageKey,
      })
      setModelFetchResult(result)
      if (result.ok) {
        setSettings((s) => ({ ...s, favoriteModels: result.models.join(',') }))
      }
    } catch (err) {
      setModelFetchResult({
        ok: false,
        message: '模型读取失败',
        details: (err as Error).message ?? String(err),
      })
    } finally {
      setFetchingModels(false)
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      title="设置"
      width={680}
      centered
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>
          保存设置
        </Button>,
      ]}
    >
      <div className={styles.main}>
        <div className={styles.nav}>
          {CATEGORIES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={cx(styles.navItem, category === key && styles.navItemActive)}
              onClick={() => setCategory(key)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {category === 'model' && (
            <div className={styles.form}>
              <div className={styles.section}>
                <span className={styles.label}>
                  Pi Studio 云服务
                  <span className={styles.labelHint}>这里只保存应用令牌；3A、OpenRouter 等上游 Key 加密存储在服务器</span>
                </span>
                <Input
                  value={settings.cloudImageRelay}
                  onChange={(e) => patch({ cloudImageRelay: e.target.value })}
                  placeholder="https://trail-api.glanger.xyz（留空使用内置地址）"
                />
                <Input.Password
                  value={settings.cloudImageKey}
                  onChange={(e) =>
                    patch({
                      cloudImageKey: e.target.value,
                      clearCloudImageKey: false,
                    })
                  }
                  placeholder={
                    settings.cloudImageKeyConfigured && !settings.clearCloudImageKey
                      ? '已配置；输入新令牌可替换'
                      : 'Pi Studio 应用令牌'
                  }
                />
                {settings.cloudImageKeyConfigured && !settings.clearCloudImageKey && (
                  <Button
                    size="small"
                    danger
                    onClick={() =>
                      patch({
                        cloudImageKey: '',
                        cloudImageKeyConfigured: false,
                        clearCloudImageKey: true,
                      })
                    }
                  >
                    清除已保存令牌
                  </Button>
                )}
                <span className={styles.labelHint}>模型线路由云端统一下发，无需在本地配置。</span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  DeepSeek 官方 API
                  {llmProfiles.some((profile) => profile.id === DEEPSEEK_PROFILE_ID) && (
                    <Tag color="green">已接入</Tag>
                  )}
                  <span className={styles.labelHint}>
                    Key 仅发送到 Pi Studio 云服务并加密保存，不会写入本机模型配置。
                  </span>
                </span>
                <Input.Password
                  value={deepSeekApiKey}
                  onChange={(event) => {
                    setDeepSeekApiKey(event.target.value)
                    setDeepSeekResult(null)
                  }}
                  placeholder={
                    llmProfiles.some((profile) => profile.id === DEEPSEEK_PROFILE_ID)
                      ? '已配置；输入新 Key 可替换，留空可刷新线路配置'
                      : 'sk-…（DeepSeek 开放平台 API Key）'
                  }
                />
                <div className={styles.actionRow}>
                  <Button
                    size="small"
                    type="primary"
                    loading={deepSeekSaving}
                    disabled={
                      !deepSeekApiKey.trim() &&
                      !llmProfiles.some((profile) => profile.id === DEEPSEEK_PROFILE_ID)
                    }
                    onClick={saveDeepSeekOfficial}
                  >
                    {llmProfiles.some((profile) => profile.id === DEEPSEEK_PROFILE_ID)
                      ? '更新线路'
                      : '接入 DeepSeek'}
                  </Button>
                  <span className={styles.labelHint}>
                    {DEEPSEEK_OFFICIAL_MODELS.join(' · ')}
                  </span>
                </div>
                {deepSeekResult && (
                  <Alert
                    type={deepSeekResult.ok ? 'success' : 'error'}
                    showIcon
                    message={deepSeekResult.message}
                    description={deepSeekResult.details}
                  />
                )}
              </div>

              {SHOW_CLOUD_LANE_ADMIN && (
              <div className={styles.section}>
                <span className={styles.label}>
                  云端模型线路
                  <span className={styles.labelHint}>每条线路会成为模型切换器中的一个 provider 分组</span>
                </span>
                <div className={styles.actionRow}>
                  <Button size="small" type="primary" icon={<Plus size={13} />} onClick={addLlmProfile}>
                    添加线路
                  </Button>
                  <Button size="small" icon={<RefreshCw size={13} />} loading={llmProfilesLoading} onClick={loadLlmProfiles}>
                    刷新
                  </Button>
                </div>
                {llmProfilesError && <Alert type="warning" showIcon message={llmProfilesError} />}
                {llmProfiles.map((profile) => (
                  <div className={styles.profileCard} key={profile.id}>
                    <div className={styles.profileMeta}>
                      <div>
                        <strong>{profile.display_name}</strong>{' '}
                        <Tag color={profile.enabled ? 'green' : 'default'}>{profile.id}</Tag>
                      </div>
                      <span className={styles.labelHint}>
                        {profile.models.length > 0 ? profile.models.join(' · ') : '尚未配置模型'}
                      </span>
                    </div>
                    <div className={styles.actionRow} style={{ flexWrap: 'nowrap' }}>
                      <Button
                        size="small"
                        title="查看 provider health"
                        icon={<Activity size={13} />}
                        loading={llmProfileHealthLoading === profile.id}
                        onClick={() => showLlmProviderHealth(profile)}
                      />
                      <Button size="small" title="从上游 /models 同步" icon={<RefreshCw size={13} />} onClick={() => refreshLlmModels(profile.id)} />
                      <Button size="small" title="编辑" icon={<Pencil size={13} />} onClick={() => editLlmProfile(profile)} />
                      <Popconfirm title="删除这条模型线路？" onConfirm={() => removeLlmProfile(profile.id)}>
                        <Button size="small" danger icon={<Trash2 size={13} />} />
                      </Popconfirm>
                    </div>
                  </div>
                ))}
              </div>
              )}


              <div className={styles.section}>
                <span className={styles.label}>
                  模型切换列表
                  <span className={styles.labelHint}>使用 provider::model，避免不同线路的同名模型串线；留空显示每家最新 8 个</span>
                </span>
                <div className={styles.actionRow}>
                  <Button size="small" onClick={handleFetchModels} loading={fetchingModels}>
                    从云端拉取模型
                  </Button>
                  <span className={styles.labelHint}>
                    读取 Pi Studio 云端已启用的模型线路。
                  </span>
                </div>
                <Input.TextArea
                  value={settings.favoriteModels}
                  onChange={(e) => patch({ favoriteModels: e.target.value })}
                  placeholder="openai::gpt-5.4, three-a-main::gpt-5.5"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
                {modelFetchResult && (
                  <Alert
                    type={modelFetchResult.ok ? 'success' : 'error'}
                    showIcon
                    message={modelFetchResult.message}
                    description={modelFetchResult.ok ? undefined : modelFetchResult.details}
                  />
                )}
              </div>
            </div>
          )}

          {category === 'tools' && (
            <div className={styles.form}>
              <div className={styles.section}>
                <span className={styles.label}>
                  联网搜索（Tavily API Key）
                  <span className={styles.labelHint}>配置后 agent 获得 web_search 工具；留空关闭</span>
                </span>
                <Input.Password
                  value={settings.tavilyApiKey}
                  onChange={(e) => patch({ tavilyApiKey: e.target.value })}
                  placeholder="tvly-…"
                />
                <span className={styles.labelHint}>
                  修改后需重新打开工作区生效。agent 会在需要实时信息（新闻、版本号、文档）时自行调用搜索。
                </span>
              </div>


              <div className={styles.section}>
                <span className={styles.label}>
                  跨 Agent 共享记忆
                  <Tag color="green">本地</Tag>
                </span>
                <span className={styles.labelHint}>
                  Pi Studio、其他 Pi 进程和外部 Agent 可通过本地 Memory Service 共享事实、偏好、决策和命令。只监听 127.0.0.1，不会自动上传云端。
                </span>
                <div className={styles.actionRow}>
                  <Tag color={sharedMemoryStatus ? 'green' : 'red'}>{sharedMemoryStatus ? `运行中 · ${sharedMemoryStatus.count} 条` : '未启动'}</Tag>
                  <Button size="small" onClick={() => api.memory.sharedStatus().then((result) => {
                    if ('url' in result) setSharedMemoryStatus({ url: result.url, file: result.file, count: result.count })
                  })}>刷新</Button>
                </div>
                {sharedMemoryStatus && <span className={styles.labelHint}>数据文件：{sharedMemoryStatus.file}</span>}
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  通知渠道
                  <span className={styles.labelHint}>工作流通知节点和兜底通知的推送目标；改动即时保存</span>
                </span>
                {channels.map((c) => {
                  const key = c.id || 'draft'
                  return (
                    <div key={c.id} className={styles.actionRow}>
                      <Tag>{CHANNEL_TYPE_LABEL[c.type]}</Tag>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </span>
                      {channelTestResult[key] && <span className={styles.labelHint}>{channelTestResult[key]}</span>}
                      <Button size="small" loading={channelTesting === key} onClick={() => testChannel(c)}>
                        测试
                      </Button>
                      <Popconfirm title="删除这个渠道?" onConfirm={() => removeChannel(c.id)}>
                        <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                      </Popconfirm>
                    </div>
                  )
                })}
                {!channelDraft && (
                  <div className={styles.actionRow}>
                    <Button size="small" type="dashed" icon={<Plus size={13} />} onClick={() => setChannelDraft(emptyChannelDraft('feishu-webhook'))}>
                      添加渠道
                    </Button>
                  </div>
                )}
                {channelDraft && (
                  <>
                    <div className={styles.actionRow}>
                      <Select
                        value={channelDraft.type}
                        onChange={(type: ChannelType) => setChannelDraft({ ...emptyChannelDraft(type), name: channelDraft.name })}
                        style={{ width: 150 }}
                        options={(Object.keys(CHANNEL_TYPE_LABEL) as ChannelType[]).map((t) => ({
                          value: t,
                          label: CHANNEL_TYPE_LABEL[t],
                        }))}
                      />
                      <Input
                        value={channelDraft.name}
                        onChange={(e) => setChannelDraft({ ...channelDraft, name: e.target.value })}
                        placeholder="渠道名称"
                      />
                    </div>
                    {(channelDraft.type === 'feishu-webhook' || channelDraft.type === 'webhook') && (
                      <Input
                        value={channelDraft.url ?? ''}
                        onChange={(e) => setChannelDraft({ ...channelDraft, url: e.target.value })}
                        placeholder={
                          channelDraft.type === 'feishu-webhook'
                            ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
                            : 'https://…(收到 {title,status,markdown,imageUrls} JSON)'
                        }
                      />
                    )}
                    {channelDraft.type === 'feishu-webhook' && (
                      <Input.Password
                        value={channelDraft.secret ?? ''}
                        onChange={(e) => setChannelDraft({ ...channelDraft, secret: e.target.value })}
                        placeholder="加签密钥（机器人开了「签名校验」才需要，否则留空）"
                      />
                    )}
                    {channelDraft.type === 'feishu-app' && (
                      <>
                        <Input
                          value={channelDraft.appId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appId: e.target.value })}
                          placeholder="App ID（cli_…，应用需开机器人能力+im:message 并拉进群）"
                        />
                        <Input.Password
                          value={channelDraft.appSecret ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appSecret: e.target.value })}
                          placeholder="App Secret"
                        />
                        <Input
                          value={channelDraft.chatId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, chatId: e.target.value })}
                          placeholder="群 chat_id（oc_…，留空自动用机器人所在的第一个群）"
                        />
                        <Input
                          value={channelDraft.folderToken ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, folderToken: e.target.value })}
                          placeholder="云文档文件夹 token（分享链接中 /folder/ 后的字符串）"
                        />
                      </>
                    )}
                    {channelDraft.type === 'wechat-official' && (
                      <>
                        <Input
                          value={channelDraft.appId ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appId: e.target.value })}
                          placeholder="微信公众号 AppID（wx…）"
                        />
                        <Input.Password
                          value={channelDraft.appSecret ?? ''}
                          onChange={(e) => setChannelDraft({ ...channelDraft, appSecret: e.target.value })}
                          placeholder="微信公众号 AppSecret"
                        />
                        <span className={styles.labelHint}>
                          先配置开发者权限和服务器 IP 白名单；此渠道只创建草稿，不会自动群发。
                        </span>
                      </>
                    )}
                    <div className={styles.actionRow}>
                      <Button size="small" type="primary" disabled={!channelDraftComplete(channelDraft)} onClick={addChannel}>
                        添加
                      </Button>
                      <Button
                        size="small"
                        loading={channelTesting === 'draft'}
                        disabled={!channelDraftComplete(channelDraft)}
                        onClick={() => testChannel(channelDraft)}
                      >
                        先测试
                      </Button>
                      {channelTestResult['draft'] && <span className={styles.labelHint}>{channelTestResult['draft']}</span>}
                      <Button size="small" onClick={() => setChannelDraft(null)}>
                        取消
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  子 agent 工作流
                  <span className={styles.labelHint}>启用 scout / planner / worker / reviewer 和斜杠命令</span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.subagentsEnabled}
                    onChange={(checked) => patch({ subagentsEnabled: checked })}
                  />
                  <span className={styles.labelHint}>{settings.subagentsEnabled ? '已开启' : '已关闭'}</span>
                </div>
                <span className={styles.labelHint}>
                  修改后需重新打开工作区生效。默认提供 /implement、/scout-and-plan、/implement-and-review，用独立
                  pi 子进程分担代码侦察、规划、实现和审查。
                </span>
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  远程控制（手机）
                  <Tag color="orange" style={{ marginLeft: 8 }}>
                    实验性
                  </Tag>
                  <span className={styles.labelHint}>
                    手机经中转连上这台 app,远程发指令让 agent 写代码/跑命令
                  </span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.remoteEnabled}
                    onChange={(checked) => void toggleRemote(checked)}
                  />
                  <span className={styles.labelHint}>
                    {!settings.remoteEnabled
                      ? '已关闭'
                      : remoteSnap?.status === 'connected'
                        ? `已连接中转${remoteSnap.controllers > 0 ? ` · ${remoteSnap.controllers} 部手机在线` : ''}`
                        : remoteSnap?.status === 'connecting'
                          ? '连接中转中…'
                          : remoteSnap?.status === 'error'
                            ? `连接失败:${remoteSnap.lastError}`
                            : '已开启'}
                  </span>
                </div>
                {settings.remoteEnabled && remoteSnap?.status === 'connected' && (
                  <div className={styles.actionRow}>
                    <Button
                      size="small"
                      type="primary"
                      loading={pairingLoading}
                      onClick={() => void generatePairingCode()}
                    >
                      添加到手机
                    </Button>
                    {pairing && (
                      <>
                        <div
                          style={{
                            background: '#fff',
                            borderRadius: 8,
                            padding: 8,
                            lineHeight: 0,
                          }}
                        >
                          <QRCodeSVG value={pairing.qrPayload} size={112} />
                        </div>
                        <span
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            letterSpacing: 4,
                            fontFamily: 'monospace',
                          }}
                        >
                          {pairing.code}
                        </span>
                        <span className={styles.labelHint}>
                          手机扫码或在 5 分钟内输入，可继续添加其他电脑
                        </span>
                      </>
                    )}
                  </div>
                )}
                <div className={styles.actionRow}>
                  <Popconfirm
                    title="解除所有已配对手机？"
                    description="旧手机令牌会立即失效，之后需要重新生成配对码。"
                    okText="解除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void resetRemotePairings()}
                  >
                    <Button size="small" danger loading={pairingResetting}>
                      解除所有已配对手机
                    </Button>
                  </Popconfirm>
                </div>
                <Alert
                  type="warning"
                  showIcon
                  message="手机账户可以绑定多台 Mac 或 Windows 电脑。远程控制能在这台机器上运行 agent、修改代码和执行命令，请勿向他人泄露配对码。"
                />
              </div>

              <div className={styles.section}>
                <span className={styles.label}>
                  {sandboxOnWsl
                    ? '沙箱模式（WSL2 + bubblewrap）'
                    : sandboxOnSeatbelt
                      ? '沙箱模式（macOS 原生）'
                      : '沙箱模式（Docker）'}
                  <Tag color="orange" style={{ marginLeft: 8 }}>
                    实验性
                  </Tag>
                  <span className={styles.labelHint}>
                    {sandboxOnWsl
                      ? 'agent 跑在隔离的 WSL 发行版里:文件只写工作区,出站经主机白名单代理'
                      : sandboxOnSeatbelt
                        ? 'agent 只能写工作区、agent 目录和临时目录;出站经主机白名单代理'
                        : 'agent 跑在 Docker 容器里:只挂载工作区与 agent 目录'}
                  </span>
                </span>
                <div className={styles.actionRow}>
                  <Switch
                    size="small"
                    checked={settings.sandboxEnabled}
                    onChange={(checked) => patch({ sandboxEnabled: checked })}
                  />
                  <span className={styles.labelHint}>
                    {settings.sandboxEnabled ? '已开启' : '已关闭'}
                  </span>
                </div>
                <Alert
                  type={sandboxUsesDocker ? 'warning' : 'info'}
                  showIcon
                  message={
                    sandboxOnWsl
                      ? '发行版就绪即用 WSL 沙箱,否则回退 Docker。'
                      : sandboxOnSeatbelt
                        ? '用系统自带的 sandbox-exec,无需 Docker。写权限收窄到工作区,出站经主机白名单代理。'
                        : '本平台只能走 Docker,需要 daemon 在跑且镜像已构建。这条链路已封存,开启可能导致聊天不可用。'
                  }
                  description="保存后自动重启当前工作区生效;沙箱运行中标题栏有标识。详见 docs/sandbox-mode-plan.md。"
                />
                {settings.sandboxEnabled && !sandboxUsesDocker && (
                  <div className={styles.section}>
                    <span className={styles.label}>额外放行域名</span>
                    <Input.TextArea
                      value={(settings.sandboxAllowedHosts ?? []).join('\n')}
                      onChange={(e) =>
                        patch({ sandboxAllowedHosts: e.target.value.split('\n') })
                      }
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      placeholder={'每行一个域名，例如\ngithub.com\npypi.org'}
                    />
                    <span className={styles.labelHint}>
                      出站白名单代理只放行内置名单和这里列出的域名；保存后重启工作区生效。
                    </span>
                  </div>
                )}
                <div className={styles.actionRow}>
                  <span className={styles.label}>环境</span>
                  <Button size="small" loading={sandboxDetecting} onClick={detectSandbox}>
                    重新检测
                  </Button>
                </div>
                <div className={styles.actionRow}>
                  {sandboxOnSeatbelt && (
                    <Tag color={sandboxDetect?.seatbelt ? 'green' : 'default'}>
                      {sandboxDetect
                        ? sandboxDetect.seatbelt
                          ? 'macOS 沙箱可用(sandbox-exec)'
                          : 'macOS 沙箱不可用'
                        : '检测中…'}
                    </Tag>
                  )}
                  {sandboxOnWsl && (
                    <Tag color={sandboxDetect?.wslSandboxReady ? 'green' : 'default'}>
                      {sandboxDetect
                        ? sandboxDetect.wslSandboxReady
                          ? 'WSL 沙箱发行版就绪(pi-studio-sandbox)'
                          : 'WSL 沙箱发行版未准备'
                        : 'WSL 检测中…'}
                    </Tag>
                  )}
                  {!sandboxOnSeatbelt && (
                    <>
                      <Tag color={sandboxDetect?.docker.daemonRunning ? 'green' : 'default'}>
                        {sandboxDetect
                          ? sandboxDetect.docker.daemonRunning
                            ? `Docker${sandboxFallbackWord}可用 v${sandboxDetect.docker.version}`
                            : sandboxDetect.docker.cliFound
                              ? `Docker${sandboxFallbackWord}未运行`
                              : `无 Docker${sandboxFallbackWord}`
                          : 'Docker 检测中…'}
                      </Tag>
                      <Tag color={sandboxImage?.exists ? 'green' : 'default'}>
                        {sandboxImage
                          ? sandboxImage.exists
                            ? '沙箱镜像已就绪'
                            : '沙箱镜像未构建'
                          : '镜像检测中…'}
                      </Tag>
                    </>
                  )}
                </div>
                {sandboxOnWsl && sandboxDetect && !sandboxDetect.wslSandboxReady && (
                  <span className={styles.labelHint}>
                    准备发行版(一次性,约 1 分钟):详见 docs/sandbox-mode-plan.md 或
                    src/main/sandbox-wsl.ts 头注释里的三条命令。
                  </span>
                )}
                {!sandboxOnSeatbelt && sandboxDetect?.docker.daemonRunning && !sandboxImage?.exists && (
                  <div className={styles.actionRow}>
                    <Button size="small" type="primary" loading={sandboxBuilding} onClick={buildSandboxImage}>
                      构建镜像
                    </Button>
                    <span className={styles.labelHint}>首次约几分钟，之后复用</span>
                  </div>
                )}
                {sandboxBuildLog && (
                  <span className={styles.labelHint} style={{ wordBreak: 'break-all' }}>
                    {sandboxBuildLog}
                  </span>
                )}
              </div>
            </div>
          )}

          {category === 'imagegen' && (
            <div className={styles.form}>
              {/* 本地 ComfyUI 配置已移除(2026-07-17):生图全走服务端 */}
              <div className={styles.section}>
                <span className={styles.label}>
                  默认模型
                  <span className={styles.labelHint}>生图页打开时默认选中的云端模型</span>
                </span>
                <Select
                  value={settings.imageEngine || 'openai'}
                  onChange={(v) => patch({ imageEngine: v as 'openai' | 'gemini' | 'grok' })}
                  style={{ width: 220 }}
                  options={[
                    { value: 'openai', label: 'GPT Image 2' },
                    { value: 'gemini', label: 'Gemini Image' },
                  ]}
                />
              </div>
            </div>
          )}

          {category === 'about' && (
            <div>
              <div className={styles.aboutRow}>
                <span>版本</span>
                <span>v{version || '…'}</span>
              </div>
              <div className={styles.aboutRow}>
                <span>pi 引擎</span>
                <span>{piVersion ? `v${piVersion}` : '…'}</span>
              </div>
              <div className={styles.aboutRow}>
                <span>自动更新</span>
                <span>启动时及每 4 小时检查，后台静默安装</span>
              </div>
              <div className={styles.aboutRow}>
                <span>项目</span>
                <span>GreenBeanLiu/pi-studio-desktop</span>
              </div>
              <div className={styles.aboutRow}>
                <span>诊断包</span>
                <Button
                  size="small"
                  disabled={!onExportDiagnostics}
                  onClick={onExportDiagnostics}
                >
                  导出
                </Button>
              </div>
              <div className={styles.aboutRow}>
                <span>数据恢复</span>
                <div className={styles.actionRow}>
                  <Select
                    size="small"
                    value={selectedBackup}
                    loading={backupsLoading}
                    disabled={!api.diagnostics.listBackups}
                    placeholder={api.diagnostics.listBackups ? '暂无可用备份' : '当前版本暂不支持'}
                    onChange={setSelectedBackup}
                    style={{ width: 270 }}
                    options={backups.map((backup) => ({
                      value: backup.name,
                      label: formatBackupLabel(backup),
                      disabled: backup.status !== 'ready',
                      title: backup.error,
                    }))}
                  />
                  <Button
                    size="small"
                    icon={<RefreshCw size={13} />}
                    loading={backupsLoading}
                    disabled={!api.diagnostics.listBackups}
                    onClick={() => void loadBackups()}
                  />
                  <Button
                    size="small"
                    danger
                    loading={backupRestoring}
                    disabled={!api.diagnostics.restoreBackup || !selectedBackup}
                    onClick={restoreSelectedBackup}
                  >
                    恢复并重启
                  </Button>
                </div>
              </div>
              <div className={styles.runtimePanel}>
                <div className={styles.runtimeHeader}>
                  <span className={styles.label}>
                    最近运行
                    {runtimeDiagnostics?.truncated && <Tag color="default">尾部记录</Tag>}
                    {runtimeDiagnostics?.invalidLines ? (
                      <Tag color="orange">{runtimeDiagnostics.invalidLines} 行无效</Tag>
                    ) : null}
                  </span>
                  <Button
                    size="small"
                    icon={<RefreshCw size={13} />}
                    loading={runtimeDiagnosticsLoading}
                    title="刷新运行记录"
                    aria-label="刷新运行记录"
                    onClick={() => void loadRuntimeDiagnostics()}
                  />
                </div>
                {runtimeDiagnostics?.readError && (
                  <Alert
                    type="warning"
                    showIcon
                    message="运行记录读取失败"
                    description={runtimeDiagnostics.readError}
                  />
                )}
                {!runtimeDiagnosticsLoading && !runtimeDiagnostics?.readError && (
                  <div className={styles.runtimeList}>
                    {(runtimeDiagnostics?.runs ?? []).slice(0, 5).map((run) => {
                      const status = runtimeRunStatus(run)
                      return (
                        <div key={run.runId} className={styles.runtimeRun}>
                          <div className={styles.runtimeRunTop}>
                            <span className={styles.runtimeRunTitle} title={runtimeRunName(run)}>
                              {runtimeRunName(run)}
                            </span>
                            <Tag color={status.color}>{status.label}</Tag>
                          </div>
                          <div className={styles.runtimeRunMeta}>
                            <span>事件 {run.eventCount}</span>
                            <span>最后 {run.lastEventType ?? '无事件'}</span>
                            <span>启动 {formatRuntimeTimestamp(run.startedAt)}</span>
                            <span>更新 {formatRuntimeTimestamp(run.lastEventAt)}</span>
                            {run.profileDigest && (
                              <span className={styles.mono}>profile {run.profileDigest}</span>
                            )}
                          </div>
                          {run.cwd && (
                            <span className={cx(styles.labelHint, styles.runtimePath)}>
                              {run.cwd}
                            </span>
                          )}
                        </div>
                      )
                    })}
                    {!runtimeDiagnostics?.runs.length && (
                      <span className={styles.labelHint}>暂无运行记录</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Modal
        open={!!llmProfileDraft}
        title={llmProfileDraft?.create ? '添加模型线路' : '编辑模型线路'}
        onCancel={() => setLlmProfileDraft(null)}
        onOk={saveLlmProfile}
        okText="保存线路"
        confirmLoading={llmProfileSaving}
        okButtonProps={{
          disabled:
            !llmProfileDraft?.id.trim() ||
            !llmProfileDraft?.display_name.trim() ||
            !llmProfileDraft?.base_url.trim() ||
            (!!llmProfileDraft?.create && !llmProfileDraft?.api_key.trim()),
        }}
      >
        {llmProfileDraft && (
          <div className={styles.form}>
            <div className={styles.section}>
              <span className={styles.label}>线路 ID</span>
              <Input
                value={llmProfileDraft.id}
                disabled={!llmProfileDraft.create}
                onChange={(e) => setLlmProfileDraft((draft) => draft && ({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                placeholder="three-a-grok"
              />
            </div>
            <div className={styles.section}>
              <span className={styles.label}>显示名称</span>
              <Input value={llmProfileDraft.display_name} onChange={(e) => setLlmProfileDraft((draft) => draft && ({ ...draft, display_name: e.target.value }))} placeholder="3A Grok" />
            </div>
            <div className={styles.section}>
              <span className={styles.label}>上游 API Base URL</span>
              <Input value={llmProfileDraft.base_url} onChange={(e) => setLlmProfileDraft((draft) => draft && ({ ...draft, base_url: e.target.value }))} placeholder="https://api.example.com/v1" />
            </div>
            <div className={styles.section}>
              <span className={styles.label}>
                上游 API Key
                {!llmProfileDraft.create && <span className={styles.labelHint}>留空保留原 Key</span>}
              </span>
              <Input.Password value={llmProfileDraft.api_key} onChange={(e) => setLlmProfileDraft((draft) => draft && ({ ...draft, api_key: e.target.value }))} placeholder="sk-…" />
            </div>
            <div className={styles.section}>
              <span className={styles.label}>可用模型</span>
              <Input.TextArea
                value={llmProfileDraft.modelsText}
                onChange={(e) => setLlmProfileDraft((draft) => draft && ({ ...draft, modelsText: e.target.value }))}
                placeholder={'grok-4\ngrok-4-fast'}
                autoSize={{ minRows: 3, maxRows: 7 }}
              />
              <span className={styles.labelHint}>每行一个；保存后也可以点击线路右侧刷新按钮从上游 /models 自动读取。</span>
            </div>
            <div className={styles.section}>
              <span className={styles.switchItem}>
                <Switch size="small" checked={llmProfileDraft.enabled} onChange={(enabled) => setLlmProfileDraft((draft) => draft && ({ ...draft, enabled }))} />
                在模型切换器中启用
              </span>
            </div>
          </div>
        )}
      </Modal>
    </Modal>
  )
}
