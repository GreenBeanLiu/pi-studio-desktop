import { ensureCredential, routineSyncOrigin } from './routine-cloud-sync'
import { appendAppLog } from './app-log'
import type { RemoteControlSnapshot } from '../shared/ipc/contract'

/**
 * 中转连接这一层:WebSocket 的建立、应用层心跳、断线重连,以及房间里的 presence
 * (pong / controller_online / controller_offline)。它不解释业务指令 —— 那些交给
 * RemoteControlManager 通过 handlers.onMessage 往下分。
 *
 * 从 remote-control.ts 抽出来(2026-09-19),再做一次纵深:上一刀把「指令 → 动作」
 * 分了出去,这一刀把「连接」也分出去,RemoteControlManager 只剩 facade。
 */

export type { RemoteControlSnapshot } from '../shared/ipc/contract'
export type RemoteStatus = RemoteControlSnapshot['status']

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

/** 每隔这么久发一次 ping;超过 DEAD 还没收到任何消息就当这条链路已经死了。 */
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_DEAD_MS = 60_000

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type RemoteTransportHandlers = {
  /** 非 presence 的入站帧(原样一段 JSON 文本)。 */
  onMessage: (raw: string) => void
  /** 有新 controller 进房间;调用方据此补发 sessionProjection。 */
  onControllerOnline: () => void
  /** 连接状态发生变化(供 UI 投影)。 */
  onSnapshot: (snap: RemoteControlSnapshot) => void
}

export class RemoteTransport {
  private ws: WebSocket | null = null
  private enabled = false
  private status: RemoteStatus = 'disabled'
  private lastError = ''
  private controllers = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private handlers: RemoteTransportHandlers = {
    onMessage: () => {},
    onControllerOnline: () => {},
    onSnapshot: () => {},
  }

  setHandlers(handlers: RemoteTransportHandlers): void {
    this.handlers = handlers
  }

  snapshot(): RemoteControlSnapshot {
    return { enabled: this.enabled, status: this.status, controllers: this.controllers, lastError: this.lastError }
  }

  get connected(): boolean {
    return this.status === 'connected'
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

  /** 配对重置:把房间里的 controller 计数清零并广播。 */
  resetControllers(): void {
    this.controllers = 0
    this.emit()
  }

  send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }

  private emit(): void {
    this.handlers.onSnapshot(this.snapshot())
  }

  private setStatus(status: RemoteStatus, error = ''): void {
    this.status = status
    if (error) this.lastError = error
    if (status === 'connected' || status === 'connecting') this.lastError = error
    this.emit()
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
        this.onInbound(typeof e.data === 'string' ? e.data : String(e.data))
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

  /** presence 自己消化,其余交给上层。 */
  private onInbound(raw: string): void {
    this.lastInboundAt = Date.now()
    let type = ''
    try {
      type = String((JSON.parse(raw) as { type?: unknown }).type ?? '')
    } catch {
      return
    }
    if (type === 'pong') return
    if (type === 'controller_online') {
      this.controllers += 1
      this.emit()
      this.handlers.onControllerOnline()
      return
    }
    if (type === 'controller_offline') {
      this.controllers = Math.max(0, this.controllers - 1)
      this.emit()
      return
    }
    this.handlers.onMessage(raw)
  }
}
