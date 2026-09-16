import { app, shell, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
// electron-updater 是 CJS 包,ESM 下不能具名导入,走默认导入再解构
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { registerIpcHandlers } from './ipc'
import { clearAllGitRunChanges } from './git-diff'
import { piClientManager } from './pi-client'
import { remoteControl } from './remote-control'
import { ToolReceiptLedger } from './tool-receipts'
import { loadSettings } from './settings'
import { appendAppLog, attachWindowLoggers, installProcessLoggers, normalizeError } from './app-log'
import { isMissingUpdateChannel } from './update-error'
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from './network-policy'
import { cleanupStaleRunChangeTempDirs } from './run-change-set'
import { syncBundledExtensions, syncBundledSkills } from './bundled-agent-resources'
import { startSharedMemoryService, stopSharedMemoryService } from './shared-memory'
import { registerWebSearchRelay } from './web-search-extension'
import { sharedMemoryPath } from './workspace-memory'
import { applyPendingDataRestore, createStartupDataBackup } from './local-data-backup'
import { createQuitGuard, DEFAULT_QUIT_CLEANUP_TIMEOUT_MS } from './quit-cleanup'

// 无桌面会话环境下的调试口子:PI_REMOTE_DEBUG_PORT=9223 pnpm dev 后可用 CDP 驱动/截图
if (process.env.PI_REMOTE_DEBUG_PORT)
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_REMOTE_DEBUG_PORT)

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_RETRY_DELAY_MS = 30 * 1000
const UPDATE_MAX_RETRIES = 3

let tray: Tray | null = null
let isQuitting = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(win: BrowserWindow): void {
  if (process.platform !== 'win32' || tray) return

  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    appendAppLog('warn', 'app', 'Tray icon is unavailable', { iconPath })
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('pi-studio')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 pi-studio', click: () => showMainWindow(win) },
      { type: 'separator' },
      {
        label: '退出 pi-studio',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => {
    if (win.isVisible()) win.hide()
    else showMainWindow(win)
  })
}

// App-level (not per-window): autoUpdater listeners and the update:install
// handler must only ever be registered once, so this can't live in
// createWindow.
function setupAutoUpdater(): void {
  let retryCount = 0
  let retryTimer: NodeJS.Timeout | null = null
  let checkInFlight = false

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null // suppress default logger noise

  const isTransientUpdateError = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err)
    return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(
      message,
    )
  }

  const scheduleRetry = (err: unknown): boolean => {
    if (!isTransientUpdateError(err) || retryCount >= UPDATE_MAX_RETRIES) return false
    retryCount += 1
    if (retryTimer) clearTimeout(retryTimer)
    appendAppLog('warn', 'updater', 'Update check transient failure; retrying', {
      error: normalizeError(err),
      retryCount,
      retryDelayMs: UPDATE_RETRY_DELAY_MS,
    })
    retryTimer = setTimeout(() => {
      retryTimer = null
      check()
    }, UPDATE_RETRY_DELAY_MS)
    return true
  }

  autoUpdater.on('update-available', (info) => {
    retryCount = 0
    appendAppLog('info', 'updater', 'Update available', { version: info.version })
    broadcast('update:available', { version: info.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    retryCount = 0
    appendAppLog('info', 'updater', 'Update downloaded', { version: info.version })
    broadcast('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    if (isMissingUpdateChannel(err)) {
      appendAppLog('info', 'updater', 'No update channel for this platform; skipping', {
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (checkInFlight) {
      appendAppLog('warn', 'updater', 'Auto update emitted an error during active check', normalizeError(err))
      return
    }
    if (scheduleRetry(err)) return
    appendAppLog('error', 'updater', 'Auto update failed', normalizeError(err))
    broadcast('update:error', { message: err.message ?? String(err) })
  })

  ipcMain.on('update:install', () => {
    appendAppLog('info', 'updater', 'Installing downloaded update')
    // isSilent=true: run the NSIS installer with /S so updates install
    // in-place without re-showing the assisted-install wizard
    // (oneClick:false only makes sense for FIRST installs).
    // isForceRunAfter=true: relaunch the app when done.
    autoUpdater.quitAndInstall(true, true)
  })

  function check(): void {
    if (checkInFlight) return
    checkInFlight = true
    autoUpdater
      .checkForUpdates()
      .then(() => {
        retryCount = 0
      })
      .catch((err) => {
        // 这个平台没有发布通道 ≠ 更新失败,别在右上角红一次
        if (isMissingUpdateChannel(err)) return
        if (scheduleRetry(err)) return
        appendAppLog('error', 'updater', 'Update check failed', normalizeError(err))
        broadcast('update:error', { message: err.message ?? String(err) })
      })
      .finally(() => {
        checkInFlight = false
      })
  }

  // 启动后 3 秒再检查，避免影响启动速度；之后每 4 小时查一次
  setTimeout(check, 3000)
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 12 } }
      : { frame: false, titleBarStyle: 'hidden' }),
    backgroundColor: '#000000',
    webPreferences: {
      // sandbox preload 由 Electron 的 sandbox_bundle 加载,必须是 CJS 脚本。
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  attachWindowLoggers(mainWindow)

  mainWindow.on('close', (event) => {
    if (process.platform !== 'win32' || isQuitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  const openAllowedExternalUrl = (url: string): void => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        appendAppLog('warn', 'navigation', 'Failed to open external URL', {
          error: normalizeError(err),
        })
      })
    } else {
      appendAppLog('warn', 'navigation', 'Blocked external URL with disallowed protocol')
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (
      is.dev &&
      isAllowedRendererNavigation(details.url, process.env['ELECTRON_RENDERER_URL'])
    ) {
      return
    }
    details.preventDefault()
    if (details.isMainFrame) openAllowedExternalUrl(details.url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  installProcessLoggers()
  try {
    const restore = applyPendingDataRestore(app.getPath('userData'), { appVersion: app.getVersion() })
    if (restore.status === 'restored') {
      appendAppLog('info', 'backup', 'Applied pending data restore', restore)
    } else if (restore.status === 'failed') {
      appendAppLog('error', 'backup', 'Pending data restore failed', restore)
    }
  } catch (error) {
    appendAppLog('error', 'backup', 'Pending data restore crashed', normalizeError(error))
  }
  try {
    const backup = createStartupDataBackup(app.getPath('userData'), { appVersion: app.getVersion() })
    if (backup.status === 'created') {
      appendAppLog('info', 'backup', 'Created startup data backup', backup)
    }
  } catch (error) {
    appendAppLog('warn', 'backup', 'Startup data backup failed', normalizeError(error))
  }
  const cleanedSnapshots = cleanupStaleRunChangeTempDirs()
  appendAppLog('info', 'app', 'App ready', { version: app.getVersion() })
  if (cleanedSnapshots > 0) {
    appendAppLog('info', 'git.runChanges', 'Cleaned stale Git snapshot directories', {
      count: cleanedSnapshots,
    })
  }

  electronApp.setAppUserModelId('com.jiubingwangwang.pi-studio')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  // web_search 的 Tavily 调用在主进程做,agent 子进程只拿本地 token —— 路由要在服务起来前就挂好
  registerWebSearchRelay()
  void startSharedMemoryService(sharedMemoryPath(), (message, error) => {
    appendAppLog('warn', 'memory.snapshot', message, normalizeError(error))
  }).catch((error) => {
    appendAppLog('warn', 'memory.service', 'Shared memory service failed to start', normalizeError(error))
  })
  syncBundledSkills()
  syncBundledExtensions()
  piClientManager.warmup()
  // 工具操作账本:控制面断线后回来问"这条写做了没有",答案在这里(Tool Gateway v1 receipts)
  remoteControl.setToolReceiptLedger(new ToolReceiptLedger(join(app.getPath('userData'), 'pi-agent', 'tool-operations.jsonl')))
  // 上次开着远程控制就自动重连中转
  if (loadSettings().remoteEnabled) void remoteControl.enable()
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  if (!is.dev && existsSync(join(process.resourcesPath, 'app-update.yml'))) setupAutoUpdater()
  createWindow()

  const [mainWindow] = BrowserWindow.getAllWindows()
  if (mainWindow) createTray(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

const quitGuard = createQuitGuard({
  cleanup: async () => {
    tray?.destroy()
    tray = null
    appendAppLog('info', 'app', 'App quitting')
    clearAllGitRunChanges()
    await Promise.allSettled([piClientManager.stop(), stopSharedMemoryService()])
  },
  quit: () => app.quit(),
  timeoutMs: DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
  onOutcome: (outcome) => {
    if (outcome === 'done') {
      appendAppLog('info', 'app', 'Agent cleanup finished')
      return
    }
    // 超时就意味着可能有 agent 进程活过了这次退出 —— 留下能对账的证据,
    // 而不是静默地当成收干净了。
    appendAppLog('error', 'app', 'Agent cleanup did not finish before quit', {
      timeoutMs: DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
      liveAgents: piClientManager.liveAgentCount(),
      jobs: piClientManager.agentJobs(),
    })
  },
})

app.on('before-quit', (event) => {
  isQuitting = true
  quitGuard.handleBeforeQuit(event)
})
