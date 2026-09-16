import contract from '../shared/contracts/permissions-v1.json'

/**
 * permissions/v1 —— 权限词汇和 shell 分类器的唯一来源是 pi-studio-control-plane 的
 * `contracts/permissions-v1.json`;`src/shared/contracts/` 里那份是逐字节镜像(docs/contracts/
 * 还有一份给人看)。2026-09-16 之前这六条正则是从控制面 `shell_scope.py` 手抄过来的:控制面按它算出
 * `scope.permission`,桌面再按自己那份重算并在不一致时回 SCOPE_MISMATCH —— 两份必须给出同一个答案,
 * 而没有任何东西保证这一点。现在两边都从同一个 JSON 编译,再各自跑同一份 conformance cases。
 */
export type LocalShellPermission =
  | 'shell_read'
  | 'workspace_write'
  | 'git_push'
  | 'pull_request'
  | 'production_deploy'
  | 'destructive_command'

export const PERMISSIONS_CONTRACT = contract.contract
export const SHELL_PERMISSIONS: readonly LocalShellPermission[] = contract.shell_permissions as LocalShellPermission[]

const classifier = contract.shell_classifier
const flags = classifier.flags
const READ_ONLY = classifier.read_only.map((pattern) => new RegExp(pattern, flags))
const RULES: Record<string, { pattern: RegExp; permission: LocalShellPermission }> = {
  composition: { pattern: new RegExp(classifier.composition, flags), permission: 'destructive_command' },
  destructive: { pattern: new RegExp(classifier.destructive, flags), permission: 'destructive_command' },
  deploy: { pattern: new RegExp(classifier.deploy, flags), permission: 'production_deploy' },
  git_push: { pattern: new RegExp(classifier.git_push, flags), permission: 'git_push' },
  pull_request: { pattern: new RegExp(classifier.pull_request, flags), permission: 'pull_request' },
}
const ORDER: readonly string[] = classifier.order
const FALLBACK = classifier.fallback as LocalShellPermission

/**
 * Shell 不是可可靠静态分析的语言。只免审批精确的只读查询;无法证明安全的命令一律要求
 * destructive_command,避免脚本、重定向和子 shell 伪装成写工作区。算法(顺序、回落)由契约给出。
 */
export function requiredLocalShellPermission(command: unknown): LocalShellPermission {
  const value = typeof command === 'string' ? command.trim() : ''
  if (!value) throw new Error('arguments.command is required')
  for (const step of ORDER) {
    if (step === 'read_only') {
      if (READ_ONLY.some((pattern) => pattern.test(value))) return 'shell_read'
      continue
    }
    const rule = RULES[step]
    if (rule && rule.pattern.test(value)) return rule.permission
  }
  return FALLBACK
}

export function isLocalShellPermission(value: unknown): value is LocalShellPermission {
  return typeof value === 'string' && (SHELL_PERMISSIONS as readonly string[]).includes(value)
}
