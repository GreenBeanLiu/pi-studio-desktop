import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routineSteps = readFileSync(new URL('./routine-steps.ts', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('./app-icon-bundle.ts', import.meta.url), 'utf8')
const routinesPage = readFileSync(
  new URL('../renderer/src/components/RoutinesPage.tsx', import.meta.url),
  'utf8',
)
const presets = readFileSync(
  new URL('../renderer/src/lib/routine-node-presets.ts', import.meta.url),
  'utf8',
)

// 2026-08-08: 图标工作流每次都写进同一个目录、同一个 .zip,后一次生成直接抹掉
// 前一次,想留住结果只能每跑一次就手动改一次文件夹名。
describe('app icon output naming', () => {
  it('gives every run its own default directory', () => {
    expect(routineSteps).toContain("if (token === 'trigger.stamp') return ctx.triggerStamp")
    expect(routineSteps).toContain('function pathStamp')
    // 默认模板四处(执行器兜底 + 渲染层新建/编辑/占位)必须都带上时间戳,
    // 漏一处就又会出现"两个节点写同一个目录"
    const template = '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}'
    expect(routineSteps).toContain(template)
    expect(presets).toContain(template)
    expect(routinesPage.split(template).length - 1).toBeGreaterThanOrEqual(5)
    expect(routinesPage).not.toContain(".pi-studio/app-icons/{{routine.name}}'")
    expect(routinesPage).not.toContain('.pi-studio/app-icons/app-icon-bundle')
  })

  it('never deletes an existing bundle to make room for a new one', () => {
    expect(bundle).toContain('function availableOutputRoot')
    expect(bundle).toContain('const outputRoot = availableOutputRoot(requestedRoot)')
    expect(bundle).not.toContain('if (existsSync(outputRoot)) rmSync(outputRoot')
  })

  it('keeps the stamp usable as a path segment on Windows too', () => {
    const start = routineSteps.indexOf('function pathStamp')
    // Windows 检出会把行尾变成 CRLF,写死 '\n}\n' 找不到函数结尾就会一路切到文件末。
    const end = routineSteps.slice(start).search(/\r?\n\}\r?\n/)
    const stamp = routineSteps.slice(start, start + end)
    // 本地化时间串带冒号和斜杠,进不了 Windows 路径;只允许数字和一个连字符
    expect(stamp).toContain('getFullYear()')
    expect(stamp).not.toContain('toLocaleString')
    expect(stamp).toContain("padStart(2, '0')")
  })
})
