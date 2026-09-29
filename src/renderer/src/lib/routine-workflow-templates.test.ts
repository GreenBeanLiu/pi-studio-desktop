import { describe, expect, it } from 'vitest'
import { memeWorkflowTemplate } from './routine-workflow-templates'

describe('routine workflow templates', () => {
  it('creates a reviewable Chinese meme workflow', () => {
    const template = memeWorkflowTemplate('D:\\Works\\meme-lab')

    expect(template).toMatchObject({
      name: '表情包生成',
      workspacePath: 'D:\\Works\\meme-lab',
      scheduleType: 'manual',
      notify: 'error',
      steps: [
        { name: '策划表情包', type: 'agent' },
        { name: '确认梗和文案', type: 'review' },
        { name: '生成表情包', type: 'imagegen', engine: 'openai' },
        { name: '确认表情包成品', type: 'review' },
      ],
    })
    expect(template.steps[0].prompt).toContain('每行不超过 10 个汉字')
    expect(template.steps[2].prompt).toContain('{{steps.策划表情包.output}}')
  })
})
