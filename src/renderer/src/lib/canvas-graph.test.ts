import { describe, expect, it } from 'vitest'

import type { VideoModelOption } from './api'
import {
  buildCanvasImageRequest,
  buildCanvasVideoPayload,
  canConnect,
  estimateVideoYuan,
  fitVideoOptions,
  parseCanvas,
  serializeCanvas,
  variantOf,
  type CanvasNodeData,
  type GraphEdge,
  type GraphNode,
  type VideoNodeData,
} from './canvas-graph'

function node(id: string, data: CanvasNodeData, y = 0): GraphNode {
  return { id, type: data.kind, position: { x: 0, y }, data }
}
const edge = (source: string, target: string): GraphEdge => ({ id: `${source}>${target}`, source, target })

const text = (t: string) => ({ kind: 'text', text: t }) as const
const image = (extra: Partial<Extract<CanvasNodeData, { kind: 'image' }>> = {}) =>
  ({ kind: 'image', prompt: '', model: 'gpt-image-2', status: 'idle', ...extra }) as const
const video = (extra: Partial<VideoNodeData> = {}): VideoNodeData => ({ kind: 'video', prompt: '', status: 'idle', ...extra })

describe('canConnect', () => {
  const nodes = [node('t', text('猫')), node('a', image()), node('b', image()), node('v', video())]

  it('allows text/image into image and video', () => {
    expect(canConnect(nodes, [], 't', 'a')).toBe(true)
    expect(canConnect(nodes, [], 'a', 'v')).toBe(true)
    expect(canConnect(nodes, [], 't', 'v')).toBe(true)
  })

  it('rejects edges into text, out of video, duplicates and cycles', () => {
    expect(canConnect(nodes, [], 'a', 't')).toBe(false)
    expect(canConnect(nodes, [], 'v', 'a')).toBe(false)
    expect(canConnect(nodes, [edge('a', 'b')], 'a', 'b')).toBe(false)
    expect(canConnect(nodes, [edge('a', 'b')], 'b', 'a')).toBe(false)
    expect(canConnect(nodes, [], 'a', 'a')).toBe(false)
  })
})

describe('buildCanvasImageRequest', () => {
  it('joins upstream text top-to-bottom before the node prompt', () => {
    const nodes = [node('t2', text('白底'), 100), node('t1', text('一只猫'), 0), node('a', image({ prompt: '侧脸' }))]
    const req = buildCanvasImageRequest(nodes, [edge('t2', 'a'), edge('t1', 'a')], 'a', 'batch')
    expect(req).toMatchObject({ prompt: '一只猫\n\n白底\n\n侧脸', engine: 'openai', n: 1, batchId: 'batch' })
    expect(req).not.toHaveProperty('referenceUrls')
  })

  it('passes upstream images as references', () => {
    const nodes = [node('src', image({ url: 'https://r2/a.png', status: 'done' })), node('a', image({ prompt: '换成夜景' }))]
    expect(buildCanvasImageRequest(nodes, [edge('src', 'a')], 'a', 'b')).toMatchObject({ referenceUrls: ['https://r2/a.png'] })
  })

  it('refuses instead of silently dropping references for text-only models', () => {
    const nodes = [node('src', image({ url: 'https://r2/a.png' })), node('a', image({ prompt: 'x', model: 'grok-imagine-image' }))]
    expect(buildCanvasImageRequest(nodes, [edge('src', 'a')], 'a', 'b')).toEqual({ error: expect.stringContaining('不吃参考图') })
  })

  it('waits for upstream images that have no result yet', () => {
    const nodes = [node('src', image()), node('a', image({ prompt: 'x' }))]
    expect(buildCanvasImageRequest(nodes, [edge('src', 'a')], 'a', 'b')).toEqual({ error: '上游还有图片没生成' })
  })

  it('reports an empty prompt', () => {
    expect(buildCanvasImageRequest([node('a', image())], [], 'a', 'b')).toEqual({ error: '请输入文字或上传图片' })
  })
})

describe('buildCanvasVideoPayload', () => {
  it('uses the single upstream image as first frame', () => {
    const nodes = [node('f', image({ url: 'https://r2/f.png' })), node('v', video({ prompt: '镜头推近', duration: 8 }))]
    expect(buildCanvasVideoPayload(nodes, [edge('f', 'v')], 'v')).toEqual({ prompt: '镜头推近', frameUrl: 'https://r2/f.png', duration: 8 })
  })

  it('rejects two first frames', () => {
    const nodes = [node('f', image({ url: 'u1' })), node('g', image({ url: 'u2' })), node('v', video({ prompt: 'x' }))]
    expect(buildCanvasVideoPayload(nodes, [edge('f', 'v'), edge('g', 'v')], 'v')).toEqual({ error: '视频只能接一张首帧' })
  })

  it('takes the prompt from upstream text alone', () => {
    const nodes = [node('t', text('海浪')), node('v', video())]
    expect(buildCanvasVideoPayload(nodes, [edge('t', 'v')], 'v')).toEqual({ prompt: '海浪' })
  })
})

const seedance: VideoModelOption = {
  id: 'seedance',
  label: 'Seedance',
  description: '',
  durations: [5, 10],
  resolutions: ['480p', '720p'],
  aspectRatios: ['16:9', '9:16'],
  audio: true,
  defaults: { duration: 5, resolution: '720p', aspectRatio: '16:9' },
  yuanPerSecond: { '720p': 0.5 },
  ok: true,
}

describe('video options', () => {
  it('clamps unsupported options to the new model defaults', () => {
    expect(fitVideoOptions(video({ duration: 8, resolution: '480p', aspectRatio: '1:1' }), seedance)).toMatchObject({
      model: 'seedance',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
    })
  })

  it('estimates price from defaults when unset', () => {
    expect(estimateVideoYuan(video(), seedance)).toBe(2.5)
    expect(estimateVideoYuan(video({ resolution: '480p' }), seedance)).toBeNull()
  })
})

describe('variantOf', () => {
  it('copies inputs but not the result', () => {
    const nodes = [node('t', text('猫')), node('a', image({ url: 'u', status: 'done', prompt: 'p' }))]
    const v = variantOf(nodes, [edge('t', 'a')], 'a')!
    expect(v.node.data).toEqual({ kind: 'image', prompt: 'p', model: 'gpt-image-2', status: 'idle' })
    expect(v.edges).toEqual([expect.objectContaining({ source: 't', target: v.node.id })])
  })
})

describe('persistence', () => {
  it('round-trips and marks interrupted generations', () => {
    const nodes = [node('a', image({ status: 'running', startedAt: 1 })), node('b', image({ url: 'u', status: 'done' }))]
    const back = parseCanvas(serializeCanvas({ nodes, edges: [edge('b', 'a'), edge('gone', 'a')] }))!
    expect(back.nodes[0].data).toMatchObject({ status: 'error', startedAt: undefined })
    expect(back.nodes[1].data).toMatchObject({ status: 'done', url: 'u' })
    expect(back.edges).toEqual([edge('b', 'a')])
  })

  it('ignores garbage', () => {
    expect(parseCanvas('{')).toBeNull()
    expect(parseCanvas(JSON.stringify({ version: 2, nodes: [], edges: [] }))).toBeNull()
  })
})
