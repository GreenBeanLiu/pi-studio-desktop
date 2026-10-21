import { net } from 'electron'

/**
 * 主进程里打网络一律走这里,别用全局 `fetch`。
 *
 * 2026-09-06:Mac 上设置页「云端模型线路」一直报 `fetch failed`,而终端里 curl 打同一个
 * 地址是 200 —— 看起来像后端问题,其实不是。
 *
 * 这台机器上 `trail-api.glanger.xyz`(以及 2026-10-21 起的 `pi-studio.glanger.xyz`,同一台服务器) **只能经系统代理(127.0.0.1:7890)访问**,直连连
 * DNS 都解析不了(`getaddrinfo` 直接失败,curl --noproxy 15 秒超时返回 000)。终端里
 * 之所以通,是因为 shell 里有 `HTTPS_PROXY`;而 **Finder 启动的 app 一个 shell 环境变量
 * 都没有**(见 shell-env.ts 顶部的注释),Node 的全局 fetch(undici)只认环境变量、
 * 不读系统代理设置,于是它直连 → `UND_ERR_CONNECT_TIMEOUT` → 上抛成 `fetch failed`。
 *
 * 报错信息本身没有任何指向性:`fetch failed` 不带 URL、不带 cause,所以这个坑很容易
 * 被当成"后端挂了"或"key 不对"排查半天。
 *
 * `net.fetch` 走 Chromium 的网络栈,原生读 macOS 系统代理(以及 PAC 脚本和需要认证的
 * 代理),所以这层壳就是全部修复 —— 不用自己解析 `scutil --proxy`,也不用引入 undici
 * 去设 ProxyAgent。Windows 和 Linux 上同样是读系统代理,行为一致。
 *
 * 注意:`net.fetch` 要 app ready 之后才能用。主进程里所有网络调用都发生在窗口创建之后,
 * 满足这个前提;如果哪天要在 ready 之前打网络,得自己等 `app.whenReady()`。
 */
export function cloudFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  // 单测里没有 Electron 运行时,net 是 undefined —— 那时退回全局 fetch,
  // 好让测试照常 mock。真机上 net 永远在,所以这条分支不会影响线上行为。
  if (!net?.fetch) return fetch(String(input), init)
  return net.fetch(String(input), init)
}
