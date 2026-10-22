import { describe, expect, it } from 'vitest'
import { routineStepSchema, stepProductSchema } from './routines'

describe('routine workflow node schemas', () => {
  it('validates node-specific required input fields', () => {
    const notify = routineStepSchema('notify')
    expect(() => notify.parse({ id: 'step', name: 'Notify', type: 'notify' })).toThrow('输入无效')
    expect(
      notify.parse({ id: 'step', name: 'Notify', type: 'notify', channelId: 'channel-1' }),
    ).toMatchObject({ channelId: 'channel-1' })
  })

  it('accepts an imagegen canvas but rejects sizes the API does not know', () => {
    const imagegen = routineStepSchema('imagegen')
    const base = { id: 'step', name: '生图', type: 'imagegen' as const, prompt: '画一只猫' }
    expect(imagegen.parse({ ...base, size: '1536x1024' })).toMatchObject({ size: '1536x1024' })
    // 留空 = 服务端默认,不是错误
    expect(imagegen.parse(base)).toMatchObject({ type: 'imagegen' })
    expect(() => imagegen.parse({ ...base, size: '4096x4096' })).toThrow('输入无效')
  })

  it('loads a saved 3D step that still names Hi3D by sending it to Tripo, and rejects unknown providers', () => {
    const model3d = routineStepSchema('model3d')
    const base = { id: 'step', name: '3D', type: 'model3d' as const, prompt: '杯子' }
    const legacy = model3d.parse({ ...base, provider: 'hi3d' })
    expect(legacy.provider).toBeUndefined()
    expect(model3d.parse({ ...base, provider: 'tripo' })).toMatchObject({ provider: 'tripo' })
    expect(() => model3d.parse({ ...base, provider: 'meshy' })).toThrow('输入无效')
  })

  it('validates optional output fields and image descriptors', () => {
    expect(() => stepProductSchema.parse({ output: 'done', imageUrl: 123 })).toThrow('StepProduct')
    expect(
      stepProductSchema.parse({
        output: 'done',
        images: [
          {
            id: 'image-1',
            kind: 'image',
            source: 'generated',
            name: 'Cover',
            role: 'cover',
            uri: 'https://example.com/image.png',
          },
        ],
      }),
    ).toMatchObject({ output: 'done' })
  })
})
