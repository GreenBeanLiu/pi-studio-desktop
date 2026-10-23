import { describe, expect, it } from 'vitest'

import { buildImageGenerationRequest, defaultImageModel, type ImageOutputSettings } from './image-generation-models'

const output: ImageOutputSettings = {
  count: 4,
  size: '1024x1024',
  quality: 'high',
  background: 'transparent',
  outputFormat: 'webp',
  outputCompression: 85,
  moderation: 'auto',
  responseFormat: 'url',
  providerStyle: 'natural',
  requestUser: 'pi-studio-test',
  advanced: true,
  grokAspectRatio: '20:9',
  grokImageSize: '2K',
  nanoAspectRatio: '1:4',
  nanoImageSize: '4K',
  flareAspectRatio: '9:8',
  flareImageSize: '2K',
}

describe('image generation model catalog', () => {
  it('maps stored engine preferences to a model', () => {
    expect(defaultImageModel('openai')).toBe('gpt-image-2')
    // Gemini Flash currently returns 400 through the configured relay; Pro is verified.
    expect(defaultImageModel('gemini')).toBe('gpt-image-2') // Gemini 下线后,存着它的设置回到默认
    // grok 2026-09-04 随 3A 下架移除,09-05 改挂 heilovehei 的 grok 分组后恢复
    expect(defaultImageModel('grok')).toBe('grok-imagine-image')
    // 本地引擎已移除:老设置里存的 'comfy' 回退到云端默认
    expect(defaultImageModel('comfy')).toBe('gpt-image-2')
  })

  it('builds one four-image GPT batch from an image-only input', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2',
      prompt: '',
      batchId: 'batch-1',
      referenceUrls: ['https://assets.example/input.png'],
      output,
    })
    expect(request.prompt).not.toBe('')
    expect(request.n).toBe(4)
    expect(request.referenceUrls).toEqual(['https://assets.example/input.png'])
    expect(request.outputFormat).toBe('webp')
    expect(request.outputCompression).toBe(85)
  })

  it('forces a masked edit to one image', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2',
      prompt: 'replace the sky',
      batchId: 'batch-2',
      referenceUrls: ['https://assets.example/input.png'],
      maskDataUrl: 'data:image/png;base64,mask',
      output,
    })
    expect(request.n).toBe(1)
  })


  it('forces a masked edit to one image', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2',
      prompt: 'replace the sky',
      batchId: 'batch-2',
      referenceUrls: ['https://assets.example/input.png'],
      maskDataUrl: 'data:image/png;base64,mask',
      output,
    })
    expect(request.n).toBe(1)
  })

  // 2026-09-04 删掉了一条 "acceptsImage: false 的模型要丢掉 referenceUrls" 的用例 ——
  // 它是拿 grok-imagine-image-quality 驱动的,而 grok 已随 3A 下架移除。目录里现在
  // 每个模型都 acceptsImage: true,那条分支暂时没有模型能覆盖到;代码里保留着,
  // 等下一个不吃参考图的模型进来再补测试。

  it('sends Nano Banana its ratio and resolution, keeps references, drops a mask', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'nano-banana-2.1',
      prompt: '换成大理石台面',
      batchId: 'batch-3',
      referenceUrls: ['https://assets.example/input.png'],
      maskDataUrl: 'data:image/png;base64,mask',
      output,
    })
    expect(request).toMatchObject({ model: 'nano-banana-2.1', engine: 'gemini', aspectRatio: '1:4', imageSize: '4K', n: 4 })
    expect(request.referenceUrls).toEqual(['https://assets.example/input.png'])
    expect(request.maskDataUrl).toBeUndefined()
    expect(request.quality).toBeUndefined()
  })

  it('sends Flare its ratio, keeps references, and holds the 1K-only ratios at 1K', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2.5-flare',
      prompt: '新品海报',
      batchId: 'batch-4',
      referenceUrls: ['https://assets.example/input.png'],
      maskDataUrl: 'data:image/png;base64,mask',
      output,
    })
    expect(request).toMatchObject({ model: 'gpt-image-2.5-flare', aspectRatio: '9:8', imageSize: '1K' })
    expect(request.referenceUrls).toEqual(['https://assets.example/input.png'])
    expect(request.maskDataUrl).toBeUndefined()
    const wide = buildImageGenerationRequest({ modelKey: 'gpt-image-2.5-flare', prompt: 'x', batchId: 'b', output: { ...output, flareAspectRatio: '16:9' } })
    expect(wide.imageSize).toBe('2K')
  })
})
