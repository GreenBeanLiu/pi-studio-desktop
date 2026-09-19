import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { connect } from 'net'
import { runtimeHost } from './runtime-host'
import {
  modelsDir,
  loadHistory,
  saveHistory,
  localFileUrl,
  broadcast,
  type Model3DHistoryItem,
  type Model3DResult,
} from './model3d'
import { appendAppLog, normalizeError } from './app-log'
import { PiRunTimeoutError, runPromptToSettled } from './pi-runtime'
import {
  inspectBlenderInstall,
  installAddonAndLaunchBlender,
  type BlenderInstallStatus,
} from './blender-setup'

/**
 * 第四种 3D 引擎「Blender 建模」:agent 写 bpy 建模脚本,宿主经 blender-mcp addon
 * 的 socket(localhost:9876,JSON 协议)送进用户已打开的 Blender 执行;报错原文
 * 回喂 agent 修(最多 REPAIR_ROUNDS 轮),成功后导出 glb 复用现有 viewer/历史管线。
 * 构建发生在临时场景 pi_studio_build 里,不碰用户 Blender 中已打开的工作;导出后清场。
 * 相比代码建模(three.js 手搓)的优势:修改器/布尔/倒角/细分等真建模工具。
 */

const BLENDER_PORT = 9876
const AGENT_TIMEOUT_MS = 10 * 60_000
const EXEC_TIMEOUT_MS = 120_000
const REPAIR_ROUNDS = 3

export type BlenderSetupStatus = BlenderInstallStatus & {
  connected: boolean
  ok?: boolean
  error?: string
}

let blenderSetupInFlight: Promise<BlenderSetupStatus> | null = null

/** blender-mcp addon socket:发 {type,params},收整段 JSON。 */
function blenderCommand(
  type: string,
  params: Record<string, unknown> = {},
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ status: string; result?: unknown; message?: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port: BLENDER_PORT })
    let buf = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('Blender 执行超时'))
    }, timeoutMs)
    sock.on('connect', () => sock.write(JSON.stringify({ type, params })))
    sock.on('data', (d) => {
      buf += d.toString()
      try {
        const resp = JSON.parse(buf) as { status: string; result?: unknown; message?: string }
        clearTimeout(timer)
        sock.end()
        resolve(resp)
      } catch {
        /* JSON 未收全 */
      }
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Blender 连接失败: ${e.message}`))
    })
  })
}

export async function blenderAvailable(): Promise<boolean> {
  try {
    const r = await blenderCommand('get_scene_info', {}, 4000)
    return r.status === 'success'
  } catch {
    return false
  }
}

async function blenderStatus(): Promise<BlenderSetupStatus> {
  const connected = await blenderAvailable()
  try {
    return { connected, ...(await inspectBlenderInstall()) }
  } catch (error) {
    appendAppLog('warn', 'blenderSetup.status', '检查 Blender 安装状态失败', normalizeError(error))
    return {
      connected,
      blenderFound: false,
      addonInstalled: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runBlenderSetup(): Promise<BlenderSetupStatus> {
  if (await blenderAvailable()) return { ...(await blenderStatus()), ok: true }
  try {
    const installed = await installAddonAndLaunchBlender()
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await blenderAvailable()) return { connected: true, ok: true, ...installed }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return {
      connected: false,
      ok: false,
      ...installed,
      error: 'Blender 已启动，但 blender-mcp 在 30 秒内没有连上，请查看 Blender 的控制台输出',
    }
  } catch (error) {
    appendAppLog('error', 'blenderSetup.install', '安装或启动 Blender MCP 失败', normalizeError(error))
    const status = await blenderStatus()
    return {
      ...status,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function setupBlender(): Promise<BlenderSetupStatus> {
  if (!blenderSetupInFlight) {
    blenderSetupInFlight = runBlenderSetup().finally(() => {
      blenderSetupInFlight = null
    })
  }
  return blenderSetupInFlight
}

/** 把 agent 的建模代码包进独立临时场景执行:不污染用户场景,失败也能收拾干净。 */
function wrapInBuildScene(userCode: string): string {
  return `import bpy
_prev = bpy.context.window.scene
_old = bpy.data.scenes.get('pi_studio_build')
if _old: bpy.data.scenes.remove(_old)
_scene = bpy.data.scenes.new('pi_studio_build')
bpy.context.window.scene = _scene
try:
${userCode
  .split('\n')
  .map((l) => `    ${l}`)
  .join('\n')}
finally:
    bpy.context.window.scene = _prev
`
}

/** 在临时场景里导出全部 mesh 为 glb,然后删掉临时场景。 */
function exportScript(outPath: string): string {
  return `import bpy
_prev = bpy.context.window.scene
_scene = bpy.data.scenes.get('pi_studio_build')
assert _scene is not None, 'build scene missing'
bpy.context.window.scene = _scene
for o in _scene.objects:
    o.select_set(o.type == 'MESH')
bpy.ops.export_scene.gltf(filepath=r'${outPath.replace(/\\/g, '/')}', export_format='GLB', use_selection=True, export_extras=True)
bpy.context.window.scene = _prev
bpy.data.scenes.remove(_scene)
print('EXPORT_OK')
`
}

const SKELETON = `# Blender 建模脚本 —— 由 pi-studio 送进 Blender 的独立临时场景执行。
# 约定:
# - 只写"建模"代码:创建物体/材质/修改器;不要自己导出、不要删别的场景、不要 bpy.ops.wm.*。
# - 脚本开头已在空场景里,直接建即可;物体放在世界原点附近,单位为米。
# - Blender 5.1 注意:材质节点要按类型找,不能按名字:
#     bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
# - 中文界面下新建物体名是「柱体/球体/立方体」,不要按英文默认名查找,建完立即重命名并存变量。
# - 每个可独立运动的部件命名清楚,并写自定义属性标注语义(会随 glb extras 导出,
#   预览器用它做部件动画):obj['axis'] = [1.0, 0.0, 0.0](转轴,局部坐标)、
#   obj['pivot'] = 'back_hinge_line' 等;部件的原点(origin)要放在转轴上。
# - 避免共面重叠(z-fighting 会闪烁):相邻部件的面不要完全贴合,嵌入或留 ≥0.005 间隙。
import bpy, math

# TODO: 在这里建模
bpy.ops.mesh.primitive_cube_add(size=1)
`

function workDir(id: string): string {
  const d = join(app.getPath('userData'), 'blender-models', id)
  mkdirSync(d, { recursive: true })
  return d
}

function refinePrompt(instruction: string): string {
  return `工作目录里的 model.py 是一个已经完成的 Blender bpy 建模脚本。请按以下修改要求调整它:

"${instruction}"

要求:
- 遵守文件头部注释里的全部约定(不导出、不动其他场景、节点按类型找)。
- 保持既有结构与命名,只做必要的增量修改;不要推翻重写。
- 你不需要也无法自己运行它——保存后宿主会送进 Blender 执行;报错原文会发回给你继续修。`
}

function agentPrompt(prompt: string): string {
  return `你在一个工作目录里,里面有 model.py(Blender bpy 建模脚本)。请编辑它,用 Blender 的建模能力(修改器/布尔/倒角/细分等都可以用)程序化构建下面描述的 3D 模型:

"${prompt}"

要求:
- 只编辑 model.py;遵守文件头部注释里的全部约定(不导出、不动其他场景、节点按类型找)。
- 参考 object-to-threejs-procedural skill 的分阶段方法:先轮廓比例,再部件,再细节。
- 你不需要也无法自己运行它——保存后宿主会送进 Blender 执行;如果报错,错误原文会发回给你继续修。
- 材质用 Principled BSDF 的纯色/金属度/粗糙度表达,不要依赖图片纹理。
- 避免共面重叠(z-fighting 会闪烁):相邻部件的面不要完全贴合,嵌入或留 ≥0.005 间隙。`
}

async function generateBlenderModel(payload: {
  prompt: string
  /** 迭代修改:以该历史模型的脚本为起点(拷贝到新工作目录,原模型保留) */
  sourceId?: string
}): Promise<Model3DResult> {
  const prompt = (payload.prompt ?? '').trim()
  if (!prompt) return { error: '请输入模型描述' }
  if (!(await blenderAvailable())) {
    const setup = await setupBlender()
    if (!setup.connected) return { error: setup.error ?? '无法自动启动 Blender' }
  }

  let sourceScript: string | null = null
  let displayPrompt = prompt
  if (payload.sourceId) {
    const src = join(app.getPath('userData'), 'blender-models', payload.sourceId, 'model.py')
    if (!existsSync(src)) return { error: '该模型没有可修改的源码(可能不是本机生成的)' }
    sourceScript = src
    const source = loadHistory().find((it) => it.id === payload.sourceId)
    if (source) displayPrompt = `${source.prompt} → ${prompt}`
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = workDir(id)
  const scriptPath = join(dir, 'model.py')
  const glbOut = join(modelsDir(), `${id}.glb`)
  const pr = (status: string): void =>
    broadcast('model3d:progress', { id, status, progress: 0, prompt: displayPrompt, mode: 'blender' })

  try {
    if (sourceScript) copyFileSync(sourceScript, scriptPath)
    else writeFileSync(scriptPath, SKELETON, 'utf-8')
    pr('building')

    const { client } = await runtimeHost.start('blender-model', dir, {
      audit: { modelId: id },
    })

    const runAgentTurn = async (text: string): Promise<void> => {
      try {
        await runPromptToSettled(client, text, AGENT_TIMEOUT_MS)
      } catch (err) {
        if (err instanceof PiRunTimeoutError) {
          throw new Error(`Blender 建模超时(${AGENT_TIMEOUT_MS / 60000} 分钟)`, { cause: err })
        }
        throw err
      }
    }

    try {
      await runAgentTurn(sourceScript ? refinePrompt(prompt) : agentPrompt(prompt))

      // 宿主执行↔回喂修复循环
      let lastError = ''
      let ok = false
      for (let round = 0; round <= REPAIR_ROUNDS; round++) {
        pr(round === 0 ? 'running' : 'repairing')
        const code = readFileSync(scriptPath, 'utf-8')
        const r = await blenderCommand('execute_code', { code: wrapInBuildScene(code) })
        if (r.status === 'success') {
          ok = true
          break
        }
        lastError = r.message ?? '未知错误'
        if (round === REPAIR_ROUNDS) break
        await runAgentTurn(
          `脚本在 Blender 里执行失败,请修复 model.py 后结束回合。错误原文:\n\n${lastError.slice(0, 1500)}`,
        )
      }
      if (!ok) throw new Error(`Blender 执行失败(已重试 ${REPAIR_ROUNDS} 轮): ${lastError.slice(0, 300)}`)
    } finally {
      await client.dispose().catch(() => {})
    }

    pr('exporting')
    const exp = await blenderCommand('execute_code', { code: exportScript(glbOut) })
    if (exp.status !== 'success') throw new Error(`导出失败: ${(exp.message ?? '').slice(0, 300)}`)
    if (!existsSync(glbOut)) throw new Error('导出完成但未找到模型文件')

    const item: Model3DHistoryItem = {
      id,
      prompt: displayPrompt,
      mode: 'blender',
      modelUrl: localFileUrl(glbOut),
      thumbnailUrl: null,
      createdAt: Date.now(),
    }
    saveHistory([item, ...loadHistory()])
    broadcast('model3d:progress', { id, status: 'done', progress: 100, prompt: displayPrompt, mode: 'blender' })
    return item
  } catch (err) {
    appendAppLog('error', 'blenderModel.generate', 'Blender 建模失败', normalizeError(err))
    broadcast('model3d:progress', { id, status: 'error', progress: 0, prompt: displayPrompt, mode: 'blender' })
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerBlenderModel(): void {
  ipcMain.handle('model3d:blenderStatus', () => blenderStatus())
  ipcMain.handle('model3d:setupBlender', () => setupBlender())
  ipcMain.handle('model3d:generateBlender', (_e, payload: { prompt: string; sourceId?: string }) =>
    generateBlenderModel(payload),
  )
}
