import { createHash } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'fs'
import { dirname } from 'path'

/**
 * 工具操作账本(Tool Gateway v1 §8 receipts)。
 *
 * 控制面把 executeToolOperation 发过来、桌面做了、结果在回去的路上丢了(断线 / relay 重启 / 超时)——
 * 控制面分不清"没收到"和"做了没回",对 local.write / shell.exec 不敢重发也不敢当成功。
 * 所以桌面在**执行前**记一笔 dispatched,**执行后**记一笔 settled(含结果),每笔 fsync;
 * 控制面回来问 toolOperationReceipt,按账本回:unknown(没见过,重发安全)/ dispatched(收到了没做完)/ settled(结果在此)。
 *
 * 只追加的 JSONL;进程启动时整本读进内存建索引。上一次进程没写完的 dispatched 在启动时补一笔
 * settled(INTERRUPTED):这个进程还没执行过任何操作,所以悬着的一定是上一次的。
 */
export type ToolReceiptState = 'unknown' | 'dispatched' | 'settled'

export type ToolReceipt = {
  operationId: string
  state: ToolReceiptState
  toolName?: string
  taskId?: string
  subtaskId?: string
  principal?: string
  idempotencyKey?: string
  argumentsSha256?: string
  dispatchedAt?: string
  settledAt?: string
  ok?: boolean
  code?: string
  error?: string
  result?: unknown
}

export type ToolReceiptOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: string }

type DispatchedRecord = {
  kind: 'dispatched'
  operationId: string
  at: string
  toolName: string
  taskId?: string
  subtaskId?: string
  principal?: string
  idempotencyKey?: string
  argumentsSha256: string
}

type SettledRecord = {
  kind: 'settled'
  operationId: string
  at: string
  ok: boolean
  code?: string
  error?: string
  result?: unknown
  resultSha256?: string
  resultTruncated?: true
}

type LedgerRecord = DispatchedRecord | SettledRecord

/** 结果最多存这么多字节;再大只存哈希 —— 账本是回执,不是结果仓库。 */
export const RECEIPT_RESULT_MAX_BYTES = 256 * 1024
/** 超过就滚成 .1(只留一代);索引里两代都在。 */
const ROTATE_BYTES = 8 * 1024 * 1024

export const INTERRUPTED_ERROR = 'desktop restarted before the operation finished; its effect is unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Relay 上走 camelCase;进契约(docs/contracts/schemas/tool-operation-receipt.schema.json)前转成 snake_case canonical。 */
export function canonicalToolReceipt(receipt: ToolReceipt): Record<string, unknown> {
  const canonical: Record<string, unknown> = { operation_id: receipt.operationId, state: receipt.state }
  const fields: Array<[keyof ToolReceipt, string]> = [
    ['toolName', 'tool_name'], ['taskId', 'task_id'], ['subtaskId', 'subtask_id'], ['principal', 'principal'],
    ['idempotencyKey', 'idempotency_key'], ['argumentsSha256', 'arguments_sha256'], ['dispatchedAt', 'dispatched_at'],
    ['settledAt', 'settled_at'], ['ok', 'ok'], ['code', 'code'], ['error', 'error'], ['result', 'result'],
  ]
  for (const [from, to] of fields) {
    if (receipt[from] !== undefined) canonical[to] = receipt[from]
  }
  return canonical
}

export class ToolReceiptLedger {
  private readonly receipts = new Map<string, ToolReceipt>()
  private loaded = false

  constructor(private readonly path: string) {}

  /** 读盘建索引;悬着的 dispatched 补 settled(INTERRUPTED)。幂等,第一次用时自动调。 */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    mkdirSync(dirname(this.path), { recursive: true })
    for (const file of [`${this.path}.1`, this.path]) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue // 断电截断的半行:丢掉,后面的行照读
        }
        if (isRecord(record)) this.index(record as LedgerRecord)
      }
    }
    const dangling = [...this.receipts.values()].filter((receipt) => receipt.state === 'dispatched')
    for (const receipt of dangling) {
      this.append({
        kind: 'settled', operationId: receipt.operationId, at: new Date().toISOString(),
        ok: false, code: 'INTERRUPTED', error: INTERRUPTED_ERROR,
      })
    }
  }

  /** 执行前记一笔。写不进盘就抛 —— 调用方据此拒绝执行,而不是做了没账。 */
  recordDispatch(msg: Record<string, unknown>): void {
    this.load()
    const operationId = optionalString(msg.operationId ?? msg.operation_id)
    if (!operationId) return
    const audit = isRecord(msg.audit) ? msg.audit : {}
    const args = isRecord(msg.arguments) ? msg.arguments : isRecord(msg.args) ? msg.args : {}
    this.append({
      kind: 'dispatched',
      operationId,
      at: new Date().toISOString(),
      toolName: optionalString(msg.toolName ?? msg.tool_name ?? msg.name) ?? '',
      taskId: optionalString(audit.task_id ?? audit.taskId),
      subtaskId: optionalString(audit.subtask_id ?? audit.subtaskId),
      principal: optionalString(audit.principal),
      idempotencyKey: optionalString(msg.idempotencyKey ?? msg.idempotency_key),
      argumentsSha256: sha256(stableJson(args)),
    })
  }

  /** 执行后记一笔。这一笔写失败只记日志级别的问题:操作已经做了,账本至少还有 dispatched。 */
  recordSettled(operationId: string, outcome: ToolReceiptOutcome): void {
    this.load()
    const record: SettledRecord = { kind: 'settled', operationId, at: new Date().toISOString(), ok: outcome.ok }
    if (outcome.ok) {
      const serialized = JSON.stringify(outcome.result ?? null)
      if (Buffer.byteLength(serialized, 'utf8') <= RECEIPT_RESULT_MAX_BYTES) {
        record.result = outcome.result ?? null
      } else {
        record.resultSha256 = sha256(serialized)
        record.resultTruncated = true
      }
    } else {
      record.error = outcome.error
      if (outcome.code) record.code = outcome.code
    }
    this.append(record)
  }

  lookup(operationId: string): ToolReceipt {
    this.load()
    return this.receipts.get(operationId) ?? { operationId, state: 'unknown' }
  }

  private index(record: LedgerRecord): void {
    if (typeof record.operationId !== 'string' || !record.operationId) return
    const current = this.receipts.get(record.operationId)
    if (record.kind === 'dispatched') {
      if (current?.state === 'settled') return // 已结的不回退
      this.receipts.set(record.operationId, {
        operationId: record.operationId,
        state: 'dispatched',
        toolName: record.toolName,
        taskId: record.taskId,
        subtaskId: record.subtaskId,
        principal: record.principal,
        idempotencyKey: record.idempotencyKey,
        argumentsSha256: record.argumentsSha256,
        dispatchedAt: record.at,
      })
      return
    }
    if (record.kind === 'settled') {
      if (current?.state === 'settled') return // 第一笔结算算数,重复的忽略
      const settled: ToolReceipt = {
        ...(current ?? { operationId: record.operationId }),
        state: 'settled',
        settledAt: record.at,
        ok: record.ok === true,
      }
      if (record.ok === true) {
        settled.result = record.resultTruncated ? { truncated: true, sha256: record.resultSha256 } : record.result ?? null
      } else {
        settled.error = record.error ?? 'tool operation failed'
        if (record.code) settled.code = record.code
      }
      this.receipts.set(record.operationId, settled)
    }
  }

  private append(record: LedgerRecord): void {
    this.rotateIfNeeded()
    const fd = openSync(this.path, 'a')
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.index(record)
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size >= ROTATE_BYTES) renameSync(this.path, `${this.path}.1`)
    } catch {
      /* 滚不动就继续往同一个文件追加 */
    }
  }
}

