import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 2026-09-06:Mac 上设置页「云端模型线路」一直报 `fetch failed`,而终端里 curl 打同一个
 * 地址是 200 —— 看着像后端挂了,其实是**这台机器只能经系统代理访问那个域名**,直连连
 * DNS 都解析不了。终端通是因为 shell 里有 HTTPS_PROXY;Finder 启动的 app 一个 shell
 * 环境变量都没有,而 Node 的全局 fetch(undici)只认环境变量、不读系统代理。
 *
 * 报错 `fetch failed` 不带 URL 也不带 cause,零指向性 —— 所以这条必须钉在源码上:
 * 主进程里打云端的模块不许用全局 fetch,一律走 cloud-fetch 的 net.fetch(Chromium
 * 网络栈,原生读系统代理)。
 */
// 主进程里所有会出网的模块。新增会打网络的模块时加进来 —— 漏了就会在有代理的机器上
// 悄悄挂掉,而且报错是零指向性的 `fetch failed`。
const CLOUD_MODULES = [
  'llm-gateway.ts',
  'cloud-media.ts',
  'vision-review.ts',
  'model3d.ts',
  'image-gen.ts',
  'acp-registry.ts',
  'channels.ts',
  'routine-steps.ts',
  'routine-cloud-sync.ts',
  'app-icon-bundle.ts',
  'remote-control.ts',
]

/**
 * 故意不在名单里,别顺手"修"它们:
 *
 * workspace-memory.ts / web-search-extension.ts 里的 fetch 在 **EXTENSION_SOURCE
 * 模板字符串内部** —— 那是写到磁盘、由 pi agent 的扩展宿主加载的独立源码,不在
 * Electron 主进程里跑,`import { net } from 'electron'` 在那个运行时会直接找不到模块。
 * 2026-09-06 我把它们一起改了,workspace-memory-extension.test 立刻红:
 * `Cannot find module './cloud-fetch'`。
 */
const EMBEDDED_EXTENSION_SOURCES = ['workspace-memory.ts', 'web-search-extension.ts']

describe('主进程打云端必须走 net.fetch,不能用全局 fetch', () => {
  it('cloud-fetch 这层壳确实用的是 electron net', () => {
    const shim = read('./cloud-fetch.ts')
    expect(shim).toContain("from 'electron'")
    expect(shim).toContain('net.fetch')
  })

  for (const name of CLOUD_MODULES) {
    it(`${name} 不再直接调全局 fetch`, () => {
      const source = read(`./${name}`)
      // 只看真正的调用点,注释里提到 fetch 不算
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      const bare = code.match(/(?<![.\w])fetch\s*\(/g) ?? []
      expect(bare, `${name} 里还有 ${bare.length} 处裸 fetch(`).toHaveLength(0)
      expect(code).toMatch(/from '\.\/cloud-fetch'/)
    })
  }

  it('内嵌扩展源码保持用全局 fetch —— 它们不在 Electron 里跑', () => {
    for (const name of EMBEDDED_EXTENSION_SOURCES) {
      const source = read(`./${name}`)
      expect(source, `${name} 不该引入 cloud-fetch`).not.toContain("from './cloud-fetch'")
      expect(source, `${name} 应当仍然内嵌一段 EXTENSION_SOURCE`).toMatch(
        /EXTENSION_SOURCE = `/,
      )
    }
  })

  it('自带同名 helper 的模块用别名导入,不会悄悄绑错', () => {
    // model3d / image-gen 各自有个叫 cloudFetch 的 helper,会给路径拼 cloud.relay 并塞
    // API key。直接 `import { cloudFetch }` 会撞名,让本该直连绝对 URL 的调用绑到那个
    // helper 上、拼出坏 URL。所以这两个文件必须用别名。
    for (const name of ['model3d.ts', 'image-gen.ts']) {
      const source = read(`./${name}`)
      expect(source, `${name} 应当用别名导入`).toContain(
        "import { cloudFetch as netFetch } from './cloud-fetch'",
      )
    }
  })

  it('model3d 里打绝对 URL 的地方没有被本地那个会拼中继地址的 helper 接管', () => {
    // model3d 自己有个叫 cloudFetch 的 helper,会给路径前面拼 cloud.relay 并塞 API key。
    // download()/urlToDataUrl() 拿到的是 R2 绝对链接,走那个 helper 会拼出一个坏 URL,
    // 所以它们必须用别名 netFetch。这条就是防止 import 名字撞车时悄悄绑错。
    const source = read('./model3d.ts')
    expect(source).toContain("import { cloudFetch as netFetch } from './cloud-fetch'")
    expect(source).toMatch(/netFetch\(url,/)
  })
})
