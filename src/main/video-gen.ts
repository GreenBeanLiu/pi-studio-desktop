import { ipcMain } from 'electron'

import type { VideoGenHealth, VideoGenHistoryItem, VideoGenPayload, VideoGenResult, VideoModelOption } from '../shared/ipc/contract'
import { appendAppLog, normalizeError } from './app-log'
import { getCloudConnection } from './cloud-connection'
import { cloudMediaFetch, readCloudSseResult, uploadCloudImageReference } from './cloud-media'

/**
 * 视频生成(2026-10-20):设备面的 /videogen(Hatchet 任务 gen-video,APIMart 的 Grok Video 1.5)。
 *
 * 可灵那版(09-29 删)只给手机用、任务列表放内存里,重启就没了。这版给桌面自己用,
 * 历史在云端(/videogen/history),接单做的视频过一周还能找到。
 *
 * 首帧可以是本地图(先传 R2,和改图的参考图同一条 /imagegen/reference),也可以是
 * 已经在 R2 上的图(出图历史里挑的)。视频不下载到本地:拿到的是 R2 公网链接,
 * 页面直接播,要文件再点下载。
 */
const VIDEO_TIMEOUT_MS = 20 * 60_000

export type VideoGenIo = {
  fetch: typeof cloudMediaFetch
  upload: typeof uploadCloudImageReference
  readSse: typeof readCloudSseResult
}

const defaultIo: VideoGenIo = { fetch: cloudMediaFetch, upload: uploadCloudImageReference, readSse: readCloudSseResult }

export async function generateVideo(payload: VideoGenPayload, io: VideoGenIo = defaultIo): Promise<VideoGenResult> {
  try {
    const prompt = payload.prompt?.trim()
    if (!prompt) return { error: '写一下画面怎么动、镜头怎么走' }
    const imageUrl = payload.frameDataUrl ? await io.upload(payload.frameDataUrl) : payload.frameUrl
    const response = await io.fetch(
      '/videogen',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          ...(imageUrl ? { imageUrl } : {}),
          duration: payload.duration ?? 6,
          resolution: payload.resolution ?? '480p',
          aspectRatio: payload.aspectRatio ?? '9:16',
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.audio ? { audio: true } : {}),
        }),
      },
      VIDEO_TIMEOUT_MS,
    )
    const data = await io.readSse(response, () => {})
    const videoUrl = typeof data.videoUrl === 'string' ? data.videoUrl : ''
    if (!videoUrl) return { error: '云端任务完成但没有返回视频链接' }
    return {
      videoUrl,
      provider: typeof data.provider === 'string' ? data.provider : null,
      durationSec: typeof data.durationSec === 'number' ? data.durationSec : null,
      resolution: typeof data.resolution === 'string' ? data.resolution : null,
      firstFrameUrl: imageUrl ?? null,
    }
  } catch (error) {
    appendAppLog('error', 'videoGen.generate', '视频生成失败', normalizeError(error))
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error.message))
    return { error: timedOut ? '生成超过 20 分钟，已按失败处理' : error instanceof Error ? error.message : String(error) }
  }
}

export async function videoHealth(io: Pick<VideoGenIo, 'fetch'> = defaultIo): Promise<VideoGenHealth> {
  const cloud = getCloudConnection()
  if (!cloud.available) return { ok: false, reason: cloud.error ?? '云端服务未配置' }
  try {
    const response = await io.fetch('/videogen/health', {}, 5_000)
    if (!response.ok) return { ok: false, reason: `云端 ${response.status}(后端可能还没更新到有视频的版本)` }
    const body = (await response.json()) as { ok?: boolean; models?: unknown }
    const models = Array.isArray(body.models) ? body.models.filter(isModelOption) : undefined
    return body.ok
      ? { ok: true, ...(models ? { models } : {}) }
      : { ok: false, reason: '云端还没配视频供应商的 key(管理台里填 APIMart / kie.ai)', ...(models ? { models } : {}) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 云端给的模型描述只收形状对的;缺字段的条目丢掉,别让一个坏条目把页面带崩。 */
function isModelOption(value: unknown): value is VideoModelOption {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.label === 'string' && Array.isArray(v.durations) && v.durations.length > 0 &&
    Array.isArray(v.resolutions) && v.resolutions.length > 0 && Array.isArray(v.aspectRatios) && v.aspectRatios.length > 0 &&
    !!v.defaults && typeof v.defaults === 'object' && !!v.yuanPerSecond && typeof v.yuanPerSecond === 'object'
}

export async function videoHistory(limit = 60, io: Pick<VideoGenIo, 'fetch'> = defaultIo): Promise<VideoGenHistoryItem[] | { error: string }> {
  try {
    const n = Math.min(Math.max(Math.round(limit), 1), 200)
    const response = await io.fetch(`/videogen/history?limit=${n}`, {}, 15_000)
    if (!response.ok) return { error: `云端 ${response.status}` }
    return (await response.json()) as VideoGenHistoryItem[]
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerVideoGenHandlers(): void {
  ipcMain.handle('videoGen:health', () => videoHealth())
  ipcMain.handle('videoGen:generate', (_e, payload: VideoGenPayload) => generateVideo(payload))
  ipcMain.handle('videoGen:history', (_e, limit?: number) => videoHistory(limit))
}
