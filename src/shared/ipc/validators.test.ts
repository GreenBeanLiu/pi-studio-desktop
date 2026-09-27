import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'path'
import {
  isContainedPath,
  oneOf,
  parseArtifactId,
  parseContainedPath,
  parseModelSelection,
  parseNonNegativeSafeInteger,
  parsePrompt,
  parseRoutineSave,
  parseRoutineSchedule,
  parseSettingsSave,
  parseSessionPath,
  parseWorkspacePath,
  requiredString,
} from './validators'

const ROOT = resolve('/tmp/agent/sessions/ws-abc')
const contractSource = readFileSync(new URL('./contract.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')

describe('backup restore IPC contract', () => {
  it('keeps restore methods optional and bridged for mixed-version startup', () => {
    expect(contractSource).toContain('listBackups?:')
    expect(contractSource).toContain('restoreBackup?:')
    expect(preloadSource).toContain("diagnostics: ['getLogs', 'save', 'listBackups', 'restoreBackup']")
  })
})

describe('path containment', () => {
  it('accepts a file directly inside the root', () => {
    expect(isContainedPath(resolve(ROOT, 'a.jsonl'), ROOT)).toBe(true)
  })

  it('rejects a sibling directory sharing a name prefix', () => {
    // ws-abc-evil must not pass just because it starts with ws-abc
    expect(isContainedPath(`${ROOT}-evil${sep}a.jsonl`, ROOT)).toBe(false)
  })

  it('rejects traversal out of the root', () => {
    expect(isContainedPath(resolve(ROOT, '..', 'other', 'a.jsonl'), ROOT)).toBe(false)
  })
})

describe('parseContainedPath', () => {
  it('resolves a relative path against the root', () => {
    expect(parseContainedPath('a.jsonl', ROOT, '会话路径')).toBe(resolve(ROOT, 'a.jsonl'))
  })

  it('rejects traversal', () => {
    expect(() => parseContainedPath('../../etc/passwd', ROOT, '会话路径')).toThrow('超出允许范围')
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => parseContainedPath(resolve('/etc/passwd'), ROOT, '会话路径')).toThrow(
      '超出允许范围',
    )
  })

  it('rejects a non-string', () => {
    expect(() => parseContainedPath(42, ROOT, '会话路径')).toThrow('不能为空')
  })
})

describe('parseSessionPath', () => {
  it('accepts a .jsonl inside the session directory', () => {
    expect(parseSessionPath('s.jsonl', ROOT)).toBe(resolve(ROOT, 's.jsonl'))
  })

  // sessions:delete hands this straight to unlinkSync
  it('refuses a non-session file even inside the directory', () => {
    expect(() => parseSessionPath('notes.txt', ROOT)).toThrow('必须是会话文件')
  })

  it('refuses a .jsonl outside the directory', () => {
    expect(() => parseSessionPath('../elsewhere/s.jsonl', ROOT)).toThrow('超出允许范围')
  })
})

describe('IPC scalar parsers', () => {
  it('normalizes a workspace path input', () => {
    expect(parseWorkspacePath(`${ROOT}/..`)).toBe(resolve(ROOT, '..'))
  })

  it('rejects null bytes in workspace paths', () => {
    expect(() => parseWorkspacePath(`${ROOT}\u0000bad`)).toThrow('工作区路径无效')
  })

  it('bounds model and prompt input', () => {
    expect(parseModelSelection(' deepseek-v4-pro ', '模型 ID')).toBe('deepseek-v4-pro')
    expect(parsePrompt('  inspect the repo  ')).toBe('inspect the repo')
    expect(() => parseModelSelection('x'.repeat(257), '模型 ID')).toThrow('模型 ID过长')
    expect(() => parsePrompt('x'.repeat(1_000_001))).toThrow('消息过长')
  })

  it('accepts only UUID artifact ids and non-negative offsets', () => {
    expect(parseArtifactId('123e4567-e89b-12d3-a456-426614174000')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    )
    expect(parseNonNegativeSafeInteger(0, 'offsetChars')).toBe(0)
    expect(() => parseArtifactId('../artifact')).toThrow('artifact ID 无效')
    expect(() => parseNonNegativeSafeInteger(-1, 'offsetChars')).toThrow('非负安全整数')
  })
})

describe('oneOf', () => {
  it('returns the value when allowed', () => {
    expect(oneOf('high', ['off', 'high'] as const, '推理等级')).toBe('high')
  })

  it('rejects a value outside the enum', () => {
    expect(() => oneOf('nope', ['off', 'high'] as const, '推理等级')).toThrow('推理等级无效')
  })

  it('rejects a non-string', () => {
    expect(() => oneOf(1, ['off'] as const, '推理等级')).toThrow('推理等级无效')
  })
})

describe('requiredString', () => {
  it('trims', () => {
    expect(requiredString('  a  ', '会话名称')).toBe('a')
  })

  it('rejects whitespace-only input', () => {
    expect(() => requiredString('   ', '会话名称')).toThrow('会话名称不能为空')
  })
})

describe('parseRoutineSchedule', () => {
  it('accepts each schedule kind', () => {
    expect(parseRoutineSchedule({ type: 'manual' })).toEqual({ type: 'manual' })
    expect(parseRoutineSchedule({ type: 'interval', minutes: 30 })).toEqual({
      type: 'interval',
      minutes: 30,
    })
    expect(parseRoutineSchedule({ type: 'weekly', day: 0, time: '09:00' })).toEqual({
      type: 'weekly',
      day: 0,
      time: '09:00',
    })
  })

  it('rejects a zero-minute interval that would spin the scheduler', () => {
    expect(() => parseRoutineSchedule({ type: 'interval', minutes: 0 })).toThrow('间隔分钟')
  })

  it('rejects a malformed time', () => {
    expect(() => parseRoutineSchedule({ type: 'daily', time: '25:99' })).toThrow('HH:mm')
  })

  it('rejects an unknown type', () => {
    expect(() => parseRoutineSchedule({ type: 'cron', expr: '* * * * *' })).toThrow('调度类型')
  })
})

describe('parseRoutineSave', () => {
  const base = {
    name: '晨报',
    steps: [{ name: '抓取', type: 'agent', prompt: 'x' }],
    workspacePath: 'D:/Works/blog',
    schedule: { type: 'daily', time: '09:00' },
    notify: 'error',
  }

  it('keeps known fields and passes steps through untouched', () => {
    const parsed = parseRoutineSave({ ...base, id: 'r1', pushEachStep: true })
    expect(parsed.id).toBe('r1')
    expect(parsed.pushEachStep).toBe(true)
    expect(parsed.steps).toBe(base.steps)
  })

  // Object.assign(existing, routine) used to persist and cloud-sync any extra key
  it('drops unknown fields', () => {
    const parsed = parseRoutineSave({ ...base, __proto__pollution: 'x', extra: 1 })
    expect('extra' in parsed).toBe(false)
  })

  it('rejects a missing name', () => {
    expect(() => parseRoutineSave({ ...base, name: ' ' })).toThrow('工作流名称')
  })

  it('rejects a bad notify value', () => {
    expect(() => parseRoutineSave({ ...base, notify: 'sometimes' })).toThrow('通知策略')
  })

  it('accepts a read-only workspaceMode and rejects an unknown one', () => {
    expect(parseRoutineSave({ ...base, workspaceMode: 'read-only' }).workspaceMode).toBe('read-only')
    expect(() => parseRoutineSave({ ...base, workspaceMode: 'nope' })).toThrow('工作区写权限')
  })
})

describe('parseSettingsSave', () => {
  const base = {
    favoriteModels: '',
    tavilyApiKey: '',
    sandboxEnabled: false,
    subagentsEnabled: true,
    remoteEnabled: true,
    feishuWebhookUrl: '',
    feishuSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuChatId: '',
    imageEngine: '',
    cloudImageRelay: '',
    cloudImageKey: '',
  }

  it('round-trips a valid form', () => {
    expect(parseSettingsSave({ ...base, clearCloudImageKey: true }).clearCloudImageKey).toBe(true)
  })

  // used to reach saveSettings and blow up on .trim()
  it('rejects a non-string cloudImageKey instead of crashing later', () => {
    expect(() => parseSettingsSave({ ...base, cloudImageKey: 42 })).toThrow('云端 Key')
  })

  // 直连 provider 退役后 provider 只是个未知字段,由「drops unknown fields」那条覆盖。
  it('drops the retired direct-provider fields from legacy clients', () => {
    const parsed = parseSettingsSave({ ...base, provider: 'openai', apiKey: 'k', baseUrl: 'x' })
    expect('provider' in parsed).toBe(false)
    expect('apiKey' in parsed).toBe(false)
    expect('baseUrl' in parsed).toBe(false)
  })

  it('drops unknown fields instead of persisting them', () => {
    const parsed = parseSettingsSave({ ...base, injected: 'x' })
    expect('injected' in parsed).toBe(false)
  })

  it('drops the retired security guard setting from legacy clients', () => {
    const parsed = parseSettingsSave({ ...base, securityGuardEnabled: true })
    expect('securityGuardEnabled' in parsed).toBe(false)
  })

  it('normalizes and dedupes the sandbox allowlist', () => {
    const parsed = parseSettingsSave({
      ...base,
      sandboxAllowedHosts: ['HTTPS://GitHub.com/x', 'github.com', 'pypi.org.'],
    })
    expect(parsed.sandboxAllowedHosts).toEqual(['github.com', 'pypi.org'])
  })

  it('defaults the sandbox allowlist to empty when absent', () => {
    expect(parseSettingsSave(base).sandboxAllowedHosts).toEqual([])
  })

  it('ignores a non-list sandbox allowlist', () => {
    expect(parseSettingsSave({ ...base, sandboxAllowedHosts: 42 }).sandboxAllowedHosts).toEqual([])
  })
})
