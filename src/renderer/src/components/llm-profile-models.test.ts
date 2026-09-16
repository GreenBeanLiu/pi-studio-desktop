import { describe, expect, it } from 'vitest'
import { formatLlmProfileModels, parseLlmProfileModels } from './llm-profile-models'

describe('llm profile models text', () => {
  it('parses one model per line and also accepts commas', () => {
    expect(parseLlmProfileModels('grok-4.6\ngrok-4.6-fast')).toEqual(['grok-4.6', 'grok-4.6-fast'])
    expect(parseLlmProfileModels('gpt-5.4, grok-4.6，grok-4.6-fast')).toEqual([
      'gpt-5.4',
      'grok-4.6',
      'grok-4.6-fast',
    ])
  })

  it('drops blank segments and duplicates without touching the text being typed', () => {
    // 正在输入的文本可以带着悬空的换行/逗号(用户刚敲下去,还没写下一个名字)。
    const typing = 'grok-4.6\n'
    expect(parseLlmProfileModels(typing)).toEqual(['grok-4.6'])
    expect(parseLlmProfileModels('grok-4.6,\n\n grok-4.6 ,')).toEqual(['grok-4.6'])
  })

  it('round-trips a saved model list back into the textarea', () => {
    const models = ['gpt-5.4', 'gpt-5.6-sol', 'grok-4.6', 'grok-4.6-fast']
    expect(parseLlmProfileModels(formatLlmProfileModels(models))).toEqual(models)
    expect(formatLlmProfileModels([])).toBe('')
  })
})
