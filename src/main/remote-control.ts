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
import { RemoteTransport } from './remote-transport'
import type { RemoteControlSnapshot } from './remote-transport'

// 2026-09-19 起 remote-control 被拆成三层:remote-transport(连接)、
// remote-command-dispatch(指令)。这里保留原路径的导出,调用方不用改 import 源。
export { LOCAL_TOOL_PROTOCOL } from './tool-gateway'
export { SUPPORTED_COMMANDS, HOST_EVENT_CHANNELS } from './remote-command-dispatch'
export type { RemoteControlSnapshot, RemoteStatus } from './remote-transport'
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

/**
 * 手机远程控制的 facade:把连接(RemoteTransport)、指令分发(remote-command-dispatch)
 * 和桌面各 host 的挂载拼在一起。它自己不做连接、不解释指令,只持有 projection 和五个
 * host 的引用,在指令到达时组装 RemoteCommandContext 递下去。
 *
 * 事件转发靠 workspace:open 的 onEvent 搭车(见 ipc.ts 调 forwardEvent),不改 piClientManager。
 */
class RemoteControlManager {
  private readonly transport = new RemoteTransport()
  private statusListener: ((snap: RemoteControlSnapshot) => void) | null = null
  private projectionProvider: ProjectionProvider | null = null
  private workspaceHost: RemoteWorkspaceHost | null = null
  private reviewHost: RemoteReviewHost | null = null
  private routineHost: RemoteRoutineHost | null = null
  private imageHost: RemoteImageHost | null = null
  private videoHost: RemoteVideoHost | null = null
  private receipts: ToolReceiptLedger | null = null

  constructor() {
    this.transport.setHandlers({
      onMessage: (raw) => void this.onControllerMessage(raw),
      onControllerOnline: () => this.sendSessionProjection(),
      onSnapshot: (snap) => this.statusListener?.(snap),
    })
  }

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
    return this.transport.snapshot()
  }

  async enable(): Promise<void> {
    await this.transport.enable()
  }

  disable(): void {
    this.transport.disable()
  }

  /** 把主工作区的 agent 事件转发给手机(由 ipc.ts 的 onEvent 回调调用)。 */
  forwardEvent(event: StudioAgentEvent): void {
    if (!this.transport.connected) return
    this.send({ type: 'event', event })
  }

  /**
   * agent 之外的桌面事件(工作流进度、人工审核、生图结果)。这些不能挤进 `event`
   * 那条通道 —— 手机把它直接当成聊天消息流塞进会话里,混进去就是脏数据。
   * 带 channel 分发,手机认不出的 channel 直接丢掉,老版本手机因此天然安全降级。
   */
  forwardHostEvent(channel: string, payload: unknown): void {
    if (!this.transport.connected) return
    this.send({ type: 'hostEvent', channel, payload })
  }

  private send(obj: unknown): void {
    this.transport.send(obj)
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

  /** 新 controller 进房间时补一帧投影,免得它等到下一次变更才看得见会话。 */
  private sendSessionProjection(): void {
    const snapshot = this.projectionProvider?.snapshot()
    if (snapshot) this.send({ type: 'sessionProjection', snapshot })
  }

  private async onControllerMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(msg.type ?? '')

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
      this.transport.resetControllers()
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  }
}

export const remoteControl = new RemoteControlManager()
