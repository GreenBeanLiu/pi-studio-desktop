import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./cloud-connection', () => ({ getCloudConnection: () => ({ available: false, relay: '', error: 'x' }) }))
vi.mock('./cloud-media', () => ({ cloudMediaFetch: vi.fn() }))

import { openAdminConsole, type AdminConsoleIo } from './admin-console'

function io(reply: Response, relay = 'https://pi-studio.example/') {
  const opened: string[] = []
  const asked: { path: string; method?: string }[] = []
  const fake: AdminConsoleIo = {
    fetch: (async (path: string, init?: RequestInit) => (asked.push({ path, method: init?.method }), reply)) as AdminConsoleIo['fetch'],
    open: async (url) => void opened.push(url),
    relay: () => ({ available: true, relay }),
  }
  return { fake, opened, asked }
}

describe('openAdminConsole', () => {
  it('asks for a one-time link with the app token and opens it in the browser', async () => {
    const t = io(new Response(JSON.stringify({ path: '/admin/login?code=abc', expires_in: 600 })))
    expect(await openAdminConsole(t.fake)).toEqual({ ok: true })
    expect(t.asked).toEqual([{ path: '/admin/login-link/desktop', method: 'POST' }])
    expect(t.opened).toEqual(['https://pi-studio.example/admin/login?code=abc'])
  })

  it('says what to fix instead of opening anything', async () => {
    const none = io(new Response('{}'))
    none.fake.relay = () => ({ available: false, relay: '', error: null })
    expect(await openAdminConsole(none.fake)).toEqual({ error: '先在上面填好云服务地址和应用令牌并保存' })
    expect(await openAdminConsole(io(new Response('', { status: 404 })).fake)).toEqual({ error: '云端还没更新到支持桌面登录的版本' })
    expect(await openAdminConsole(io(new Response('', { status: 401 })).fake)).toEqual({ error: '应用令牌不对，管理台不让进' })
    const odd = io(new Response(JSON.stringify({ path: 'https://evil.example/' })))
    expect(await openAdminConsole(odd.fake)).toEqual({ error: '云端没有返回登录链接' })
    expect(odd.opened).toEqual([])
  })
})
