import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  aggregateSyncFailure,
  cloudStepId,
  isDisownedStatus,
  routineRunPayload,
  routineWorkflowPayload,
} from './routine-cloud-sync'
import type { Routine, RoutineRun } from './routines'

const routine: Routine = {
  id: '8d0063db-6528-4f77-90a0-fb861a4f05e0',
  name: 'Article',
  input: 'AI topic',
  workspacePath: 'D:\\Works',
  schedule: { type: 'daily', time: '09:00' },
  enabled: true,
  notify: 'error',
  pushEachStep: true,
  createdAt: Date.UTC(2026, 6, 13),
  steps: [
    {
      id: 'e0840b63-1087-48d9-a99d-7a3224f854b4',
      name: 'Write',
      type: 'agent',
      prompt: 'draft',
    },
  ],
}

describe('routine cloud payloads', () => {
  it('maps legacy non-UUID step ids to stable UUIDs', () => {
    const first = cloudStepId(routine.id, '1783900277067-8zwuc3jc9hc')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(cloudStepId(routine.id, '1783900277067-8zwuc3jc9hc')).toBe(first)
    expect(cloudStepId(routine.id, routine.steps[0].id)).toBe(routine.steps[0].id)
  })

  it('maps the current routine shape without secrets', () => {
    expect(routineWorkflowPayload(routine)).toMatchObject({
      name: 'Article',
      input: 'AI topic',
      workspace_path: 'D:\\Works',
      notify_mode: 'error',
      push_each_step: true,
      steps: [{ id: routine.steps[0].id, type: 'agent', prompt: 'draft' }],
    })
  })

  it('stores application icon options in the cloud step config', () => {
    const iconRoutine: Routine = {
      ...routine,
      steps: [
        {
          id: 'icon-step',
          name: 'Icons',
          type: 'app-icon',
          imageRef: '{{prev.imageUrl}}',
          appName: 'FocusFlow',
          backgroundColor: '#2563EB',
          platforms: ['android', 'ios', 'macos', 'windows'],
        },
      ],
    }
    expect(routineWorkflowPayload(iconRoutine)).toMatchObject({
      steps: [
        {
          type: 'app-icon',
          config: {
            image_ref: '{{prev.imageUrl}}',
            app_name: 'FocusFlow',
            background_color: '#2563EB',
            platforms: ['android', 'ios', 'macos', 'windows'],
          },
        },
      ],
    })
  })

  // 2026-08-03:解除配对后重新配对留下 3 条归属旧账号的 workflow,第一条 403 就
  // 抛出中断整份快照 —— 例程和运行记录的同步整整坏了一天,每 5 分钟重试一次同样的 403。
  it('treats an ownership rejection as permanent and everything else as retryable', () => {
    expect(isDisownedStatus(403)).toBe(true)
    expect(isDisownedStatus(500)).toBe(false)
    expect(isDisownedStatus(429)).toBe(false)
  })

  it('reports every retryable failure once instead of stopping at the first', () => {
    expect(aggregateSyncFailure([])).toBeNull()
    expect(aggregateSyncFailure(['boom'])?.message).toBe('boom')
    expect(aggregateSyncFailure(['boom', 'bang', 'crash'])?.message).toBe('boom (+2 more)')
  })

  it('keeps pushing the rest of the snapshot after a record fails', () => {
    const source = readFileSync(new URL('./routine-cloud-sync.ts', import.meta.url), 'utf8')
    // 收集失败再统一抛出,而不是碰到第一条就 await expectOk 直接中断循环
    expect(source).toContain('if (failure) failures.push(failure)')
    expect(source).toContain('if (disownedIds.has(id)) return null')
  })

  it('maps completed runs and links step definitions', () => {
    const run: RoutineRun = {
      id: '58ce991c-f0b4-41f9-86e3-786cd643977a',
      routineId: routine.id,
      routineName: routine.name,
      startedAt: Date.UTC(2026, 6, 13, 1),
      endedAt: Date.UTC(2026, 6, 13, 1, 1),
      status: 'ok',
      triggerSource: 'schedule',
      summary: 'done',
      steps: [{ id: routine.steps[0].id, name: 'Write', status: 'ok', summary: 'done', durationMs: 1000 }],
    }
    expect(routineRunPayload(run, new Map([[routine.id, routine]]))).toMatchObject({
      workflow_id: routine.id,
      workflow_name: 'Article',
      status: 'ok',
      trigger_source: 'schedule',
      input_snapshot: 'AI topic',
      steps: [{ workflow_step_id: routine.steps[0].id, type: 'agent', duration_ms: 1000 }],
    })
  })
})
