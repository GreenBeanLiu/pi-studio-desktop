import { describe, expect, it } from 'vitest'
import { createRoutineStepFromPreset, ROUTINE_NODE_PRESETS } from './routine-node-presets'

describe('routine node presets', () => {
  it('contains the article building blocks', () => {
    expect(ROUTINE_NODE_PRESETS.map((preset) => preset.id)).toEqual(
      expect.arrayContaining([
        'input.material-folder',
        'article.research',
        'article.draft',
        'article.approval',
        'media.app-icon-master',
        'output.wechat-html',
        'output.wechat-draft',
        'output.app-icon-bundle',
      ]),
    )
    // 换装视频(可灵)2026-09-29 删了,节点库里不该再出现
    expect(ROUTINE_NODE_PRESETS.map((preset) => preset.id)).not.toContain('media.dressup-video')
  })

  it('ships a canvas with the image presets instead of hiding it in prose', () => {
    // 以前比例只能写在提示词正文里,加了 step.size 之后预设自己带
    expect(createRoutineStepFromPreset('media.cover')).toMatchObject({
      type: 'imagegen',
      size: '1536x1024',
    })
    expect(createRoutineStepFromPreset('media.app-icon-master')).toMatchObject({
      type: 'imagegen',
      size: '1024x1024',
    })
  })

  it('creates independent steps and injects the selected notification channel', () => {
    const first = createRoutineStepFromPreset('output.notify', 'channel-1')
    const second = createRoutineStepFromPreset('output.notify', 'channel-2')
    expect(first).toMatchObject({ type: 'notify', channelId: 'channel-1' })
    expect(second).toMatchObject({ type: 'notify', channelId: 'channel-2' })
    expect(first?.id).not.toBe(second?.id)
  })
})
