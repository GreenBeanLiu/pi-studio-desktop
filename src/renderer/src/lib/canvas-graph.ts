import type { ImageModel, VideoAspectRatio, VideoGenPayload, VideoModelOption, VideoResolution } from './api'
import {
  buildImageGenerationRequest,
  imageModel,
  type ImageGenerationRequest,
  type ImageOutputSettings,
} from '../components/image-generation-models'

/**
 * 画布(2026-10-26):生图、生视频摊在一张无限画布上,连线就是输入。
 *
 *   文本 → 图片   文生图(上游文本拼在节点自己的提示词前面)
 *   图片 → 图片   参考图改图(模型不吃参考图就报错,不像出图页那样悄悄丢掉)
 *   图片 → 视频   首帧图生视频(只能接一张)
 *
 * 这里只放纯逻辑:谁是谁的输入、拼成什么请求、怎么存档。React Flow 那层在 CanvasPage.tsx。
 */

export type GenStatus = 'idle' | 'running' | 'done' | 'error'

export type TextNodeData = { kind: 'text'; text: string }
export type ImageNodeData = {
  kind: 'image'
  prompt: string
  model: ImageModel
  url?: string
  /** 本地传上来的图,没有"生成"这一步 */
  uploaded?: boolean
  status: GenStatus
  error?: string
  startedAt?: number
}
export type VideoNodeData = {
  kind: 'video'
  prompt: string
  /** 不给 = 云端默认模型 */
  model?: string
  duration?: number
  resolution?: VideoResolution
  aspectRatio?: VideoAspectRatio
  audio?: boolean
  url?: string
  status: GenStatus
  error?: string
  startedAt?: number
}
export type CanvasNodeData = TextNodeData | ImageNodeData | VideoNodeData
export type CanvasNodeKind = CanvasNodeData['kind']

/** React Flow 的 Node / Edge 里这层用得到的那部分 */
export type GraphNode = { id: string; position: { x: number; y: number }; data: CanvasNodeData; type?: string }
export type GraphEdge = { id: string; source: string; target: string }

export const CANVAS_IMAGE_OUTPUT: ImageOutputSettings = {
  count: 1,
  size: '1024x1024',
  quality: 'auto',
  background: 'auto',
  outputFormat: 'png',
  outputCompression: 90,
  moderation: 'auto',
  responseFormat: 'b64_json',
  providerStyle: 'vivid',
  requestUser: '',
  advanced: false,
  grokAspectRatio: '1:1',
  grokImageSize: '1K',
  nanoAspectRatio: 'auto',
  nanoImageSize: '1K',
  flareAspectRatio: 'auto',
  flareImageSize: '1K',
}

/** 每种节点能接谁的线。文本没有入口,视频没有出口。 */
const ACCEPTS: Record<CanvasNodeKind, readonly CanvasNodeKind[]> = {
  text: [],
  image: ['text', 'image'],
  video: ['text', 'image'],
}

export function canConnect(nodes: readonly GraphNode[], edges: readonly GraphEdge[], source: string, target: string): boolean {
  if (source === target) return false
  const from = nodes.find((n) => n.id === source)
  const to = nodes.find((n) => n.id === target)
  if (!from || !to) return false
  if (from.data.kind === 'video') return false
  if (!ACCEPTS[to.data.kind].includes(from.data.kind)) return false
  if (edges.some((e) => e.source === source && e.target === target)) return false
  return !reaches(edges, target, source)
}

/** 从 from 顺着连线能不能走到 to(连上 source→target 之前查 target 能否走回 source,防环) */
function reaches(edges: readonly GraphEdge[], from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of edges) if (e.source === id) stack.push(e.target)
  }
  return false
}

/** 直接上游,按画布上从上到下排(拼提示词的顺序和眼睛看到的一致) */
export function parentsOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[], id: string): GraphNode[] {
  const ids = new Set(edges.filter((e) => e.target === id).map((e) => e.source))
  return nodes.filter((n) => ids.has(n.id)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

function joinPrompt(parents: readonly GraphNode[], own: string): string {
  const parts = parents.flatMap((p) => (p.data.kind === 'text' ? [p.data.text.trim()] : []))
  parts.push(own.trim())
  return parts.filter(Boolean).join('\n\n')
}

function upstreamImages(parents: readonly GraphNode[]): { urls: string[]; pending: number } {
  const images = parents.flatMap((p) => (p.data.kind === 'image' ? [p.data] : []))
  const urls = images.flatMap((d) => (d.url ? [d.url] : []))
  return { urls, pending: images.length - urls.length }
}

export function buildCanvasImageRequest(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  id: string,
  batchId: string,
): ImageGenerationRequest | { error: string } {
  const node = nodes.find((n) => n.id === id)
  if (!node || node.data.kind !== 'image') return { error: '不是图片节点' }
  const parents = parentsOf(nodes, edges, id)
  const refs = upstreamImages(parents)
  if (refs.pending) return { error: '上游还有图片没生成' }
  const model = imageModel(node.data.model)
  if (refs.urls.length && !model.acceptsImage) return { error: `${model.label} 不吃参考图，换个模型或断开图片连线` }
  try {
    return buildImageGenerationRequest({
      modelKey: node.data.model,
      prompt: joinPrompt(parents, node.data.prompt),
      batchId,
      referenceUrls: refs.urls.length ? refs.urls : undefined,
      output: CANVAS_IMAGE_OUTPUT,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function buildCanvasVideoPayload(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  id: string,
): VideoGenPayload | { error: string } {
  const node = nodes.find((n) => n.id === id)
  if (!node || node.data.kind !== 'video') return { error: '不是视频节点' }
  const parents = parentsOf(nodes, edges, id)
  const refs = upstreamImages(parents)
  if (refs.pending) return { error: '首帧图片还没生成' }
  if (refs.urls.length > 1) return { error: '视频只能接一张首帧' }
  const prompt = joinPrompt(parents, node.data.prompt)
  if (!prompt) return { error: '写一下画面怎么动、镜头怎么走' }
  const d = node.data
  return {
    prompt,
    ...(refs.urls[0] ? { frameUrl: refs.urls[0] } : {}),
    ...(d.model ? { model: d.model } : {}),
    ...(d.duration ? { duration: d.duration } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
    ...(d.aspectRatio ? { aspectRatio: d.aspectRatio } : {}),
    ...(d.audio ? { audio: true } : {}),
  }
}

/** 换模型时把时长/清晰度/比例收回到新模型支持的范围里 */
export function fitVideoOptions(data: VideoNodeData, model: VideoModelOption): VideoNodeData {
  return {
    ...data,
    model: model.id,
    duration: data.duration && model.durations.includes(data.duration) ? data.duration : model.defaults.duration,
    resolution: data.resolution && model.resolutions.includes(data.resolution) ? data.resolution : model.defaults.resolution,
    aspectRatio: data.aspectRatio && model.aspectRatios.includes(data.aspectRatio) ? data.aspectRatio : model.defaults.aspectRatio,
    audio: model.audio ? data.audio : false,
  }
}

export function estimateVideoYuan(data: VideoNodeData, model: VideoModelOption | undefined): number | null {
  if (!model) return null
  const perSecond = model.yuanPerSecond[data.resolution ?? model.defaults.resolution]
  return perSecond == null ? null : perSecond * (data.duration ?? model.defaults.duration)
}

/** 工具栏加节点:从视口中心开始,被占了就往右挪一格,别叠在一起 */
export function freeSpot(nodes: readonly GraphNode[], start: { x: number; y: number }, width: number): { x: number; y: number } {
  const step = width + 60
  let at = start
  for (let i = 0; i < 30; i++) {
    const taken = nodes.some((n) => Math.abs(n.position.x - at.x) < step - 20 && Math.abs(n.position.y - at.y) < 200)
    if (!taken) return at
    at = { x: at.x + step, y: at.y }
  }
  return at
}

let seq = 0
export function newId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

export function blankData(kind: CanvasNodeKind): CanvasNodeData {
  if (kind === 'text') return { kind, text: '' }
  if (kind === 'image') return { kind, prompt: '', model: 'gpt-image-2', status: 'idle' }
  return { kind, prompt: '', status: 'idle' }
}

/** 同一组输入再出一张:复制节点(不带结果)和它所有入线,放在右下方 */
export function variantOf(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  id: string,
): { node: GraphNode; edges: GraphEdge[] } | null {
  const node = nodes.find((n) => n.id === id)
  if (!node || node.data.kind === 'text') return null
  const copyId = newId(node.data.kind)
  const data = { ...node.data, status: 'idle' } as Partial<ImageNodeData>
  delete data.url
  delete data.error
  delete data.startedAt
  delete data.uploaded
  return {
    node: { id: copyId, type: node.type, position: { x: node.position.x + 40, y: node.position.y + 60 }, data: data as CanvasNodeData },
    edges: edges.filter((e) => e.target === id).map((e) => ({ id: newId('e'), source: e.source, target: copyId })),
  }
}

export type CanvasSnapshot = {
  version: 1
  nodes: GraphNode[]
  edges: GraphEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

/** 存档时生成中的节点没法续上(结果只回给发起请求的那次调用),读回来标成中断 */
export function parseCanvas(raw: string | null): CanvasSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasSnapshot>
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    const nodes = parsed.nodes
      .filter((n): n is GraphNode => !!n && typeof n.id === 'string' && !!n.data && typeof n.data === 'object' && !!n.position)
      .map((n) => {
        if (n.data.kind === 'text' || n.data.status !== 'running') return n
        return { ...n, data: { ...n.data, status: 'error' as const, error: '生成中断了（应用重开过），结果可能在出图/视频历史里', startedAt: undefined } }
      })
    const ids = new Set(nodes.map((n) => n.id))
    const edges = parsed.edges.filter((e) => !!e && ids.has(e.source) && ids.has(e.target))
    return { version: 1, nodes, edges, ...(parsed.viewport ? { viewport: parsed.viewport } : {}) }
  } catch {
    return null
  }
}

export function serializeCanvas(snapshot: Omit<CanvasSnapshot, 'version'>): string {
  const nodes = snapshot.nodes.map(({ id, type, position, data }) => ({ id, type, position, data }))
  const edges = snapshot.edges.map(({ id, source, target }) => ({ id, source, target }))
  return JSON.stringify({ version: 1, nodes, edges, ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}) })
}
