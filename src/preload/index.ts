import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/ipc/contract'

/**
 * 跨进程桥不再逐个手写。
 *
 * channel 名一律由「命名空间 + 方法名」推导(`settings.save` → `settings:save`),
 * 这里只留一份方法清单。清单受 `DesktopApi` 反向约束:漏一个方法、写错一个名字
 * 都在编译期爆,和以前 `satisfies DesktopApi` 的保证等价。
 *
 * 顺带干掉了一整类 bug —— 手写的 channel 字符串拼错只会在运行时炸,
 * 现在 channel 是推导出来的,拼不错。
 *
 * 为什么不是惰性 Proxy:`contextBridge.exposeInMainWorld` 在 expose 时枚举 own keys,
 * `new Proxy({}, { get })` 过去就是个空对象。方法必须在暴露前真建出来。
 */

/** platform 是常量字段,不走 IPC,不参与桥接 */
type Namespaces = Omit<DesktopApi, 'platform'>

type MethodList = { readonly [K in keyof Namespaces]: readonly (keyof Namespaces[K])[] }

const METHODS = {
  win: ['minimize', 'maximize', 'close', 'flash'],
  app: ['version', 'piVersion'],
  clipboard: ['writeText'],
  diagnostics: ['getLogs', 'save', 'listBackups', 'restoreBackup'],
  settings: ['load', 'save', 'listCloudModels', 'onChanged'],
  llmProfiles: ['list', 'save', 'delete', 'refreshModels', 'providerHealth'],
  modelCatalog: ['loadProviderLabels'],
  sandbox: ['detect', 'imageStatus', 'buildImage', 'onBuildProgress'],
  remote: ['getStatus', 'setEnabled', 'generatePairingCode', 'resetPairings', 'onStatus'],
  workspace: ['list', 'pickDirectory', 'open', 'remove'],
  memory: ['load', 'save', 'sharedStatus'],
  sessions: ['list', 'switch', 'rename', 'delete', 'exportCurrent'],
  git: ['diff', 'acceptChanges', 'discardChanges', 'showFile'],
  pi: [
    'prompt',
    'steer',
    'followUp',
    'abort',
    'extensionUiResponse',
    'newSession',
    'getState',
    'getArtifactChunk',
    'getAvailableModels',
    'getCommands',
    'setModel',
    'setThinkingLevel',
    'setSteeringMode',
    'setFollowUpMode',
    'setAutoCompaction',
    'setPermissionMode',
    'compact',
    'getRuntimeSnapshot',
    'getAgentStatusSnapshot',
    'getCapabilities',
    'getSessionProjection',
    'onEvent',
    'onStatus',
    'onSessionActivity',
    'onRuntime',
    'onAgentStatusSnapshot',
    'onSessionProjection',
  ],
  routines: [
    'list',
    'save',
    'delete',
    'toggle',
    'runNow',
    'cancel',
    'state',
    'reviewRespond',
    'onRunFinished',
    'onStepProgress',
    'onReviewRequested',
    'onReviewCancelled',
  ],
  channels: ['list', 'save', 'test'],
  imageGen: ['health', 'generate', 'history', 'historyDelete', 'historyDeleteBatch', 'uploadReference'],
  model3d: [
    'health',
    'generate',
    'generateCode',
    'generateBlender',
    'blenderStatus',
    'setupBlender',
    'history',
    'historyDelete',
    'saveThumbnail',
    'reviewRound',
    'onProgress',
    'onScored',
  ],
  dressup: ['health', 'generate', 'workflow', 'history', 'historyDelete', 'onProgress'],
  update: ['onAvailable', 'onDownloaded', 'onError', 'install'],
} as const satisfies MethodList

/**
 * 安全网。`satisfies MethodList` 只挡住「多写/写错」,挡不住「漏写」——
 * 下面这行把漏掉的方法名算出来,不为 never 就编译失败,报错里直接点名是哪个。
 */
type MissingFromBridge = {
  [K in keyof Namespaces]: Exclude<keyof Namespaces[K], (typeof METHODS)[K][number]>
}[keyof Namespaces]

const allMethodsBridged: [MissingFromBridge] extends [never] ? true : MissingFromBridge = true
void allMethodsBridged

/** DesktopApi 里返回 void 的那几个:只发不等回复 */
const SEND_ONLY = new Set<string>([
  'win.minimize',
  'win.maximize',
  'win.close',
  'win.flash',
  'update.install',
])

/**
 * on* 订阅默认订 `ns:事件名`(`routines.onStepProgress` → `routines:stepProgress`)。
 * 这三个是例外:主进程把 agent 生命周期事件发在 `agent:` 下,不在 `pi:` 里。
 */
const EVENT_CHANNEL_OVERRIDES: Record<string, string> = {
  'pi.onStatus': 'agent:status',
  'pi.onRuntime': 'agent:runtime',
  'pi.onAgentStatusSnapshot': 'agent:statusSnapshot',
}

/** `open` 不是订阅,所以要求 on 后面跟大写 */
const isSubscription = (method: string): boolean => /^on[A-Z]/.test(method)

const eventChannel = (path: string, ns: string, method: string): string =>
  EVENT_CHANNEL_OVERRIDES[path] ?? `${ns}:${method[2].toLowerCase()}${method.slice(3)}`

const subscription =
  (channel: string) =>
  (cb: (...payload: unknown[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ...payload: unknown[]): void => cb(...payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  }

function buildBridge(): Record<string, unknown> {
  const bridge: Record<string, unknown> = {}
  for (const [ns, methods] of Object.entries(METHODS) as [string, readonly string[]][]) {
    const namespace: Record<string, unknown> = {}
    for (const method of methods) {
      const path = `${ns}.${method}`
      const channel = `${ns}:${method}`
      if (isSubscription(method)) {
        namespace[method] = subscription(eventChannel(path, ns, method))
      } else if (SEND_ONLY.has(path)) {
        namespace[method] = (...args: unknown[]): void => ipcRenderer.send(channel, ...args)
      } else {
        namespace[method] = (...args: unknown[]): Promise<unknown> =>
          ipcRenderer.invoke(channel, ...args)
      }
    }
    bridge[ns] = namespace
  }
  return bridge
}

/**
 * 这次 cast 只兜「签名」,不兜「有没有」—— 方法齐不齐由上面的 MissingFromBridge 保证。
 * 签名本身不会漂:invoke 原样转发实参,on* 原样转发事件负载,没有中间加工。
 */
const api = {
  platform: process.platform,
  ...buildBridge(),
} as DesktopApi

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore -- Electron fallback when context isolation is disabled.
  window.api = api
}
