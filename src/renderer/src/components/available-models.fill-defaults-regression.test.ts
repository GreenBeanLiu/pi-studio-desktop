import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmProviderProfile } from '../../../shared/contracts'
import { buildGatewayModel, PI_CUSTOM_MODEL_DEFAULTS } from '../../../shared/gateway-model'
import { mergeAvailableModelInfo } from './available-models'

// 回归:运行时快照没跟上时，渲染层按线路配置补出来的模型条目自己编了一套默认值 ——
// contextWindow 填 0(Pi 实际注册的是 128000)、reasoning 一律 false(主进程按名字判
// gpt-5 等是推理模型)。后果是选择器不显示上下文、推理档位开关被藏掉，等运行时追上后又变回来。

const profile = (id: string, models: string[]): LlmProviderProfile => ({
  id,
  display_name: id,
  base_url: 'https://upstream.example/v1',
  api_type: 'openai-completions',
  models,
  enabled: true,
  sort_order: 0,
  has_key: true,
})

describe('filled-in model defaults regression', () => {
  it('uses the same defaults Pi applies to an unregistered custom model', () => {
    const [model] = mergeAvailableModelInfo([], [profile('three-a-main', ['some-chat-model'])])

    expect(model).toMatchObject({
      id: 'some-chat-model',
      name: 'some-chat-model',
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
      input: ['text'],
    })
  })

  it('agrees with the main-process reasoning inference instead of hiding the thinking control', () => {
    const route = profile('three-a-main', ['gpt-5.6-sol'])
    const [model] = mergeAvailableModelInfo([], [route])

    expect(buildGatewayModel(route, 'gpt-5.6-sol').reasoning).toBe(true)
    expect(model.reasoning).toBe(true)
  })

  it('keeps the DeepSeek seed capabilities when the cloud catalog sent no metadata', () => {
    const route = profile('deepseek', ['deepseek-v4-pro'])
    const seed = buildGatewayModel(route, 'deepseek-v4-pro')
    const [model] = mergeAvailableModelInfo([], [route])

    expect(seed.contextWindow).toBeGreaterThan(0)
    expect(model).toMatchObject({
      name: 'DeepSeek V4 Pro',
      contextWindow: seed.contextWindow,
      maxTokens: seed.maxTokens,
      reasoning: true,
    })
  })

  it('mirrors the defaults of the installed pi-coding-agent', () => {
    const composer = readFileSync(
      join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'provider-composer.js'),
      'utf8',
    )

    expect(composer).toContain(`contextWindow: definition.contextWindow ?? ${PI_CUSTOM_MODEL_DEFAULTS.contextWindow}`)
    expect(composer).toContain(`maxTokens: definition.maxTokens ?? ${PI_CUSTOM_MODEL_DEFAULTS.maxTokens}`)
    expect(composer).toContain(`reasoning: definition.reasoning ?? ${PI_CUSTOM_MODEL_DEFAULTS.reasoning}`)
  })
})
