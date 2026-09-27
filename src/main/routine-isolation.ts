import { createHash } from 'crypto'
import { cp, readdir, readFile, rm, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { app } from 'electron'

/**
 * 无人值守 routine 的隔离工作副本（见 docs/sandbox-mode-plan.md）。
 *
 * `workspaceMode = 'isolated'` 时，agent 节点不再直接读写真实工作区，而是先把工作区按
 * 当前工作树 materialize 到一次性目录，agent 在副本里跑；跑完比对副本与原工作区，把
 * 变更文件清单作为证据写进 run 结果，副本随后清理。
 *
 * - 只隔离 agent 节点：确定性节点（export / imagegen / folder-input / …）仍走真实工作区。
 * - **不自动应用**变更——应用是另一块（冲突 / 部分应用 / 回滚）。
 * - 不用 `git worktree`：worktree 只含 HEAD、不含用户未提交的改动；直接拷工作树更符合
 *   「输入快照」语义，也不依赖 git。
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

export type WorkspaceChange = {
  /** 相对工作区根的 POSIX 路径 */
  path: string
  kind: 'added' | 'modified' | 'deleted'
}

/** 隔离副本的根目录。启动时整体清理，run 之间不复用。 */
export function isolatedWorkspaceRoot(): string {
  return join(app.getPath('userData'), 'routine-runs')
}

export function isolatedWorkspaceDir(runId: string): string {
  return join(isolatedWorkspaceRoot(), runId, 'workspace')
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

type TreeEntry = { size: number; hash: string }

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

/** 比对两棵树：副本相对原工作区的变更（相对路径，按字母序，最多 max 条）。 */
export async function diffWorkspaceTrees(
  source: string,
  copy: string,
  max = 200,
): Promise<{ changes: WorkspaceChange[]; truncated: boolean }> {
  const before = await walkTree(source)
  const after = await walkTree(copy)
  const changes: WorkspaceChange[] = []
  let truncated = false
  const push = (change: WorkspaceChange): void => {
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

export async function removeIsolatedWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** 启动时清掉上次崩溃遗留的副本目录（run 之间不复用）。 */
export async function clearAllIsolatedWorkspaces(): Promise<void> {
  await rm(isolatedWorkspaceRoot(), { recursive: true, force: true })
}
