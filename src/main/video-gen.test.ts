import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./app-log', () => ({ appendAppLog: vi.fn(), normalizeError: (error: unknown) => ({ message: String(error) }) }))
vi.mock('./cloud-connection', () => ({ getCloudConnection: () => ({ available: true, relay: 'https://cloud.test', key: 'k' }) }))
vi.mock('./cloud-media', () => ({ cloudMediaFetch: vi.fn(), uploadCloudImageReference: vi.fn(), readCloudSseResult: vi.fn() }))

import { generateVideo, videoHealth, type VideoGenIo } from './video-gen'

function io(result: Record<string, unknown> = { videoUrl: 'https://pod.test/pi-studio/videos/1.mp4', provider: 'apimart', durationSec: 6, resolution: '480p' }) {
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = []
  const uploads: string[] = []
  const fake: VideoGenIo = {
    fetch: (async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response('')
    }) as VideoGenIo['fetch'],
    upload: (async (dataUrl: string) => (uploads.push(dataUrl), 'https://pod.test/pi-studio/ref-1.png')) as VideoGenIo['upload'],
    readSse: (async () => result) as VideoGenIo['readSse'],
  }
  return { fake, calls, uploads }
}

describe('generateVideo', () => {
  it('a local first frame is uploaded first, then sent as the image', async () => {
    const t = io()
    const out = await generateVideo({ prompt: ' 镜头推近 ', frameDataUrl: 'data:image/png;base64,AAA', duration: 8, resolution: '720p', aspectRatio: '16:9' }, t.fake)
    expect(t.uploads).toEqual(['data:image/png;base64,AAA'])
    expect(t.calls).toEqual([{ path: '/videogen', body: { prompt: '镜头推近', imageUrl: 'https://pod.test/pi-studio/ref-1.png', duration: 8, resolution: '720p', aspectRatio: '16:9' } }])
    expect(out).toEqual({ videoUrl: 'https://pod.test/pi-studio/videos/1.mp4', provider: 'apimart', durationSec: 6, resolution: '480p', firstFrameUrl: 'https://pod.test/pi-studio/ref-1.png' })
  })

  it('a frame from the image history is sent as is; no frame means text-to-video with the cheap defaults', async () => {
    const t = io()
    await generateVideo({ prompt: 'x', frameUrl: 'https://pod.test/pi-studio/a.png' }, t.fake)
    await generateVideo({ prompt: '海边日落' }, t.fake)
    expect(t.uploads).toEqual([])
    expect(t.calls[0].body?.imageUrl).toBe('https://pod.test/pi-studio/a.png')
    expect(t.calls[1].body).toEqual({ prompt: '海边日落', duration: 6, resolution: '480p', aspectRatio: '9:16' })
  })

  it('an empty prompt is refused without calling the cloud', async () => {
    const t = io()
    expect(await generateVideo({ prompt: '  ' }, t.fake)).toEqual({ error: '写一下画面怎么动、镜头怎么走' })
    expect(t.calls).toEqual([])
  })

  it('a result without a video, a cloud error and a timeout each come back as words', async () => {
    expect(await generateVideo({ prompt: 'x' }, io({}).fake)).toEqual({ error: '云端任务完成但没有返回视频链接' })
    const failing = io()
    failing.fake.readSse = (async () => { throw new Error('[apimart] video failed: content policy') }) as VideoGenIo['readSse']
    expect(await generateVideo({ prompt: 'x' }, failing.fake)).toEqual({ error: '[apimart] video failed: content policy' })
    const slow = io()
    slow.fake.fetch = (async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }) as VideoGenIo['fetch']
    expect(await generateVideo({ prompt: 'x' }, slow.fake)).toEqual({ error: '生成超过 20 分钟，已按失败处理' })
  })
})

describe('videoHealth', () => {
  it('says why video is unavailable: an old backend, or no key yet', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as VideoGenIo['fetch']
    expect(await videoHealth({ fetch: reply(404, {}) })).toEqual({ ok: false, reason: '云端 404(后端可能还没更新到有视频的版本)' })
    expect(await videoHealth({ fetch: reply(200, { ok: false }) })).toEqual({ ok: false, reason: '云端还没配视频供应商的 key(管理台里填 APIMart)' })
    expect(await videoHealth({ fetch: reply(200, { ok: true }) })).toEqual({ ok: true })
  })
})
