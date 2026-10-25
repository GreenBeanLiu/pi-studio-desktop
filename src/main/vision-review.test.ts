import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ provider: 'pi-studio', model: 'gpt-6-sol' }))
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('./agent-runtime-config', () => ({
  prepareAgentRuntime: async () => ({ ...runtime, env: { PI_STUDIO_LLM_KEY: 'session-token' } }),
}))
vi.mock('./cloud-connection', () => ({
  getCloudConnection: () => ({ available: true, relay: 'https://relay.example/' }),
}))
vi.mock('./cloud-fetch', () => ({ cloudFetch: fetchMock }))

import { gatewayChatEndpoint, reviewModelRender } from './vision-review'

function reply(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":80,"notes":"好"}' } }] }), {
    status: 200,
  })
}

describe('vision review gateway entry', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => reply())
  })

  it('uses the model-key entry with the model key when a pi-studio model is selected', async () => {
    runtime.provider = 'pi-studio'
    runtime.model = 'gpt-6-sol'
    const review = await reviewModelRender({ mode: 'text', prompt: '一把椅子', renderDataUrl: 'data:image/png;base64,AA' })
    expect(review).toEqual({ score: 80, notes: '好', model: 'gpt-6-sol' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.example/llm/v1/chat/completions')
    expect(JSON.parse(String(init.body)).model).toBe('gpt-6-sol')
  })

  it('keeps the per-route entry for a session still on a legacy route provider', async () => {
    runtime.provider = 'heilovehei'
    runtime.model = 'gpt-5.6-sol'
    await reviewModelRender({ mode: 'text', prompt: 'x', renderDataUrl: 'data:image/png;base64,AA' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://relay.example/llm/v1/heilovehei/chat/completions')
  })

  it('encodes route ids and trims the relay', () => {
    expect(gatewayChatEndpoint(' https://r.example// ', 'a b')).toBe('https://r.example/llm/v1/a%20b/chat/completions')
  })
})
