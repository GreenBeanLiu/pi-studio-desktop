import { hostname } from 'os'
import { ensureCredential, routineSyncOrigin } from './routine-cloud-sync'
import { appendAppLog, normalizeError } from './app-log'
import { NO_WORKSPACE_ERROR } from './pi-client'
import type { RemotePairingCode, StudioAgentEvent } from '../shared/ipc/contract'
import { cloudFetch } from './cloud-fetch'
import { TOOL_GATEWAY_MANIFEST } from './tool-gateway'
import type { ToolReceiptLedger } from './tool-receipts'
import { dispatchControllerCommand, errMsg } from './remote-command-dispatch'
import type {
  ProjectionProvider,
  RemoteImageHost,
  RemoteReviewHost,
  RemoteRoutineHost,
  RemoteVideoHost,
  RemoteWorkspaceHost,
} from './remote-command-dispatch'

// 这些名字从 remote-control 抽到了 remote-command-dispatch(2026-09-19)。这里按老路径
// 继续导出,调用方(ipc.ts、video-gen.ts、测试)不用改 import 源。
export { LOCAL_TOOL_PROTOCOL } from './tool-gateway'
export { SUPPORTED_COMMANDS, HOST_EVENT_CHANNELS } from './remote-command-dispatch'
export type {
  RemoteCommandContext,
  RemoteWorkspaceHost,
  RemoteRoutineSummary,
  RemoteRoutineRunSummary,
  RemoteRoutineHost,
  RemoteImageHost,
  RemoteVideoJob,
  RemoteVideoHost,
  RemoteReviewHost,
} from './remote-command-dispatch'

/**
 * 手机端要能把「桌面没开工作目录」和别的失败分开:前者是一步就能自救的
 * (发 openWorkspace),后者只能提示。笼统回一句 error 的时候,手机上只会显示
 * 「读取模型列表失败」这种看不出所以然的话。
 */
function remoteErrorCode(err: unknown): string | undefined {
  return errMsg(err) === NO_WORKSPACE_ERROR ? 'NO_WORKSPACE' : undefined
}

export type RemoteStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export type RemoteControlSnapshot = {
  enabled: boolean
  status: RemoteStatus
  controllers: number
  lastError: string
}

/** 每隔这么久发一次 ping;超过 DEAD 还没收到任何消息就当这条链路已经死了。 */
/**
 * 中转端只用这两个关闭码,它们的共同点是「原样重连一定还是同样的结果」:
 *  - 4401 装机 token 不被认可(配对失效/被吊销);
 *  - 4409 同一装机的新 host 顶掉了旧的 —— 立刻抢回去就变成两台机器每 5 秒互踢。
 * 过去 close 处理器把 code 整个丢掉,一律 5 秒重连,于是日志里刷出上千条
 * "Remote control host connected",而心跳看门狗一次都不会触发(连接不是静默,是被
 * 对端主动关的),排查时极难看出真正原因。
 */
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_SUPERSEDED = 4409

const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_DEAD_MS = 60_000

/**
 * 手机远程控制的 host 端:用装机 token 连中转 WebSocket(role=host),把手机
 * (controller)发来的指令分发给 piClientManager,并把 agent 事件转发回手机。
 * 事件转发靠 workspace:open 的 onEvent 搭车(见 ipc.ts 调 forwardEvent),不改 piClientManager。
 *
 * 指令本身怎么翻成动作在 remote-command-dispatch.ts;这里只管连接、心跳、重连、回帧,
 * 以及各个 host 的挂载。
 */
class RemoteControlManager {
  private ws: WebSocket | null = null
  private enabled = false
  private status: RemoteStatus = 'disabled'
  private lastError = ''
  private controllers = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private statusListener: ((snap: RemoteControlSnapshot) => void) | null = null
  private projectionProvider: ProjectionProvider | null = null
  private workspaceHost: RemoteWorkspaceHost | null = null
  private reviewHost: RemoteReviewHost | null = null
  private routineHost: RemoteRoutineHost | null = null
  private imageHost: RemoteImageHost | null = null
  private videoHost: RemoteVideoHost | null = null
  private receipts: ToolReceiptLedger | null = null

  /** 工具操作账本(Tool Gateway v1 receipts)。不挂就不宣告 receipts,控制面按老桌面对待。 */
  setToolReceiptLedger(ledger: ToolReceiptLedger | null): void {
    this.receipts = ledger
  }

  private toolGatewayManifest(): Record<string, unknown> {
    return { ...TOOL_GATEWAY_MANIFEST, ...(this.receipts ? { receipts: 1 } : {}) }
  }

  setStatusListener(cb: (snap: RemoteControlSnapshot) => void): void {
    this.statusListener = cb
  }

  setProjectionProvider(provider: ProjectionProvider | null): void {
    this.projectionProvider = provider
  }

  setWorkspaceHost(host: RemoteWorkspaceHost): void {
    this.workspaceHost = host
  }

  setReviewHost(host: RemoteReviewHost): void {
    this.reviewHost = host
  }

  setRoutineHost(host: RemoteRoutineHost): void {
    this.routineHost = host
  }

  setImageHost(host: RemoteImageHost): void {
    this.imageHost = host
  }

  setVideoHost(host: RemoteVideoHost): void {
    this.videoHost = host
  }

  snapshot(): RemoteControlSnapshot {
    return { enabled: this.enabled, status: this.status, controllers: this.controllers, lastError: this.lastError }
  }

  private emit(): void {
    this.statusListener?.(this.snapshot())
  }

  private setStatus(status: RemoteStatus, error = ''): void {
    this.status = status
    if (error) this.lastError = error
    if (status === 'connected' || status === 'connecting') this.lastError = error
    this.emit()
  }

  async enable(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    await this.connect()
  }

  disable(): void {
    this.enabled = false
    this.clearReconnect()
    this.controllers = 0
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    this.setStatus('disabled')
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * 应用层心跳。
   *
   * 桌面这条连接的唯一重连触发本来是 close 事件,但 NAT 超时、Wi-Fi 漫游、运营商掐
   * 空闲连接都**不产生 close** —— 中转早把这个 host 踢出房间、手机显示「桌面离线」,
   * 桌面这边 socket 还是 ESTABLISHED,于是永远不重连。实测遇到过。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastInboundAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > HEARTBEAT_DEAD_MS) {
        appendAppLog('warn', 'remote', 'Remote control link went silent; reconnecting')
        this.stopHeartbeat()
        try {
          this.ws?.close()
        } catch {
          /* 关不掉也无妨,重连会顶掉它 */
        }
        return
      }
      this.send({ type: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  /** 返回不为空就表示这次关闭重连也没用,附带给用户看的原因。 */
  private describeFatalClose(code?: number): string {
    if (code === CLOSE_UNAUTHORIZED) return '配对已失效,请在手机上重新配对'
    if (code === CLOSE_SUPERSEDED) return '另一台电脑已用同一装机接管了远程控制'
    return ''
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 5000)
  }

  private async connect(): Promise<void> {
    if (!this.enabled) return
    this.setStatus('connecting')
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const wsUrl = `${origin.replace(/^http/, 'ws')}/remote/ws`
      const ws = new WebSocket(wsUrl, [
        'pi-studio-role.host',
        `pi-studio-token.${cred.token}`,
      ])
      this.ws = ws
      ws.addEventListener('open', () => {
        this.controllers = 0
        this.setStatus('connected')
        appendAppLog('info', 'remote', 'Remote control host connected')
        this.startHeartbeat()
      })
      ws.addEventListener('message', (e) => {
        this.lastInboundAt = Date.now()
        void this.onControllerMessage(typeof e.data === 'string' ? e.data : String(e.data))
      })
      ws.addEventListener('close', (event) => {
        if (this.ws === ws) this.ws = null
        this.stopHeartbeat()
        this.controllers = 0
        const code = (event as { code?: number }).code
        const reason = (event as { reason?: string }).reason
        appendAppLog('info', 'remote', 'Remote control host disconnected', { code, reason })
        if (!this.enabled) return
        const fatal = this.describeFatalClose(code)
        if (fatal) {
          // 重连解决不了,继续每 5 秒撞上去只会刷屏并把对面也拖下水
          appendAppLog('warn', 'remote', 'Remote control stopped reconnecting', { code, reason: fatal })
          this.setStatus('error', fatal)
          return
        }
        this.setStatus('connecting')
        this.scheduleReconnect()
      })
      ws.addEventListener('error', () => {
        // close 事件会跟着触发重连;这里只记录
      })
    } catch (err) {
      const message = errMsg(err)
      appendAppLog('warn', 'remote', 'Remote control connect failed', { error: message })
      this.setStatus('error', message)
      this.scheduleReconnect()
    }
  }

  /** 把主工作区的 agent 事件转发给手机(由 ipc.ts 的 onEvent 回调调用)。 */
  forwardEvent(event: StudioAgentEvent): void {
    if (this.status !== 'connected') return
    this.send({ type: 'event', event })
  }

  /**
   * agent 之外的桌面事件(工作流进度、人工审核、生图结果)。这些不能挤进 `event`
   * 那条通道 —— 手机把它直接当成聊天消息流塞进会话里,混进去就是脏数据。
   * 带 channel 分发,手机认不出的 channel 直接丢掉,老版本手机因此天然安全降级。
   */
  forwardHostEvent(channel: string, payload: unknown): void {
    if (this.status !== 'connected') return
    this.send({ type: 'hostEvent', channel, payload })
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }

  private reply(id: unknown, data: unknown = { ok: true }): void {
    if (id !== undefined && id !== null) this.send({ type: 'result', id, data })
  }

  /** 业务错误单独走 top-level error 字段,手机端据此 reject(而不是把 {error} 当成正常结果)。 */
  private replyError(id: unknown, message: string, code?: string): void {
    if (id !== undefined && id !== null) {
      this.send({ type: 'result', id, error: message, ...(code ? { code } : {}) })
    }
  }

  private async onControllerMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(msg.type ?? '')

    // 中转的连接通知
    if (type === 'pong') return
    if (type === 'controller_online') {
      this.controllers += 1
      this.emit()
      const snapshot = this.projectionProvider?.snapshot()
      if (snapshot) this.send({ type: 'sessionProjection', snapshot })
      return
    }
    if (type === 'controller_offline') {
      this.controllers = Math.max(0, this.controllers - 1)
      this.emit()
      return
    }

    try {
      await dispatchControllerCommand(type, msg, {
        reply: (id, data) => this.reply(id, data),
        replyError: (id, message, code) => this.replyError(id, message, code),
        receipts: this.receipts,
        projection: this.projectionProvider,
        toolGatewayManifest: () => this.toolGatewayManifest(),
        workspaceHost: this.workspaceHost,
        routineHost: this.routineHost,
        imageHost: this.imageHost,
        videoHost: this.videoHost,
        reviewHost: this.reviewHost,
      })
    } catch (err) {
      // 远程指令失败过去只回给手机、桌面这边一点痕迹都不留,手机上又只显示一句
      // 通用提示 —— 出问题时两头都查不到。这里落一条日志。
      appendAppLog('warn', 'remote.command', 'Remote command failed', {
        type,
        error: normalizeError(err),
      })
      this.replyError(msg.id, errMsg(err), remoteErrorCode(err))
    }
  }

  /** app 生成一个配对码给手机输入。 */
  async generatePairingCode(): Promise<RemotePairingCode | { error: string }> {
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const res = await cloudFetch(`${origin}/remote/pair/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: hostname(), platform: process.platform }),
      })
      if (!res.ok) return { error: `生成配对码失败(${res.status})` }
      const body = (await res.json()) as { code: string; expires_at: number }
      return {
        code: body.code,
        expiresAt: body.expires_at,
        qrPayload: `pi-studio://pair?code=${encodeURIComponent(body.code)}`,
      }
    } catch (err) {
      return { error: errMsg(err) }
    }
  }

  async resetPairings(): Promise<{ ok: true } | { error: string }> {
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const res = await cloudFetch(`${origin}/remote/pair/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}` },
      })
      if (!res.ok) return { error: `解除手机绑定失败 (${res.status})` }
      this.controllers = 0
      this.emit()
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  }
}

export const remoteControl = new RemoteControlManager()
