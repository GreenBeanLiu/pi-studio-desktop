import { app } from 'electron'
import { dirname, join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { agentConfigDir } from './settings'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 把随应用发布的 agent 资源(resources/pi-skills、resources/pi-extensions)同步进
 * app 私有 agent 配置目录。pi 从 <agentDir>/skills/ 发现 SKILL.md、从
 * <agentDir>/extensions/ 发现扩展文件,聊天与工作流的所有 agent 会话因此都能用。
 * 每次启动整个覆盖,保持与应用版本一致。
 *
 * 当前内置:
 * - skill  object-to-threejs-procedural(参考图→程序化 three.js 建模,
 *   改编自 vinhhien112/Three.js-Object-Sculptor-Codex-Plugin,MIT)
 * - skill  interface-review
 * - skill  gpt-image-2-style-library(gpt-image-2 出图选型与提示词,
 *   模板元数据改编自 freestylefly/awesome-gpt-image-2,MIT)
 * - 扩展   pi-studio-imagegen(云端生图工具,凭据走 spawn 环境变量)
 */
/**
 * 递归拷贝一棵目录树,只用 readdir/stat/copyFile 三个原语。
 *
 * 不能用 `cpSync(..., { recursive: true })` —— 打开 asar 之后源路径在归档里,
 * 而 **Electron 的 asar 补丁没实现 cpSync 的目录递归**:2026-09-06 实测,
 * 主进程(process.type=browser)和 ELECTRON_RUN_AS_NODE 两种模式下都返回 ENOENT,
 * 尽管 fs.cpSync 确实被那层补丁包装过。同一批实测里 readdirSync / statSync /
 * copyFileSync / readFileSync / ESM import 在 asar 上都正常,所以换成这三个原语
 * 手工走一遍即可,resources/ 不必从归档里解出来。
 */
function copyTree(src: string, dest: string): void {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dest, name))
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

function syncBundledDir(sourceName: string, destName: string, logTag: string): void {
  // 打包后 getAppPath() 指向 app.asar 内部,dev 下指向应用根;两种情况下
  // resources/ 都在它下面,读取由 Electron 的 asar 补丁透明处理
  const src = join(app.getAppPath(), 'resources', sourceName)
  if (!existsSync(src)) {
    appendAppLog('warn', logTag, `内置 ${destName} 目录缺失,跳过同步`, { src })
    return
  }
  const destRoot = join(agentConfigDir(), destName)
  // 只覆盖内置的同名条目,不动用户手动放进去的其他内容
  for (const name of readdirSync(src)) {
    try {
      const dest = join(destRoot, name)
      rmSync(dest, { recursive: true, force: true })
      copyTree(join(src, name), dest)
    } catch (err) {
      appendAppLog('error', logTag, `内置 ${destName} 同步失败: ${name}`, normalizeError(err))
    }
  }
}

export function syncBundledSkills(): void {
  syncBundledDir('pi-skills', 'skills', 'skills.sync')
}

/**
 * 内置扩展。注意 syncSubagentRoles 也往 <agentDir>/extensions/ 写(subagent/),
 * 两边按条目名各管各的,不会互相覆盖。
 */
export function syncBundledExtensions(): void {
  syncBundledDir('pi-extensions', 'extensions', 'extensions.sync')
}
