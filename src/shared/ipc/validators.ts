/**
 * main 边界的运行时校验(见 优化.md「所有跨进程输入都在 main 边界校验」)。
 *
 * 原则:renderer 传进来的值一律当 `unknown`。TypeScript 只约束我们自己的代码,
 * 约束不了实际到达 main 的数据 —— 契约错误直接抛 TypeError,由 handler 记日志并拒绝。
 *
 * 沿用 main/ipc-contracts.ts 已有的手写 parser 风格,暂不引入 schema 库。
 */
import { resolve, sep } from 'path'
import { parseAllowedHostList } from '../sandbox-hosts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}不能为空`)
  return value.trim()
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`)
  return value
}

/** 字符串必须落在给定枚举里,否则是契约错误。 */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label}无效`)
  }
  return value as T
}

/**
 * 路径是否被 root 包含。Windows 上大小写不敏感,所以统一小写后比较
 * (与 ipc.ts 的 git:showFile 同一套判断)。
 */
export function isContainedPath(target: string, root: string): boolean {
  const rootKey = resolve(root).toLowerCase()
  const targetKey = resolve(target).toLowerCase()
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}${sep}`)
}

/**
 * 解析一个必须位于 root 之内的路径,返回绝对路径。
 *
 * 关键点:是 main 决定路径安不安全,不是 renderer。renderer 只给一个字符串,
 * 越界(`..`、绝对路径、符号链接式的拼接)一律拒绝。
 */
export function parseContainedPath(value: unknown, root: string, label: string): string {
  const raw = requiredString(value, label)
  const target = resolve(root, raw)
  if (!isContainedPath(target, root)) throw new TypeError(`${label}超出允许范围`)
  return target
}

/** 会话文件:必须在会话目录内,且是 .jsonl —— 否则就是在拿删除接口删别的文件。 */
export function parseSessionPath(value: unknown, sessionDir: string, label = '会话路径'): string {
  const target = parseContainedPath(value, sessionDir, label)
  if (!target.toLowerCase().endsWith('.jsonl')) throw new TypeError(`${label}必须是会话文件`)
  return target
}

/** Normalize a workspace path before main checks that it exists and is a directory. */
export function parseWorkspacePath(value: unknown): string {
  const path = requiredString(value, '工作区路径')
  if (path.includes('\u0000')) throw new TypeError('工作区路径无效')
  return resolve(path)
}

export function parseModelSelection(value: unknown, label: string): string {
  const model = requiredString(value, label)
  if (model.length > 256) throw new TypeError(`${label}过长`)
  return model
}

export function parsePrompt(value: unknown): string {
  const prompt = requiredString(value, '消息')
  if (prompt.length > 1_000_000) throw new TypeError('消息过长')
  return prompt
}

export function parseArtifactId(value: unknown): string {
  const id = requiredString(value, 'artifact ID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new TypeError('artifact ID 无效')
  }
  return id
}

export function parseNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label}必须是非负安全整数`)
  }
  return value as number
}

// ── Routine 写入对象 ─────────────────────────────────────────────────
// routines:save 原来直接 Object.assign(existing, routine),renderer 传什么并什么。
// 这里只放行已知字段,并把 schedule 逐种校验 —— 一个 {type:'interval',minutes:0}
// 会让调度器空转,一个未知字段会被原样持久化并同步上云。

export type ParsedRoutineSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function boundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label}无效`)
  }
  return value
}

export function parseRoutineSchedule(value: unknown): ParsedRoutineSchedule {
  if (!isRecord(value)) throw new TypeError('调度配置无效')
  switch (value.type) {
    case 'manual':
      return { type: 'manual' }
    case 'interval':
      return { type: 'interval', minutes: boundedInt(value.minutes, 1, 7 * 24 * 60, '间隔分钟') }
    case 'hourly':
      return { type: 'hourly', minute: boundedInt(value.minute, 0, 59, '触发分钟') }
    case 'daily': {
      const time = requiredString(value.time, '触发时间')
      if (!TIME_RE.test(time)) throw new TypeError('触发时间必须是 HH:mm')
      return { type: 'daily', time }
    }
    case 'weekly': {
      const time = requiredString(value.time, '触发时间')
      if (!TIME_RE.test(time)) throw new TypeError('触发时间必须是 HH:mm')
      return { type: 'weekly', day: boundedInt(value.day, 0, 6, '星期'), time }
    }
    default:
      throw new TypeError('调度类型无效')
  }
}

export type ParsedRoutineSave = {
  id?: string
  name: string
  input?: string
  steps: unknown[]
  workspacePath: string
  schedule: ParsedRoutineSchedule
  notify: 'always' | 'error' | 'never'
  notifyChannelId?: string
  pushEachStep?: boolean
  workspaceMode?: 'read-write' | 'read-only' | 'isolated'
}

/** 只放行已知字段;steps 的逐项归一化仍由 routines.ts 的 normalizeStep 负责。 */
export function parseRoutineSave(value: unknown): ParsedRoutineSave {
  if (!isRecord(value)) throw new TypeError('工作流参数无效')
  if (!Array.isArray(value.steps)) throw new TypeError('步骤列表无效')
  const out: ParsedRoutineSave = {
    name: requiredString(value.name, '工作流名称'),
    steps: value.steps,
    workspacePath: requiredString(value.workspacePath, '工作区路径'),
    schedule: parseRoutineSchedule(value.schedule),
    notify: oneOf(value.notify, ['always', 'error', 'never'] as const, '通知策略'),
  }
  const id = optionalString(value.id, '工作流 ID')
  if (id) out.id = id
  const input = optionalString(value.input, '输入')
  if (input !== undefined) out.input = input
  const channel = optionalString(value.notifyChannelId, '通知渠道')
  if (channel !== undefined) out.notifyChannelId = channel
  if (value.pushEachStep !== undefined) {
    if (typeof value.pushEachStep !== 'boolean') throw new TypeError('逐步推送开关无效')
    out.pushEachStep = value.pushEachStep
  }
  if (value.workspaceMode !== undefined) {
    out.workspaceMode = oneOf(
      value.workspaceMode,
      ['read-write', 'read-only', 'isolated'] as const,
      '工作区写权限',
    )
  }
  return out
}

// ── Settings 写入对象 ────────────────────────────────────────────────
// settings:save 原来直接 `...settings` 落盘:多余字段跟着持久化,
// cloudImageKey 不是字符串时 `.trim()` 直接抛 TypeError 崩掉 handler。

const IMAGE_ENGINES = ['', 'openai', 'gemini', 'grok'] as const

function stringField(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`)
  return value
}

function boolField(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label}无效`)
  return value
}

export type ParsedSettingsSave = {
  favoriteModels: string
  tavilyApiKey: string
  sandboxEnabled: boolean
  sandboxAllowedHosts: string[]
  subagentsEnabled: boolean
  remoteEnabled: boolean
  feishuWebhookUrl: string
  feishuSecret: string
  feishuAppId: string
  feishuAppSecret: string
  feishuChatId: string
  imageEngine: (typeof IMAGE_ENGINES)[number]
  cloudImageRelay: string
  cloudImageKey: string
  clearCloudImageKey?: boolean
}

export function parseSettingsSave(value: unknown): ParsedSettingsSave {
  if (!isRecord(value)) throw new TypeError('设置参数无效')
  const out: ParsedSettingsSave = {
    favoriteModels: stringField(value.favoriteModels, '常用模型'),
    tavilyApiKey: stringField(value.tavilyApiKey, 'Tavily Key'),
    sandboxEnabled: boolField(value.sandboxEnabled, false, '沙箱开关'),
    sandboxAllowedHosts: parseAllowedHostList(value.sandboxAllowedHosts),
    subagentsEnabled: boolField(value.subagentsEnabled, false, '子代理开关'),
    remoteEnabled: boolField(value.remoteEnabled, false, '远程控制开关'),
    feishuWebhookUrl: stringField(value.feishuWebhookUrl, '飞书 Webhook'),
    feishuSecret: stringField(value.feishuSecret, '飞书签名'),
    feishuAppId: stringField(value.feishuAppId, '飞书 AppId'),
    feishuAppSecret: stringField(value.feishuAppSecret, '飞书 AppSecret'),
    feishuChatId: stringField(value.feishuChatId, '飞书 ChatId'),
    imageEngine: oneOf(stringField(value.imageEngine, '生图引擎') as string, IMAGE_ENGINES, '生图引擎'),
    cloudImageRelay: stringField(value.cloudImageRelay, '云端中继'),
    cloudImageKey: stringField(value.cloudImageKey, '云端 Key'),
  }
  if (value.clearCloudImageKey !== undefined) {
    out.clearCloudImageKey = boolField(value.clearCloudImageKey, false, '清除云端 Key')
  }
  return out
}
