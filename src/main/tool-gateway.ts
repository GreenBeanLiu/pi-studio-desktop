import { isAbsolute, resolve } from 'path'
import { piClientManager } from './pi-client'
import {
  LocalFileToolError,
  LOCAL_FILE_MAX_BYTES,
  LOCAL_LIST_MAX_ENTRIES,
  listLocalDirectory,
  readLocalFile,
  writeLocalFile,
} from './local-file-tools'
import { isLocalShellPermission, requiredLocalShellPermission } from './local-shell-scope'
import { runWorkspaceChecks } from './workspace-checks'

type RemoteCommandFailure = { error: string; code: string }
export type LocalToolOperationReply = {
  operationId: string
  ok: true
  result: unknown
} | RemoteCommandFailure
type LocalToolHandler = (args: Record<string, unknown>) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameWorkspacePath(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function executeShellTool(args: Record<string, unknown>): Promise<unknown> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) {
    return { error: 'arguments.command is required', code: 'INVALID_TOOL_ARGUMENTS' }
  }
  return piClientManager.bash(command)
}

export const LOCAL_TOOL_HANDLERS = {
  'shell.exec': executeShellTool,
  bash: executeShellTool,
  'local.list': async (args: Record<string, unknown>) => listLocalDirectory(piClientManager.getWorkspacePath(), args),
  'local.read': async (args: Record<string, unknown>) => readLocalFile(piClientManager.getWorkspacePath(), args),
  'local.write': async (args: Record<string, unknown>) => writeLocalFile(piClientManager.getWorkspacePath(), args),
  'verify.checks': async (args: Record<string, unknown>) => {
    if (!Array.isArray(args.checks)) {
      return { error: 'arguments.checks must be a list', code: 'INVALID_TOOL_ARGUMENTS' }
    }
    const workspace = piClientManager.getWorkspacePath()
    if (!workspace) {
      return { error: 'No workspace is open', code: 'NO_WORKSPACE' }
    }
    return runWorkspaceChecks(workspace, args.checks)
  },
} satisfies Record<string, LocalToolHandler>

export const LOCAL_TOOL_PROTOCOL = {
  version: 2,
  supportedVersions: [1, 2],
  tools: Object.fromEntries(Object.keys(LOCAL_TOOL_HANDLERS).map((name) => [name, { schemaVersion: 1 }])),
} as const

export const TOOL_GATEWAY_MANIFEST = {
  manifestVersion: 1,
  operationProtocols: [1, 2],
  tools: [
    { name: 'shell.exec', scopeVersion: 2, requiresWorkspace: true },
    { name: 'bash', scopeVersion: 2, requiresWorkspace: true },
    { name: 'local.list', scopeVersion: 1, requiresWorkspace: true, maxEntries: LOCAL_LIST_MAX_ENTRIES },
    { name: 'local.read', scopeVersion: 1, requiresWorkspace: true, maxBytes: LOCAL_FILE_MAX_BYTES },
    { name: 'local.write', scopeVersion: 1, requiresWorkspace: true, maxBytes: LOCAL_FILE_MAX_BYTES },
    { name: 'verify.checks', scopeVersion: 1, requiresWorkspace: true },
  ],
} as const

export async function executeLocalToolOperation(msg: Record<string, unknown>): Promise<LocalToolOperationReply> {
  const operationId = String(msg.operationId ?? msg.operation_id ?? '').trim()
  const toolName = String(msg.toolName ?? msg.tool_name ?? msg.name ?? '').trim()
  const args = isRecord(msg.arguments) ? msg.arguments : isRecord(msg.args) ? msg.args : {}
  if (!operationId || !toolName) {
    return { error: 'operationId and toolName are required', code: 'INVALID_TOOL_OPERATION' }
  }
  const protocolValue = msg.protocolVersion ?? msg.protocol_version ?? 1
  const protocolVersion = typeof protocolValue === 'number' ? protocolValue : Number(protocolValue)
  if (!Number.isSafeInteger(protocolVersion) || !LOCAL_TOOL_PROTOCOL.supportedVersions.includes(protocolVersion as 1 | 2)) {
    return { error: `unsupported local tool protocol version: ${String(protocolValue)}`, code: 'UNSUPPORTED_TOOL_PROTOCOL' }
  }
  if (protocolVersion === 2) {
    const deadlineRaw = msg.deadlineAt ?? msg.deadline_at
    const deadline = typeof deadlineRaw === 'string' ? Date.parse(deadlineRaw) : NaN
    if (!Number.isFinite(deadline)) return { error: 'v2 deadlineAt is required', code: 'INVALID_DEADLINE' }
    if (deadline <= Date.now()) return { error: 'tool operation deadline expired', code: 'DEADLINE_EXPIRED' }
    const scope = isRecord(msg.scope) ? msg.scope : {}
    const scopeWorkspace = typeof scope.workspace === 'string' ? scope.workspace : ''
    const argumentWorkspace = typeof args.workspace === 'string' ? args.workspace : ''
    if (!sameWorkspacePath(scopeWorkspace, argumentWorkspace)) {
      return { error: 'tool scope workspace must match arguments.workspace', code: 'SCOPE_MISMATCH' }
    }
    const activeWorkspace = piClientManager.getWorkspacePath()
    if (!activeWorkspace || !sameWorkspacePath(scopeWorkspace, activeWorkspace)) {
      return { error: 'tool scope workspace is not the active workspace', code: 'SCOPE_MISMATCH' }
    }
    const permissions = scope.permissions
    if (!Array.isArray(permissions) || !permissions.includes(toolName)) {
      return { error: 'tool scope permissions must include toolName', code: 'SCOPE_MISMATCH' }
    }
    // 已批准的能力由控制面经 audit 带过来(routing.py 已发)。桌面自己也门控:远端驱动的写/执行
    // 不能只凭 scope 匹配就落地(计划 T4.2)。
    const audit = isRecord(msg.audit) ? msg.audit : {}
    const approvedRaw = audit.approved_capabilities ?? audit.approvedCapabilities
    const approvedList = Array.isArray(approvedRaw) ? approvedRaw.map((item) => String(item)) : []
    if (toolName === 'local.write' && !approvedList.includes('workspace_write')) {
      return { error: 'local.write requires approved workspace_write', code: 'SCOPE_MISMATCH' }
    }
    if (toolName === 'shell.exec' || toolName === 'bash') {
      const permission = scope.permission
      if (!isLocalShellPermission(permission)) {
        return { error: 'v2 shell scope requires a supported permission', code: 'SCOPE_MISMATCH' }
      }
      let required: string
      try {
        required = requiredLocalShellPermission(args.command)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), code: 'INVALID_TOOL_ARGUMENTS' }
      }
      if (permission !== required) {
        return { error: `shell command requires ${required} permission`, code: 'SCOPE_MISMATCH' }
      }
      // 只读查询(shell_read)不需批准;任何会改动的权限都必须在已批准列表里。
      if (permission !== 'shell_read' && !approvedList.includes(String(permission))) {
        return { error: `shell command requires approved ${permission}`, code: 'SCOPE_MISMATCH' }
      }
    }
    if (toolName === 'verify.checks') {
      const checks = Array.isArray(args.checks) ? args.checks : []
      const needsWrite = checks.some((item) => isRecord(item) && item.type === 'command')
      if (needsWrite && !approvedList.includes('workspace_write')) {
        return { error: 'command checks require approved workspace_write', code: 'SCOPE_MISMATCH' }
      }
    }
  }
  if (toolName === 'verify.checks' && protocolVersion < 2) {
    return { error: 'verify.checks requires tool protocol v2', code: 'UNSUPPORTED_TOOL_PROTOCOL' }
  }
  const handler = LOCAL_TOOL_HANDLERS[toolName as keyof typeof LOCAL_TOOL_HANDLERS]
  if (!handler) {
    return { error: `unsupported local tool: ${toolName}`, code: 'UNSUPPORTED_TOOL' }
  }
  let result: unknown
  try {
    result = await handler(args)
  } catch (error) {
    if (error instanceof LocalFileToolError) return { error: error.message, code: error.code }
    if (toolName === 'local.list' || toolName === 'local.read' || toolName === 'local.write') {
      const code = (error as NodeJS.ErrnoException).code
      return { error: error instanceof Error ? error.message : String(error), code: code || 'LOCAL_FILE_ERROR' }
    }
    throw error
  }
  if (isRecord(result) && typeof result.error === 'string' && typeof result.code === 'string') {
    return { error: result.error, code: result.code }
  }
  return { operationId, ok: true, result }
}
