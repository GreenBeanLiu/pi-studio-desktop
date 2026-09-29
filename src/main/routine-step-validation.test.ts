import { describe, expect, it } from 'vitest'
import { isRoutineStepComplete } from './routine-step-validation'

describe('routine step validation', () => {
  it('keeps a feishu-doc node when it has no agent prompt', () => {
    expect(isRoutineStepComplete({ name: '存飞书文档', type: 'feishu-doc' })).toBe(true)
  })

  it('keeps a wechat draft node when it has no agent prompt', () => {
    expect(isRoutineStepComplete({ name: '微信公众号草稿', type: 'wechat-draft' })).toBe(true)
  })

  it('keeps an optional material folder node when it has no agent prompt', () => {
    expect(isRoutineStepComplete({ name: '本地素材', type: 'folder-input' })).toBe(true)
  })

  it('still requires prompts and notification channels for their respective nodes', () => {
    expect(isRoutineStepComplete({ name: '写正文', type: 'agent' })).toBe(false)
    expect(isRoutineStepComplete({ name: '发送通知', type: 'notify' })).toBe(false)
    expect(isRoutineStepComplete({ name: '发送通知', type: 'notify', channelId: 'ch-1' })).toBe(true)
  })
})
