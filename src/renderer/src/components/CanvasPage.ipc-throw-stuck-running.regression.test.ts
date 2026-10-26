import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./CanvasPage.tsx', import.meta.url), 'utf8')

// 2026-10-27 真机验证时网络切换,imageGen:generate 直接 reject(net::ERR_NETWORK_CHANGED)
// 而不是返回 { error }。run() 没接住,节点永远停在"生成中",计时器一直走。
describe('canvas run() survives a rejected IPC call', () => {
  it('wraps both generate calls in a try/catch that marks the node failed', () => {
    const run = page.slice(page.indexOf('const run = useCallback'), page.indexOf('const variant = useCallback'))
    const tryAt = run.indexOf('try {')
    const catchAt = run.indexOf('} catch (error) {')
    expect(tryAt).toBeGreaterThan(-1)
    expect(catchAt).toBeGreaterThan(tryAt)
    for (const call of ['api.imageGen.generate(', 'api.videoGen.generate(']) {
      const at = run.indexOf(call)
      expect(at).toBeGreaterThan(tryAt)
      expect(at).toBeLessThan(catchAt)
    }
    expect(run.slice(catchAt)).toContain("status: 'error'")
  })
})
