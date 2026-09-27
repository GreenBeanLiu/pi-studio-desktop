import { createHash } from 'crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { app } from 'electron'
import type { IsolatedApplyResult, IsolatedRoutineRun, RoutineWorkspaceChange } from '../shared/ipc/contract'

/**
 * 无人值守 routine 的隔离工作副本（见 docs/sandbox-mode-plan.md）。
 *
 * `workspaceMode = 'isolated'` 时，agent 节点不再直接读写真实工作区，而是先把工作区按
 * 当前工作树 materialize 到一次性目录，agent 在副本里跑；跑完按 materialize 时记下的
 * manifest 比对出 **agent 的改动**，保留副本供审阅，用户可一键应用回真实工作区（冲突跳过）
 * 或丢弃。
 *
 * - 只隔离 agent 节点：确定性节点（export / imagegen / folder-input / …）仍走真实工作区。
 * - 变更 = 副本 vs manifest（不是 vs 当前源），所以运行期间用户的并发编辑不会被算成 agent 改动。
 * - 应用是**全量**、逐文件校验冲突：源文件自 run 开始被外部改过的跳过并报告，绝不覆盖。
 * - 不用 `git worktree`：worktree 只含 HEAD、不含未提交改动；直接拷工作树更符合「输入快照」。
 */

/** 拷贝 / 比对时跳过的重目录（按 basename 匹配）。 */
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  '.cache',
  '.gradle',
  'target',
  'build',
])

/** 变更比对的硬上限：超过就只标记「未逐字节比对」，避免把大工作区读穿。 */
const MAX_HASHED_FILES = 5000
const MAX_HASHED_BYTES = 128 * 1024 * 1024

const MANIFEST_FILE = 'manifest.json'
const META_FILE = 'meta.json'

type TreeEntry = { size: number; hash: string }
export type TreeManifest = Record<string, TreeEntry>

/** 隔离副本的根目录。启动时按保留期清理，run 之间不复用。 */
export function isolatedWorkspaceRoot(): string {
  return join(app.getPath('userData'), 'routine-runs')
}

export function isolatedRunDir(runId: string): string {
  return join(isolatedWorkspaceRoot(), runId)
}

export function isolatedWorkspaceDir(runId: string): string {
  return join(isolatedRunDir(runId), 'workspace')
}

function skipEntry(name: string): boolean {
  return EXCLUDED_DIRS.has(name)
}

/** 把 source 的工作树拷进 targetDir（过滤重目录）。 */
export async function materializeIsolatedWorkspace(source: string, targetDir: string): Promise<void> {
  await cp(source, targetDir, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => !skipEntry(src.split(/[\\/]/).pop() ?? ''),
  })
}

async function walkTree(root: string): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>()
  let hashedFiles = 0
  let hashedBytes = 0
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skipEntry(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      if (!entry.isFile()) continue // 符号链接等一律跳过
      const rel = relative(root, full).split(sep).join('/')
      if (hashedFiles >= MAX_HASHED_FILES || hashedBytes >= MAX_HASHED_BYTES) {
        out.set(rel, { size: -1, hash: '' })
        continue
      }
      try {
        const info = await stat(full)
        const content = await readFile(full)
        hashedFiles++
        hashedBytes += info.size
        out.set(rel, { size: info.size, hash: createHash('sha1').update(content).digest('hex') })
      } catch {
        // 读不到就当没这个文件
      }
    }
  }
  await visit(root)
  return out
}

function compareTrees(
  before: Map<string, TreeEntry>,
  after: Map<string, TreeEntry>,
  max: number,
): { changes: RoutineWorkspaceChange[]; truncated: boolean } {
  const changes: RoutineWorkspaceChange[] = []
  let truncated = false
  const push = (change: RoutineWorkspaceChange): void => {
    if (changes.length >= max) {
      truncated = true
      return
    }
    changes.push(change)
  }
  for (const [path, entry] of after) {
    const prev = before.get(path)
    if (!prev) push({ path, kind: 'added' })
    // size < 0 表示超出哈希预算、没逐字节比对；这时不判定修改，避免误报
    else if (prev.size >= 0 && entry.size >= 0 && (prev.size !== entry.size || prev.hash !== entry.hash)) {
      push({ path, kind: 'modified' })
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) push({ path, kind: 'deleted' })
  }
  changes.sort((left, right) => left.path.localeCompare(right.path))
  return { changes, truncated }
}

/** materialize 后立刻调用：记下副本的初始状态（= 源工作区在 run 开始时的样子）。 */
export async function snapshotTree(root: string): Promise<TreeManifest> {
  return Object.fromEntries(await walkTree(root))
}

/** 变更 = 当前副本 vs materialize 时的 manifest（即 agent 的改动）。 */
export async function diffAgainstManifest(
  root: string,
  manifest: TreeManifest,
  max = 200,
): Promise<{ changes: RoutineWorkspaceChange[]; truncated: boolean }> {
  return compareTrees(new Map(Object.entries(manifest)), await walkTree(root), max)
}

/** 直接比对两棵目录树（用于测试与诊断）。 */
export async function diffWorkspaceTrees(
  source: string,
  copy: string,
  max = 200,
): Promise<{ changes: RoutineWorkspaceChange[]; truncated: boolean }> {
  return compareTrees(await walkTree(source), await walkTree(copy), max)
}

/** 保留一次隔离运行的副本 + manifest + meta，供用户应用 / 丢弃。 */
export async function persistIsolatedRun(
  runDir: string,
  meta: IsolatedRoutineRun,
  manifest: TreeManifest,
): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, MANIFEST_FILE), JSON.stringify(manifest), 'utf8')
  await writeFile(join(runDir, META_FILE), JSON.stringify(meta), 'utf8')
}

async function readIsolatedRun(runDir: string): Promise<{ meta: IsolatedRoutineRun; manifest: TreeManifest }> {
  const [meta, manifest] = await Promise.all([
    readFile(join(runDir, META_FILE), 'utf8').then((text) => JSON.parse(text) as IsolatedRoutineRun),
    readFile(join(runDir, MANIFEST_FILE), 'utf8').then((text) => JSON.parse(text) as TreeManifest),
  ])
  return { meta, manifest }
}

/** 列出所有已保留的隔离运行，最新在前。坏目录跳过。 */
export async function listIsolatedRuns(): Promise<IsolatedRoutineRun[]> {
  let entries
  try {
    entries = await readdir(isolatedWorkspaceRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const runs: IsolatedRoutineRun[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const { meta } = await readIsolatedRun(join(isolatedWorkspaceRoot(), entry.name))
      runs.push(meta)
    } catch {
      // 缺 meta/manifest 的残留目录忽略
    }
  }
  return runs.sort((left, right) => right.createdAt - left.createdAt)
}

export async function removeIsolatedWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export async function discardIsolatedRun(runId: string): Promise<void> {
  await removeIsolatedWorkspace(isolatedRunDir(runId))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function hashFileIfExists(path: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 全量应用一次隔离运行：新增/修改的文件拷回源工作区，删除的文件删掉。
 * 逐文件校验冲突（源文件自 run 开始被外部改过、或新增路径已被占用）——冲突跳过并报告，
 * 绝不覆盖。全部干净应用后删掉保留的副本。
 */
export async function applyIsolatedRun(runId: string): Promise<IsolatedApplyResult> {
  return applyIsolatedRunDir(isolatedRunDir(runId))
}

export async function applyIsolatedRunDir(runDir: string): Promise<IsolatedApplyResult> {
  const { meta, manifest } = await readIsolatedRun(runDir)
  const applied: string[] = []
  const skipped: { path: string; reason: string }[] = []
  const errors: { path: string; message: string }[] = []

  for (const change of meta.changes) {
    const parts = change.path.split('/')
    const sourceFile = join(meta.sourcePath, ...parts)
    const copyFile = join(runDir, 'workspace', ...parts)
    const baseHash = manifest[change.path]?.hash
    try {
      if (change.kind === 'deleted') {
        const current = await hashFileIfExists(sourceFile)
        if (current === null) {
          applied.push(change.path) // 已经不在了
        } else if (baseHash === undefined || current !== baseHash) {
          skipped.push({ path: change.path, reason: '源文件已被外部修改' })
        } else {
          await rm(sourceFile, { force: true })
          applied.push(change.path)
        }
        continue
      }
      if (change.kind === 'added') {
        if (await fileExists(sourceFile)) {
          skipped.push({ path: change.path, reason: '源路径已存在同名文件' })
          continue
        }
      } else {
        const current = await hashFileIfExists(sourceFile)
        if (current === null) {
          skipped.push({ path: change.path, reason: '源文件已不存在' })
          continue
        }
        if (baseHash === undefined || current !== baseHash) {
          skipped.push({ path: change.path, reason: '源文件已被外部修改' })
          continue
        }
      }
      await mkdir(dirname(sourceFile), { recursive: true })
      await cp(copyFile, sourceFile)
      applied.push(change.path)
    } catch (error) {
      errors.push({ path: change.path, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const removed = skipped.length === 0 && errors.length === 0
  if (removed) await removeIsolatedWorkspace(runDir).catch(() => {})
  return { applied, skipped, errors, removed }
}

/** 启动时按保留期清理旧的待处理副本（run 之间不复用；太久没处理的直接丢）。 */
export async function pruneIsolatedRuns(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  let entries
  try {
    entries = await readdir(isolatedWorkspaceRoot(), { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(isolatedWorkspaceRoot(), entry.name)
    try {
      const info = await stat(dir)
      if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
}
