import { ipcMain, app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getCloudConnection } from './cloud-connection'
import { abortSignalWithTimeout } from './abort-signal'
import { appendAppLog, normalizeError } from './app-log'
import { reviewModelRender, type VisionReview } from './vision-review'
import { cloudFetch as netFetch } from './cloud-fetch'

/**
 * 3D 生成:Tripo3D 调用已抽离到服务端(trigger.dev `gen-model-3d` 任务),客户端
 * 只经 VPS 中继(trail-api /model3d SSE)提交→拿 R2 上的 glb URL,再下载到本地
 * (中继/R2 与图像生成共用同一 relay + key,见 image-gen.ts 的 getCloud)。
 * 渲染进程用 three.js 预览。服务端链路:relay → trigger.dev → Tripo → R2。
 */

const CLOUD_TIMEOUT_MS = 600_000

export function modelsDir(): string {
  const d = join(app.getPath('userData'), 'models3d')
  mkdirSync(d, { recursive: true })
  return d
}

function indexPath(): string {
  return join(modelsDir(), 'index.json')
}

export type Model3DHealth = {
  configured: boolean
  /** 各 3D 服务商密钥是否就绪;探测失败时缺失 */
  providers?: Record<Model3DProvider, boolean>
}

/** 云端 3D 服务商。Hi3D 2026-10-23 删了(按次付费、不用),只剩 Tripo。 */
export type Model3DProvider = 'tripo'

export type Model3DOptions = {
  modelVersion?: string
  faceLimit?: number
  texture?: boolean
  pbr?: boolean
  style?: string
  /** Tripo 专有:几何质量,仅 v3.0/v3.1 支持(P1 已预调优、不接受该参数) */
  geometryQuality?: string
}

export type Model3DHistoryItem = {
  id: string
  prompt: string
  mode: 'text' | 'image' | 'code' | 'blender'
  modelUrl: string
  /** R2 上的 glb 公网地址,用于下载/分享(用户自有 OSS) */
  cloudModelUrl?: string
  thumbnailUrl: string | null
  createdAt: number
  options?: Model3DOptions
  /** AI 视觉还原度评审(异步补写,可能缺失) */
  fidelity?: VisionReview
}

export type Model3DResult = Model3DHistoryItem | { error: string }

export function loadHistory(): Model3DHistoryItem[] {
  try {
    if (!existsSync(indexPath())) return []
    const items = JSON.parse(readFileSync(indexPath(), 'utf-8')) as Model3DHistoryItem[]
    // 只保留本地文件仍存在的记录
    return items.filter((it) => existsSync(join(modelsDir(), `${it.id}.glb`)))
  } catch {
    return []
  }
}

export function saveHistory(items: Model3DHistoryItem[]): void {
  writeFileSync(indexPath(), JSON.stringify(items.slice(0, 200), null, 2), 'utf-8')
}

/** 本地文件路径转成渲染进程可加载的 file:// URL。 */
export function localFileUrl(p: string): string {
  return `file:///${p.replace(/\\/g, '/')}`
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

type GeneratePayload = {
  mode: 'text' | 'image'
  prompt: string
  imageDataUrl?: string
  /** 图生模式:true = 先用 gpt-image-2 按 prompt 生成参考图,再图生 3D(可不带 imageDataUrl) */
  aiImage?: boolean
  provider?: Model3DProvider
  options?: Model3DOptions
}

async function cloudFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const cloud = getCloudConnection()
  if (!cloud.available) throw new Error(cloud.error ?? '云端 3D 服务未配置(设置 → 生图 → 云端中继)')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return netFetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

/** 图生 3D:把参考图上传到 R2(复用 imagegen 的 /reference),拿到公网 URL 给中继。 */
async function uploadReference(dataUrl: string): Promise<string> {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) throw new Error('参考图 data URL 无法解析')
  const resp = await cloudFetch(
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: m[2], content_type: m[1] }),
    },
    60_000,
  )
  if (!resp.ok) throw new Error(`参考图上传失败(${resp.status}): ${(await resp.text()).slice(0, 200)}`)
  const r = (await resp.json()) as { url?: string }
  if (!r.url) throw new Error('参考图上传成功但没有返回 URL')
  return r.url
}

async function download(url: string, dest: string): Promise<void> {
  const res = await netFetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

/** 用 gpt-image-2 按提示词生成一张适合图生 3D 的参考图,返回 R2 公网 URL。 */
async function genGptImage(prompt: string): Promise<string> {
  const imagePrompt = `${prompt}，单个主体居中，纯白背景，正面视角，产品照，无阴影投影，写实清晰`
  const resp = await cloudFetch(
    '/imagegen',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: imagePrompt }),
    },
    CLOUD_TIMEOUT_MS,
  )
  if (!resp.ok || !resp.body)
    throw new Error(`生图失败 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
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
      if (event === 'error') throw new Error(data.message || '生图失败')
      if (event === 'result') {
        const url = (data.urls as string[] | undefined)?.[0]
        if (!url) throw new Error('生图完成但没有返回图片')
        return url
      }
    }
  }
  throw new Error('生图流结束但没有结果')
}

/** 拉一张远程图片转成 data URL(给 AI 视觉评审当参考图)。 */
async function urlToDataUrl(url: string): Promise<string> {
  const res = await netFetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`取图失败 HTTP ${res.status}`)
  const ct = res.headers.get('content-type') || 'image/png'
  return `data:${ct};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
}

/**
 * 纯云端图生/文生 3D 调用(给工作流节点用):不碰历史/进度/下载,只返回 R2 上的模型 URL。
 * 有 imageUrl 走图生 3D,否则用 prompt 走文生 3D。
 */
export async function cloud3dGenerate(
  params: {
    imageUrl?: string
    prompt?: string
    provider?: Model3DProvider
    options?: Model3DOptions
  },
  signal?: AbortSignal,
): Promise<{ modelUrl: string; thumbnailUrl: string | null }> {
  const resp = await cloudFetch(
    '/model3d',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params.imageUrl ? { imageUrl: params.imageUrl } : {}),
        ...(params.prompt ? { prompt: params.prompt } : {}),
        provider: params.provider ?? 'tripo',
        options: params.options ?? {},
      }),
      signal: abortSignalWithTimeout(signal, CLOUD_TIMEOUT_MS),
    },
    CLOUD_TIMEOUT_MS,
  )
  if (!resp.ok || !resp.body)
    throw new Error(`云端 3D ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let modelUrl: string | undefined
  let thumbUrl: string | null = null
  outer: while (true) {
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
      if (event === 'error') throw new Error(data.message || '云端 3D 生成失败')
      if (event === 'result') {
        modelUrl = data.modelUrl
        thumbUrl = data.thumbnailUrl ?? null
        break outer
      }
    }
  }
  if (!modelUrl) throw new Error('云端 3D 完成但没有返回模型 URL')
  return { modelUrl, thumbnailUrl: thumbUrl }
}

async function generate(payload: GeneratePayload): Promise<Model3DResult> {
  if (payload.mode === 'text' && !payload.prompt.trim()) return { error: '请输入文字提示词' }
  if (payload.mode === 'image' && !payload.imageDataUrl && !(payload.aiImage && payload.prompt.trim()))
    return { error: '请提供参考图片,或填写描述用 AI 生图' }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // 进度事件带上 prompt/mode,渲染进程据此在历史画廊里渲染"生成中"占位卡
  const progress = (status: string, pct: number): void =>
    broadcast('model3d:progress', {
      id,
      status,
      progress: pct,
      prompt: payload.prompt,
      mode: payload.mode,
    })
  try {
    let imageUrl: string | undefined
    // 评审参考图:上传模式=用户图;AI 生图模式=生成的图(下面补);文生模式=无
    let reviewReferenceDataUrl: string | undefined = payload.imageDataUrl
    if (payload.mode === 'image') {
      if (payload.aiImage && !payload.imageDataUrl) {
        // 先用 gpt-image-2 生成参考图,直接拿 R2 URL 喂图生 3D(免二次上传)
        progress('generating-image', 0)
        imageUrl = await genGptImage(payload.prompt)
        try {
          reviewReferenceDataUrl = await urlToDataUrl(imageUrl)
        } catch {
          reviewReferenceDataUrl = undefined // 评审参考可缺省,不阻断生成
        }
      } else if (payload.imageDataUrl) {
        progress('uploading', 0)
        imageUrl = await uploadReference(payload.imageDataUrl)
      }
    }

    progress('submitting', 0)
    const resp = await cloudFetch(
      '/model3d',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(imageUrl ? { imageUrl } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          provider: payload.provider ?? 'tripo',
          options: payload.options ?? {},
        }),
      },
      CLOUD_TIMEOUT_MS,
    )
    if (!resp.ok || !resp.body)
      throw new Error(`云端中继 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)

    // 读 SSE:status(阶段/进度) → result{modelUrl,thumbnailUrl} / error
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let modelUrl: string | undefined
    let thumbUrl: string | null = null
    outer: while (true) {
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
        if (event === 'error') throw new Error(data.message || '云端 3D 生成失败')
        if (event === 'status') {
          const stage = String(data.stage ?? '')
          const pm = /running:(\d+)/.exec(stage)
          progress(pm ? 'running' : stage || 'running', pm ? Number(pm[1]) : 0)
        }
        if (event === 'result') {
          modelUrl = data.modelUrl
          thumbUrl = data.thumbnailUrl ?? null
          break outer
        }
      }
    }
    if (!modelUrl) throw new Error('云端任务完成但没有返回模型 URL')

    progress('downloading', 100)
    const glbPath = join(modelsDir(), `${id}.glb`)
    await download(modelUrl, glbPath)
    let thumbPath: string | null = null
    if (thumbUrl) {
      try {
        const p = join(modelsDir(), `${id}.png`)
        await download(thumbUrl, p)
        thumbPath = p
      } catch {
        thumbPath = null
      }
    }

    const item: Model3DHistoryItem = {
      id,
      prompt: payload.mode === 'image' ? payload.prompt || '(图生 3D)' : payload.prompt,
      mode: payload.mode,
      modelUrl: localFileUrl(glbPath),
      cloudModelUrl: modelUrl,
      thumbnailUrl: thumbPath ? localFileUrl(thumbPath) : null,
      createdAt: Date.now(),
      ...(payload.options ? { options: payload.options } : {}),
    }
    saveHistory([item, ...loadHistory()])
    progress('done', 100)
    if (thumbPath)
      void scoreFidelity(
        item,
        {
          mode: payload.mode,
          prompt: payload.prompt,
          referenceDataUrl: reviewReferenceDataUrl,
        },
        thumbPath,
      )
    return item
  } catch (err) {
    appendAppLog('error', 'model3d.generate', '3D 生成失败', normalizeError(err))
    progress('error', 0)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** 生成完成后异步评分:不阻塞返回,失败静默(记日志),成功补写历史并广播。 */
async function scoreFidelity(
  item: Model3DHistoryItem,
  review: { mode: 'text' | 'image'; prompt: string; referenceDataUrl?: string },
  thumbPath: string,
): Promise<void> {
  try {
    const renderDataUrl = `data:image/png;base64,${readFileSync(thumbPath).toString('base64')}`
    const fidelity = await reviewModelRender({
      mode: review.mode,
      prompt: review.prompt,
      ...(review.referenceDataUrl ? { referenceDataUrl: review.referenceDataUrl } : {}),
      renderDataUrl,
    })
    saveHistory(loadHistory().map((it) => (it.id === item.id ? { ...it, fidelity } : it)))
    broadcast('model3d:scored', { id: item.id, fidelity })
  } catch (err) {
    appendAppLog('warn', 'model3d.score', 'AI 还原度评分失败', normalizeError(err))
  }
}

/** 渲染进程回传的模型截图 → 存缩略图并补 AI 评分(代码建模/Blender 模型没有 Tripo 缩略图)。 */
async function saveThumbnail(id: string, dataUrl: string): Promise<Model3DResult> {
  const item = loadHistory().find((it) => it.id === id)
  if (!item) return { error: '模型不存在' }
  if (item.thumbnailUrl) return item
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl)
  if (!m) return { error: '截图数据无法解析' }
  const thumbPath = join(modelsDir(), `${id}.png`)
  writeFileSync(thumbPath, Buffer.from(m[1], 'base64'))
  const updated: Model3DHistoryItem = {
    ...item,
    thumbnailUrl: localFileUrl(thumbPath),
  }
  saveHistory(loadHistory().map((it) => (it.id === id ? updated : it)))
  if (!item.fidelity && item.prompt) {
    void scoreFidelity(updated, { mode: 'text', prompt: item.prompt }, thumbPath)
  }
  return updated
}

/** 视觉闭环用:存这一轮渲染截图为缩略图 + 同步 AI 评审 + 返回分数(渲染进程据此决定是否继续改码)。 */
async function reviewRound(id: string, dataUrl: string, prompt: string): Promise<VisionReview | { error: string }> {
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl)
  if (!m) return { error: '截图数据无法解析' }
  const thumbPath = join(modelsDir(), `${id}.png`)
  writeFileSync(thumbPath, Buffer.from(m[1], 'base64'))
  saveHistory(loadHistory().map((it) => (it.id === id ? { ...it, thumbnailUrl: localFileUrl(thumbPath) } : it)))
  try {
    const fidelity = await reviewModelRender({
      mode: 'text',
      prompt,
      renderDataUrl: dataUrl,
    })
    saveHistory(loadHistory().map((it) => (it.id === id ? { ...it, fidelity } : it)))
    broadcast('model3d:scored', { id, fidelity })
    return fidelity
  } catch (err) {
    appendAppLog('warn', 'model3d.reviewRound', 'AI 评审失败', normalizeError(err))
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerModel3d(): void {
  ipcMain.handle('model3d:health', async (): Promise<Model3DHealth> => {
    const configured = getCloudConnection().available
    // 各服务商的密钥在服务端(worker 与 API 共用 .env),本地看不到,问一次云端。
    let providers: Model3DHealth['providers']
    if (configured) {
      try {
        const resp = await cloudFetch('/imagegen/health', {}, 3_000)
        if (resp.ok) {
          const body = (await resp.json()) as {
            model3dProviders?: Record<string, boolean>
          }
          if (body.model3dProviders) {
            providers = {
              tripo: !!body.model3dProviders.tripo,
            }
          }
        }
      } catch {
        // 探测失败就不报告服务商状态,前端按"未知"处理(不拦生成)
      }
    }
    return { configured, ...(providers ? { providers } : {}) }
  })
  ipcMain.handle('model3d:generate', (_e, payload: GeneratePayload) => generate(payload))
  ipcMain.handle('model3d:history', (): Model3DHistoryItem[] => loadHistory())
  ipcMain.handle('model3d:saveThumbnail', (_e, payload: { id: string; dataUrl: string }) =>
    saveThumbnail(payload.id, payload.dataUrl),
  )
  ipcMain.handle('model3d:reviewRound', (_e, payload: { id: string; dataUrl: string; prompt: string }) =>
    reviewRound(payload.id, payload.dataUrl, payload.prompt),
  )
  ipcMain.handle('model3d:historyDelete', (_e, id: string) => {
    saveHistory(loadHistory().filter((it) => it.id !== id))
    for (const ext of ['glb', 'png']) {
      const p = join(modelsDir(), `${id}.${ext}`)
      try {
        if (existsSync(p)) rmSync(p)
      } catch {
        /* ignore */
      }
    }
    return { ok: true }
  })
}
