import { describe, expect, it, vi } from 'vitest'
import { selectSandboxBackend, type SandboxBackend, type SandboxLaunch } from './sandbox-backend'

function launch(mode: SandboxLaunch['mode']): SandboxLaunch {
  return { cliPath: `/shim/${mode}.cjs`, env: { MODE: mode }, mode }
}

/** 一个只记录「有没有被调用」的假后端,用来钉住选择顺序与跳过行为。 */
function fakeBackend(
  id: SandboxBackend['id'],
  available: boolean | (() => Promise<boolean>),
): { backend: SandboxBackend; prepare: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn(async () => launch(id))
  const backend: SandboxBackend = {
    id,
    available: typeof available === 'function' ? available : () => available,
    prepare,
  }
  return { backend, prepare }
}

describe('selectSandboxBackend', () => {
  it('picks the first available backend in priority order', async () => {
    const first = fakeBackend('seatbelt', true)
    const second = fakeBackend('wsl', true)
    const result = await selectSandboxBackend([first.backend, second.backend], '/ws', {}, 'nope')

    expect(result.mode).toBe('seatbelt')
    expect(first.prepare).toHaveBeenCalledTimes(1)
    // 已经选到就不该再探测后面的后端
    expect(second.prepare).not.toHaveBeenCalled()
  })

  it('skips unavailable backends without preparing them', async () => {
    const mac = fakeBackend('seatbelt', false)
    const wsl = fakeBackend('wsl', true)
    const docker = fakeBackend('docker', true)
    const result = await selectSandboxBackend([mac.backend, wsl.backend, docker.backend], '/ws', {}, 'nope')

    expect(result.mode).toBe('wsl')
    expect(mac.prepare).not.toHaveBeenCalled()
    expect(docker.prepare).not.toHaveBeenCalled()
  })

  it('awaits an async available() before deciding', async () => {
    const wsl = fakeBackend('wsl', async () => true)
    const result = await selectSandboxBackend([wsl.backend], '/ws', {}, 'nope')

    expect(result.mode).toBe('wsl')
  })

  it('passes cwd and env straight through to prepare', async () => {
    const wsl = fakeBackend('wsl', true)
    const env = { OPENAI_API_KEY: 'secret', HTTPS_PROXY: 'http://127.0.0.1:1' }
    await selectSandboxBackend([wsl.backend], 'D:\\Works\\proj', env, 'nope')

    expect(wsl.prepare).toHaveBeenCalledWith('D:\\Works\\proj', env)
  })

  it('throws the fallback message when nothing is available', async () => {
    const none = [fakeBackend('seatbelt', false).backend, fakeBackend('wsl', false).backend]
    await expect(selectSandboxBackend(none, '/ws', {}, '需要先准备沙箱环境')).rejects.toThrow(
      '需要先准备沙箱环境',
    )
  })
})
