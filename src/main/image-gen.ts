import { ipcMain } from 'electron'
import { appendAppLog } from './app-log'
import { getCloudConnection } from './cloud-connection'
import { resolveCloudImageResult } from './image-gen-result'
import { abortSignalWithTimeout } from './abort-signal'
import { remoteControl } from './remote-control'
import type { ImageModel } from '../shared/ipc/contract'
import { cloudFetch as netFetch } from './cloud-fetch'

// 本地 ComfyUI 引擎已移除(2026-07-17):生图全走云端(TrailAI 中继)。
// Provider 调度、Hatchet 执行和 R2 归档均在服务端。
const CLOUD_TIMEOUT_MS = 320_000

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  model: string
  r2: boolean
}

export type ImageGenResult = { dataUrl: string; publicUrl: string | null; urls?: string[] } | { error: string }

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

/** 解析 base64 dataURL(参考图/蒙版上传用)。 */
function parseImageDataUrl(value: string): { data: ArrayBuffer; contentType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value.trim())
  if (!match) return null
  try {
    const bytes = Buffer.from(match[2], 'base64')
    return {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: match[1].toLowerCase(),
    }
  } catch {
    return null
  }
}

async function cloudFetch(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const cloud = getCloudConnection()
  if (!cloud.available) throw new Error(cloud.error ?? '云端图像服务未配置')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return netFetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

async function cloudUploadReference(dataUrl: string, signal?: AbortSignal): Promise<string> {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) throw new Error('上传参考图格式无效')
  const resp = await cloudFetch(
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: Buffer.from(parsed.data).toString('base64'),
        content_type: parsed.contentType,
      }),
      signal: abortSignalWithTimeout(signal, 60_000),
    },
    60_000,
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`参考图上传失败(${resp.status}): ${text.slice(0, 200)}`)
  }
  const result = (await resp.json()) as { url?: string }
  if (!result.url) throw new Error('参考图上传成功但没有返回 URL')
  return result.url
}

async function probeCloud(path: string, timeoutMs: number): Promise<Response | null> {
  try {
    const response = await cloudFetch(path, {}, timeoutMs)
    return response.ok ? response : null
  } catch {
    return null
  }
}

/** 云端生成/改图:POST 一个 SSE 长连接,event: result 里拿 R2 URL,再下载转 dataUrl。 */
async function cloudGenerate(
  prompt: string,
  batchId: string,
  referenceUrls?: string[],
  maskUrl?: string,
  size?: ImageGenSize,
  options?: ImageGenOptions,
  downloadResult = true,
  model?: ImageModel,
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  const cloud = getCloudConnection()
  if (!cloud.available) {
    return { error: cloud.error ?? '云端图像服务未配置' }
  }

  const resp = await cloudFetch(
    '/imagegen',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        batchId,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        ...(options ?? {}),
        ...(referenceUrls?.length ? { referenceUrls } : {}),
        ...(maskUrl ? { maskUrl } : {}),
      }),
      signal: abortSignalWithTimeout(signal, CLOUD_TIMEOUT_MS),
    },
    CLOUD_TIMEOUT_MS,
  )
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    return { error: `云端中继 ${resp.status}: ${text.slice(0, 200)}` }
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const dataRaw = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !dataRaw) continue
      const data = JSON.parse(dataRaw)

      if (event === 'error') return { error: data.message || '云端生成失败' }
      if (event === 'result') {
        const urls = Array.isArray(data.urls)
          ? data.urls.filter((item: unknown): item is string => typeof item === 'string')
          : []
        const url = urls[0]
        if (!url) return { error: '云端任务完成但没有返回图片 URL' }
        const resolved = await resolveCloudImageResult(url, downloadResult)
        if ('downloadError' in resolved) {
          appendAppLog('warn', 'imagegen.cloud', 'Cloud result preview download failed; using public URL', {
            url,
            error: resolved.downloadError,
          })
        }
        return { ...resolved, urls }
      }
      // event: status — 阶段进度,目前不透传到 UI
    }
  }
  return { error: '云端连接在收到结果前断开了' }
}

/** 云端 gpt-image-2 支持的尺寸(值透传给 TrailAI/Hatchet 任务)。 */
export type ImageGenSize =
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'
  | '1024x1792'
  | '1792x1024'
  | 'auto'
// Nano Banana 2.1(Gemini 系)的比例:十种常规 + 四种超长条 + auto(有参考图时跟参考图)
export type GeminiImageAspectRatio =
  | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
  | '1:4' | '4:1' | '1:8' | '8:1' | 'auto'
export type GeminiImageResolution = '1K' | '2K' | '4K'
// GPT Image 2.5 Flare(kie.ai,2026-10-23)的比例;27:16 / 16:27 / 9:8 / 8:9 只出 1K
export type FlareImageAspectRatio =
  | 'auto' | '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16' | '21:9' | '27:16' | '16:27' | '9:8' | '8:9'
export type GrokImageAspectRatio =
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '3:2'
  | '2:3'
  | '2:1'
  | '1:2'
  | '19.5:9'
  | '9:19.5'
  | '20:9'
  | '9:20'
  | 'auto'
export type GrokImageResolution = '1K' | '2K'

export type ImageGenOptions = {
  aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio | FlareImageAspectRatio
  imageSize?: GeminiImageResolution | GrokImageResolution
  n?: number
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
  background?: 'auto' | 'transparent' | 'opaque'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  outputCompression?: number
  moderation?: 'auto' | 'low'
  responseFormat?: 'b64_json' | 'url'
  providerStyle?: 'vivid' | 'natural'
  user?: string
}

/** 生一张图。渲染进程的图像页和例行任务的 imagegen 节点共用这一个入口。 */
export async function generateImage(
  payload: {
    prompt: string
    engine: 'openai' | 'gemini' | 'grok'
    batchId?: string
    model?: ImageModel
    referenceUrls?: string[]
    maskDataUrl?: string
    size?: ImageGenSize
    aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio | FlareImageAspectRatio
    imageSize?: GeminiImageResolution | GrokImageResolution
    n?: number
    quality?: ImageGenOptions['quality']
    background?: ImageGenOptions['background']
    outputFormat?: ImageGenOptions['outputFormat']
    outputCompression?: ImageGenOptions['outputCompression']
    moderation?: ImageGenOptions['moderation']
    responseFormat?: ImageGenOptions['responseFormat']
    providerStyle?: ImageGenOptions['providerStyle']
    user?: string
    /** Workflows already consume the durable public URL and do not need a blocking base64 copy. */
    downloadResult?: boolean
  },
  signal?: AbortSignal,
): Promise<ImageGenResult> {
  try {
    const batchId = payload.batchId || crypto.randomUUID()
    const references = await Promise.all(
      (payload.referenceUrls ?? []).map((reference) =>
        reference.startsWith('data:') ? cloudUploadReference(reference, signal) : reference,
      ),
    )
    if (payload.maskDataUrl && !references.length) {
      return { error: '蒙版编辑需要先选择一张底图' }
    }
    const maskUrl = payload.maskDataUrl ? await cloudUploadReference(payload.maskDataUrl, signal) : undefined
    return cloudGenerate(
      payload.prompt,
      batchId,
      references,
      maskUrl,
      payload.size,
      {
        aspectRatio: payload.aspectRatio,
        imageSize: payload.imageSize,
        n: payload.n,
        quality: payload.quality,
        background: payload.background,
        outputFormat: payload.outputFormat,
        outputCompression: payload.outputCompression,
        moderation: payload.moderation,
        responseFormat: payload.responseFormat,
        providerStyle: payload.providerStyle,
        user: payload.user,
      },
      payload.downloadResult !== false,
      payload.model,
      signal,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: msg.includes('fetch failed') ? '连不上云端图像服务' : msg }
  }
}

export function registerImageGenHandlers(): void {
  ipcMain.handle('imageGen:health', async (): Promise<ImageGenHealth> => {
    const cloudConfig = getCloudConnection()
    const cloudRes = cloudConfig.available ? await probeCloud('/imagegen/health', 3000) : null
    const cloud = cloudRes ? ((await cloudRes.json()) as Record<string, unknown>) : null
    const cloudOk = !!cloud?.ok
    return {
      ok: cloudOk,
      keyConfigured: cloudOk,
      model: typeof cloud?.model === 'string' ? cloud.model : '',
      r2: cloudOk,
    }
  })

  ipcMain.handle(
    'imageGen:generate',
    (
      _e,
      payload: {
        prompt: string
        engine: 'openai' | 'gemini' | 'grok' | 'grok'
        batchId?: string
        model?: ImageModel
        referenceUrls?: string[]
        maskDataUrl?: string
        size?: ImageGenSize
        aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
        imageSize?: GeminiImageResolution | GrokImageResolution
        n?: number
        quality?: ImageGenOptions['quality']
        background?: ImageGenOptions['background']
        outputFormat?: ImageGenOptions['outputFormat']
        outputCompression?: ImageGenOptions['outputCompression']
        moderation?: ImageGenOptions['moderation']
        responseFormat?: ImageGenOptions['responseFormat']
        providerStyle?: ImageGenOptions['providerStyle']
        user?: string
      },
    ): Promise<ImageGenResult> => generateImage(payload),
  )

  // 改图底图选定后立刻传 R2:预览用公网 URL、生成时免每次重传 base64
  ipcMain.handle(
    'imageGen:uploadReference',
    async (_e, dataUrl: string): Promise<{ ok: true; url: string } | { error: string }> => {
      try {
        const url = await cloudUploadReference(dataUrl)
        return { ok: true, url }
      } catch (err) {
        appendAppLog('warn', 'imageGen.reference', 'Reference upload failed', {
          message: err instanceof Error ? err.message : String(err),
        })
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('imageGen:history', async (_e, limit?: number): Promise<ImageGenHistoryItem[] | { error: string }> => {
    const n = Math.min(Math.max(limit ?? 60, 1), 500)
    const cloud = getCloudConnection()
    if (!cloud.available) {
      return { error: cloud.error ?? '云端图像服务未配置' }
    }
    try {
      const r = await cloudFetch(`/imagegen/history?limit=${n}&grouped=true`)
      if (!r.ok) return { error: `历史接口 ${r.status}` }
      return (await r.json()) as ImageGenHistoryItem[]
    } catch {
      return { error: '连不上云端历史服务' }
    }
  })

  ipcMain.handle('imageGen:historyDelete', async (_e, id: string): Promise<{ ok: boolean }> => {
    if (!getCloudConnection().available) return { ok: false }
    try {
      const r = await cloudFetch(`/imagegen/history/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      return { ok: r.ok }
    } catch {
      return { ok: false }
    }
  })

  // 手机端。和 IPC 走同一批函数,只有两处不同:
  //  1) downloadResult:false —— 手机拿 URL 就够,让桌面白下一份几 MB 的 base64 纯属浪费;
  //  2) 只回 urls,dataUrl 一律不带 —— 那玩意进不了 WebSocket 帧。
  remoteControl.setImageHost({
    health: async () => {
      const cloud = getCloudConnection()
      const res = cloud.available ? await probeCloud('/imagegen/health', 3000) : null
      const body = res ? ((await res.json()) as Record<string, unknown>) : null
      return {
        ok: !!body?.ok,
        model: typeof body?.model === 'string' ? body.model : '',
      }
    },
    generate: async (payload) => {
      // engine 是遗留字段(cloudGenerate 只认 model),但类型上必填 —— 按模型名推,
      // 别随手塞一个和 model 对不上的值
      const model = (payload.model ?? '').toLowerCase()
      const engine = model.includes('gemini') || model.includes('nano-banana') ? 'gemini' : model.includes('grok') ? 'grok' : 'openai'
      const result = await generateImage({
        ...payload,
        engine,
        model: payload.model as ImageModel | undefined,
        size: payload.size as ImageGenSize | undefined,
        aspectRatio: payload.aspectRatio as GeminiImageAspectRatio | GrokImageAspectRatio | undefined,
        downloadResult: false,
      })
      if ('error' in result) return { error: result.error }
      const urls = result.urls?.length
        ? result.urls
        : result.publicUrl
          ? [result.publicUrl]
          : []
      // R2 没配好时只有本地 base64,手机拿不到 —— 说清楚,别回一个空数组让人干等
      if (!urls.length) return { error: '生成成功但云端没有返回可访问的图片链接' }
      return { urls }
    },
    history: async (limit) => {
      const n = Math.min(Math.max(limit, 1), 200)
      const cloud = getCloudConnection()
      if (!cloud.available) return { error: cloud.error ?? '云端图像服务未配置' }
      try {
        const r = await cloudFetch(`/imagegen/history?limit=${n}&grouped=true`)
        if (!r.ok) return { error: `历史接口 ${r.status}` }
        return (await r.json()) as ImageGenHistoryItem[]
      } catch {
        return { error: '连不上云端历史服务' }
      }
    },
  })

  ipcMain.handle(
    'imageGen:historyDeleteBatch',
    async (_e, batchId: string): Promise<{ ok: boolean }> => {
      if (!getCloudConnection().available) return { ok: false }
      try {
        const r = await cloudFetch(`/imagegen/history-batches/${encodeURIComponent(batchId)}`, {
          method: 'DELETE',
        })
        return { ok: r.ok }
      } catch {
        return { ok: false }
      }
    },
  )
}
