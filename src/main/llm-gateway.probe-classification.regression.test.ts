import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./cloud-fetch', () => ({ cloudFetch: vi.fn() }))

import { cloudFetch } from './cloud-fetch'
import { isModelMissingError, probeLlmModel } from './llm-gateway'

// 回归:探测只要非 2xx 就判模型坏了。只有"上游明确说模型不存在"才能是 missing。

function respond(status: number, body: unknown): void {
  vi.mocked(cloudFetch).mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
}

const probe = () => probeLlmModel('https://relay.example', 'session', 'three-a-main', 'gpt-x')

afterEach(() => vi.mocked(cloudFetch).mockReset())

describe('model probe classification regression', () => {
  it('reports ok only for a real chat completion', async () => {
    respond(200, { choices: [{ message: { content: 'O' } }] })
    await expect(probe()).resolves.toBe('ok')
  })

  it('pins the probe to the route under test so a backup route cannot answer for it', async () => {
    respond(200, { choices: [{ message: { content: 'O' } }] })
    await probe()
    const init = vi.mocked(cloudFetch).mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Pi-No-Failover']).toBe('1')
  })

  it.each([
    ['404 model_not_found code', 404, { error: { code: 'model_not_found', message: 'nope' } }],
    ['400 "model does not exist"', 400, { error: { message: 'The model `gpt-x` does not exist' } }],
    ['gateway detail wording', 404, { detail: 'Unknown model: gpt-x' }],
    ['200 with an error body', 200, { error: { message: 'model gpt-x not found' } }],
  ])('reports missing for %s', async (_label, status, body) => {
    respond(status, body)
    await expect(probe()).resolves.toBe('missing')
  })

  it.each([
    ['expired upstream key, even if it mentions the model', 401, { error: { message: 'model not found or invalid key' } }],
    ['forbidden', 403, { error: { message: 'no access' } }],
    ['rate limited', 429, { error: { message: 'Too many requests' } }],
    ['upstream outage', 502, '<html>Bad Gateway</html>'],
    ['max_tokens rejected by a reasoning model', 400, {
      error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." },
    }],
    ['bare 404 without a model-level reason', 404, '<html>Not Found</html>'],
    ['200 with no choices', 200, { choices: [] }],
  ])('reports inconclusive for %s', async (_label, status, body) => {
    respond(status, body)
    await expect(probe()).resolves.toBe('inconclusive')
  })

  it('treats a per-model timeout as inconclusive instead of aborting the whole run', async () => {
    vi.mocked(cloudFetch).mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    )
    await expect(probe()).resolves.toBe('inconclusive')
  })

  it('still throws when the gateway itself cannot be reached', async () => {
    vi.mocked(cloudFetch).mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(probe()).rejects.toThrow('fetch failed')
  })

  it('does not read parameter or availability errors as a missing model', () => {
    expect(isModelMissingError('This model does not support max_tokens')).toBe(false)
    expect(isModelMissingError('model is temporarily not available')).toBe(false)
    expect(isModelMissingError('模型暂时不可用')).toBe(false)
    expect(isModelMissingError('模型不存在')).toBe(true)
  })
})
