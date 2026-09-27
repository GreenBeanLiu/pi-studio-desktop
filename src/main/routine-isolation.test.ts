import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  diffWorkspaceTrees,
  materializeIsolatedWorkspace,
  removeIsolatedWorkspace,
} from './routine-isolation'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-routine-iso-'))
  roots.push(root)
  return root
}

function seedWorkspace(src: string): void {
  mkdirSync(join(src, 'src'), { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'a', 'utf8')
  writeFileSync(join(src, 'src', 'b.ts'), 'b', 'utf8')
}

describe('routine isolation', () => {
  it('copies the working tree but skips heavy dirs', async () => {
    const root = scratch()
    const src = join(root, 'ws')
    seedWorkspace(src)
    mkdirSync(join(src, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(src, 'node_modules', 'x', 'big.js'), 'big', 'utf8')
    mkdirSync(join(src, '.git'), { recursive: true })
    writeFileSync(join(src, '.git', 'HEAD'), 'ref', 'utf8')

    const copy = join(root, 'copy')
    await materializeIsolatedWorkspace(src, copy)

    expect(readFileSync(join(copy, 'a.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(copy, 'src', 'b.ts'))).toBe(true)
    expect(existsSync(join(copy, 'node_modules'))).toBe(false)
    expect(existsSync(join(copy, '.git'))).toBe(false)
  })

  it('reports added, modified and deleted files against the copied tree', async () => {
    const root = scratch()
    const src = join(root, 'ws')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'keep.txt'), 'same', 'utf8')
    writeFileSync(join(src, 'edit.txt'), 'before', 'utf8')
    writeFileSync(join(src, 'gone.txt'), 'bye', 'utf8')

    const copy = join(root, 'copy')
    await materializeIsolatedWorkspace(src, copy)
    writeFileSync(join(copy, 'edit.txt'), 'after!', 'utf8')
    writeFileSync(join(copy, 'new.txt'), 'hi', 'utf8')
    rmSync(join(copy, 'gone.txt'))

    const { changes, truncated } = await diffWorkspaceTrees(src, copy)
    expect(changes).toEqual([
      { path: 'edit.txt', kind: 'modified' },
      { path: 'gone.txt', kind: 'deleted' },
      { path: 'new.txt', kind: 'added' },
    ])
    expect(truncated).toBe(false)
  })

  it('flags a same-size edit as modified (content hash, not size)', async () => {
    const root = scratch()
    const src = join(root, 'ws')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'same-size.txt'), 'AAAA', 'utf8')

    const copy = join(root, 'copy')
    await materializeIsolatedWorkspace(src, copy)
    writeFileSync(join(copy, 'same-size.txt'), 'BBBB', 'utf8')

    const { changes } = await diffWorkspaceTrees(src, copy)
    expect(changes).toEqual([{ path: 'same-size.txt', kind: 'modified' }])
  })

  it('returns no changes for an untouched copy', async () => {
    const root = scratch()
    const src = join(root, 'ws')
    seedWorkspace(src)
    const copy = join(root, 'copy')
    await materializeIsolatedWorkspace(src, copy)
    expect((await diffWorkspaceTrees(src, copy)).changes).toEqual([])
  })

  it('truncates the change list at the cap', async () => {
    const root = scratch()
    const src = join(root, 'ws')
    mkdirSync(src, { recursive: true })
    const copy = join(root, 'copy')
    await materializeIsolatedWorkspace(src, copy)
    for (let i = 0; i < 5; i++) writeFileSync(join(copy, `f${i}.txt`), 'x', 'utf8')

    const { changes, truncated } = await diffWorkspaceTrees(src, copy, 3)
    expect(changes).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('removes the copy directory', async () => {
    const root = scratch()
    const copy = join(root, 'copy')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'x.txt'), 'x', 'utf8')
    await removeIsolatedWorkspace(copy)
    expect(existsSync(copy)).toBe(false)
  })
})
