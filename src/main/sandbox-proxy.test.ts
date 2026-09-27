import { createConnection } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { startSandboxProxy, stopSandboxProxy } from './sandbox-proxy'

afterAll(async () => {
  await stopSandboxProxy()
})

/** 向代理发一条 CONNECT 并收集响应:白名单外会立刻回 403,放行则建隧道或断链。 */
function connectThroughProxy(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let data = ''
    const settle = (): void => {
      socket.destroy()
      resolve(data)
    }
    const timer = setTimeout(settle, 2000)
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        settle()
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      if (data) resolve(data)
      else reject(err)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

describe('startSandboxProxy allowlist', () => {
  it('rejects a host outside the allowlist with 403', async () => {
    const port = await startSandboxProxy('127.0.0.1', [])
    expect(await connectThroughProxy(port, 'not-allowed.example:443')).toContain('403')
  })

  it('lets a user-supplied extra host past the gate', async () => {
    const port = await startSandboxProxy('127.0.0.1', ['extra.example'])
    // 放行后代理会去连上游;上游不存在时隧道断开,但绝不会回 403
    expect(await connectThroughProxy(port, 'extra.example:443')).not.toContain('403')
  })

  it('refreshes the extra list on the next start', async () => {
    const port = await startSandboxProxy('127.0.0.1', [])
    expect(await connectThroughProxy(port, 'extra.example:443')).toContain('403')
  })
})
