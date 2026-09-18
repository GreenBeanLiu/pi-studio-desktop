import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoutineDatabase } from './routine-database'
import type { Routine, RoutineRun } from './routines'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { routines: Routine[]; runs: RoutineRun[] } {
  const routine: Routine = {
    id: 'workflow-legacy',
    name: 'Legacy workflow',
    steps: [{ id: 'legacy-step', name: 'Write', type: 'agent', prompt: 'draft' }],
    workspacePath: 'D:\\Works',
    schedule: { type: 'manual' },
    enabled: true,
    notify: 'never',
    createdAt: 100,
  }
  return {
    routines: [routine],
    runs: [
      {
        id: 'run-legacy',
        routineId: routine.id,
        routineName: routine.name,
        startedAt: 200,
        endedAt: 300,
        status: 'ok',
        triggerSource: 'manual',
        summary: 'done',
        steps: [
          {
            id: 'legacy-step',
            name: 'Write',
            status: 'ok',
            summary: 'done',
            durationMs: 100,
          },
        ],
      },
    ],
  }
}

function createPaths(): { dir: string; database: string; legacy: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-studio-routines-db-'))
  dirs.push(dir)
  return {
    dir,
    database: join(dir, 'routines.sqlite3'),
    legacy: join(dir, 'routines.json'),
  }
}

describe('RoutineDatabase', () => {
  it('imports legacy JSON once and keeps a backup', () => {
    const paths = createPaths()
    writeFileSync(paths.legacy, JSON.stringify(fixture()), 'utf8')
    const database = new RoutineDatabase(paths.database, paths.legacy)
    expect(database.load()).toEqual(fixture())
    database.close()

    expect(existsSync(`${paths.legacy}.backup-v1`)).toBe(true)
    expect(JSON.parse(readFileSync(`${paths.legacy}.backup-v1`, 'utf8'))).toEqual(fixture())
  })

  it('upgrades a legacy prompt-only workflow to a single step', () => {
    const paths = createPaths()
    const legacy = fixture()
    const promptOnly = {
      ...legacy.routines[0],
      prompt: 'legacy prompt',
    } as Record<string, unknown>
    delete promptOnly.steps
    writeFileSync(paths.legacy, JSON.stringify({ routines: [promptOnly], runs: [] }), 'utf8')

    const database = new RoutineDatabase(paths.database, paths.legacy)
    expect(database.load().routines[0].steps).toMatchObject([
      { name: 'Step 1', type: 'agent', prompt: 'legacy prompt' },
    ])
    expect(database.load().routines[0].steps[0].id).toMatch(/^[0-9a-f-]{36}$/)
    database.close()
  })

  it('uses SQLite as source of truth after the first import', () => {
    const paths = createPaths()
    writeFileSync(paths.legacy, JSON.stringify(fixture()), 'utf8')
    const first = new RoutineDatabase(paths.database, paths.legacy)
    first.close()
    writeFileSync(paths.legacy, JSON.stringify({ routines: [], runs: [] }), 'utf8')

    const reopened = new RoutineDatabase(paths.database, paths.legacy)
    expect(reopened.load().routines).toHaveLength(1)
    reopened.close()
  })

  it('round-trips application icon node configuration', () => {
    const paths = createPaths()
    const store = fixture()
    store.routines[0].steps = [
      {
        id: 'icon-step',
        name: 'Export app icons',
        type: 'app-icon',
        imageRef: '{{prev.imageUrl}}',
        appName: '{{routine.name}}',
        path: '.pi-studio/app-icons/app',
        backgroundColor: '#2563EB',
        platforms: ['android', 'ios', 'macos', 'windows'],
      },
    ]
    const database = new RoutineDatabase(paths.database, paths.legacy)
    database.save(store)
    expect(database.load().routines[0].steps[0]).toEqual(store.routines[0].steps[0])
    database.close()
  })

  it('does not mark a broken legacy file as imported and can retry', () => {
    const paths = createPaths()
    writeFileSync(paths.legacy, '{broken', 'utf8')
    expect(() => new RoutineDatabase(paths.database, paths.legacy)).toThrow()

    writeFileSync(paths.legacy, JSON.stringify(fixture()), 'utf8')
    const retried = new RoutineDatabase(paths.database, paths.legacy)
    expect(retried.load().routines).toHaveLength(1)
    retried.close()
  })

  it('commits a workflow deletion and sync intent in one transaction', () => {
    const paths = createPaths()
    writeFileSync(paths.legacy, JSON.stringify(fixture()), 'utf8')
    const database = new RoutineDatabase(paths.database, paths.legacy)
    database.save(
      { routines: [], runs: fixture().runs },
      { origin: 'https://trail-api.example', workflowId: 'workflow-legacy' },
    )

    const intents = database.claimRoutineDeletes('https://trail-api.example', 'installation-1')
    expect(intents).toMatchObject([
      {
        origin: 'https://trail-api.example',
        installationId: 'installation-1',
        workflowId: 'workflow-legacy',
      },
    ])
    database.ackRoutineDelete(intents[0].id)
    expect(database.claimRoutineDeletes('https://trail-api.example', 'installation-1')).toEqual([])
    database.setSyncState('last_success_at', '2026-07-13T00:00:00.000Z')
    expect(database.getSyncState('last_success_at')).toBe('2026-07-13T00:00:00.000Z')
    database.close()
  })

  it('imports a legacy delete outbox without creating duplicates', () => {
    const paths = createPaths()
    const database = new RoutineDatabase(paths.database, paths.legacy)
    const intent = {
      id: 1,
      origin: 'https://trail-api.example',
      installationId: null,
      workflowId: 'workflow-deleted',
    }
    database.importRoutineDeletes([intent, { ...intent, id: 2 }])

    expect(database.claimRoutineDeletes('https://trail-api.example', 'installation-1')).toMatchObject([
      { workflowId: 'workflow-deleted', installationId: 'installation-1' },
    ])
    database.close()
  })

  it('journals workflow progress immediately and marks open runs interrupted on restart', () => {
    const paths = createPaths()
    const database = new RoutineDatabase(paths.database, paths.legacy)
    database.appendRoutineRunEvent({
      runId: 'run-open',
      workflowId: 'workflow-1',
      type: 'run.started',
      stepId: null,
      payload: { triggerSource: 'manual' },
      createdAt: 100,
    })
    database.appendRoutineRunEvent({
      runId: 'run-open',
      workflowId: 'workflow-1',
      type: 'step.started',
      stepId: 'step-1',
      payload: { type: 'agent' },
      createdAt: 110,
    })
    database.appendRoutineRunEvent({
      runId: 'run-complete',
      workflowId: 'workflow-1',
      type: 'run.started',
      stepId: null,
      payload: {},
      createdAt: 120,
    })
    database.appendRoutineRunEvent({
      runId: 'run-complete',
      workflowId: 'workflow-1',
      type: 'run.completed',
      stepId: null,
      payload: {},
      createdAt: 130,
    })

    expect(database.interruptOpenRoutineRuns(200)).toMatchObject([
      { runId: 'run-open', type: 'run.interrupted', createdAt: 200 },
    ])
    expect(database.loadRoutineRunEvents('run-open').map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'step.failed',
      'run.interrupted',
    ])
    database.save(fixture())
    expect(database.loadRoutineRunEvents('run-open')).toHaveLength(4)
    expect(database.recoverMissingRoutineRuns([]).find((run) => run.id === 'run-open')).toMatchObject({
      id: 'run-open',
      status: 'interrupted',
      steps: [{ id: 'step-1', status: 'error' }],
    })
    expect(database.interruptOpenRoutineRuns(300)).toEqual([])
    database.close()
  })

  it('rebuilds a missing terminal run projection from the journal', () => {
    const paths = createPaths()
    const database = new RoutineDatabase(paths.database, paths.legacy)
    database.appendRoutineRunEvent({
      runId: 'journal-only',
      workflowId: 'workflow-1',
      type: 'run.started',
      stepId: null,
      payload: { routineName: 'Recovered', triggerSource: 'manual' },
      createdAt: 100,
    })
    database.appendRoutineRunEvent({
      runId: 'journal-only',
      workflowId: 'workflow-1',
      type: 'step.started',
      stepId: 'step-1',
      payload: { position: 0, name: 'Write', type: 'agent' },
      createdAt: 110,
    })
    database.appendRoutineRunEvent({
      runId: 'journal-only',
      workflowId: 'workflow-1',
      type: 'step.completed',
      stepId: 'step-1',
      payload: { position: 0, durationMs: 20, outputSummary: 'done' },
      createdAt: 130,
    })
    database.appendRoutineRunEvent({
      runId: 'journal-only',
      workflowId: 'workflow-1',
      type: 'run.completed',
      stepId: null,
      payload: { summary: 'done' },
      createdAt: 140,
    })

    expect(database.recoverMissingRoutineRuns([])).toEqual([
      expect.objectContaining({
        id: 'journal-only',
        routineName: 'Recovered',
        status: 'ok',
        summary: 'done',
        steps: [
          expect.objectContaining({
            id: 'step-1',
            status: 'ok',
            summary: 'done',
          }),
        ],
      }),
    ])
    expect(database.recoverMissingRoutineRuns([{ ...fixture().runs[0], id: 'journal-only' }])).toEqual([])
    database.close()
  })

  it('prunes old terminal journals while preserving recent and open runs', () => {
    const paths = createPaths()
    const database = new RoutineDatabase(paths.database, paths.legacy)
    for (const [index, runId] of ['old', 'recent', 'newest'].entries()) {
      database.appendRoutineRunEvent({
        runId,
        workflowId: 'workflow-1',
        type: 'run.started',
        stepId: null,
        payload: {},
        createdAt: index * 10,
      })
      database.appendRoutineRunEvent({
        runId,
        workflowId: 'workflow-1',
        type: 'run.completed',
        stepId: null,
        payload: {},
        createdAt: index * 10 + 1,
      })
    }
    database.appendRoutineRunEvent({
      runId: 'open',
      workflowId: 'workflow-1',
      type: 'run.started',
      stepId: null,
      payload: {},
    })

    database.pruneRoutineRunEvents(2)

    expect(database.loadRoutineRunEvents('old')).toEqual([])
    expect(database.loadRoutineRunEvents('recent')).toHaveLength(2)
    expect(database.loadRoutineRunEvents('newest')).toHaveLength(2)
    expect(database.loadRoutineRunEvents('open')).toHaveLength(1)
    database.close()
  })

  it('force-closes an open step and run when cancellation grace expires', () => {
    const paths = createPaths()
    const database = new RoutineDatabase(paths.database, paths.legacy)
    database.appendRoutineRunEvent({
      runId: 'forced-run',
      workflowId: 'workflow-1',
      type: 'run.started',
      stepId: null,
      payload: { routineName: 'Forced' },
    })
    database.appendRoutineRunEvent({
      runId: 'forced-run',
      workflowId: 'workflow-1',
      type: 'step.started',
      stepId: 'step-1',
      payload: { position: 0, name: 'Hung node' },
    })

    expect(database.cancelOpenRoutineRun('forced-run', 'workflow-1')).toMatchObject({
      type: 'run.cancelled',
    })
    expect(database.loadRoutineRunEvents('forced-run').map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'step.failed',
      'run.cancelled',
    ])
    expect(database.recoverMissingRoutineRuns([])[0]).toMatchObject({
      status: 'cancelled',
      steps: [{ status: 'cancelled' }],
    })
    expect(database.cancelOpenRoutineRun('forced-run', 'workflow-1')).toBeNull()
    database.close()
  })
})
