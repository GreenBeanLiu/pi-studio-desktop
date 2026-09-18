import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonRoutineDeleteOutbox,
} from './routine-delete-outbox'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createOutbox(): { outbox: JsonRoutineDeleteOutbox; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-studio-delete-outbox-'))
  dirs.push(dir)
  const path = join(dir, 'cloud-sync-outbox.json')
  return { outbox: new JsonRoutineDeleteOutbox(path), path }
}

describe('JsonRoutineDeleteOutbox', () => {
  it('retains, claims, and acknowledges deletes in fallback mode', () => {
    const { outbox } = createOutbox()
    outbox.add('https://trail-api.example', 'workflow-1')
    outbox.add('https://trail-api.example', 'workflow-1')

    const claimed = outbox.claimRoutineDeletes('https://trail-api.example', 'installation-1')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({
      workflowId: 'workflow-1',
      installationId: 'installation-1',
    })
    outbox.ackRoutineDelete(claimed[0].id)
    expect(outbox.readAll()).toEqual([])
  })

  it('reads the v0.3.50 format and archives it before clearing', () => {
    const { outbox, path } = createOutbox()
    writeFileSync(
      path,
      JSON.stringify([
        { origin: 'https://trail-api.example', installationId: null, workflowId: 'workflow-1' },
      ]),
      'utf8',
    )

    expect(outbox.readAll()).toMatchObject([{ workflowId: 'workflow-1' }])
    outbox.archiveAndClear()
    expect(outbox.readAll()).toEqual([])
    expect(existsSync(`${path}.backup-v1`)).toBe(true)
    expect(JSON.parse(readFileSync(`${path}.backup-v1`, 'utf8'))).toHaveLength(1)
  })

  it('never silently discards a damaged outbox', () => {
    const { outbox, path } = createOutbox()
    writeFileSync(path, '{broken', 'utf8')
    expect(() => outbox.readAll()).toThrow('Cloud sync delete outbox is damaged')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('commits the fallback store and delete intent through a recoverable journal', () => {
    const { path } = createOutbox()
    const storePath = join(path, '..', 'routines.json')
    const outbox = new JsonRoutineDeleteOutbox(path, storePath)
    const store = { routines: [], runs: [] }

    outbox.commitDelete(store, 'https://trail-api.example', 'workflow-1')

    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual(store)
    expect(outbox.readAll()).toMatchObject([{ workflowId: 'workflow-1' }])
    expect(existsSync(`${path}.transaction`)).toBe(false)
  })

  it('fails closed if a prior delete journal remains in the running process', () => {
    const { path } = createOutbox()
    const storePath = join(path, '..', 'routines.json')
    const outbox = new JsonRoutineDeleteOutbox(path, storePath)
    writeFileSync(`${path}.transaction`, '{partial', 'utf8')

    expect(() => outbox.assertReady()).toThrow('needs restart recovery')
    expect(() => outbox.commitDelete({ routines: [], runs: [] }, 'origin', 'workflow-2')).toThrow(
      'needs restart recovery',
    )
    expect(readFileSync(`${path}.transaction`, 'utf8')).toBe('{partial')
  })

})
