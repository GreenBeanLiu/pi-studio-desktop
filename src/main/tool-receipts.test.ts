import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { INTERRUPTED_ERROR, RECEIPT_RESULT_MAX_BYTES, ToolReceiptLedger } from './tool-receipts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-tool-receipts-'))
  path = join(dir, 'pi-agent', 'tool-operations.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const dispatch = (operationId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'executeToolOperation',
  operationId,
  toolName: 'local.write',
  arguments: { workspace: '/w', path: 'note.txt', content: 'hello' },
  idempotencyKey: `task-1:${operationId}`,
  audit: { task_id: 'task-1', subtask_id: 'sub-1', principal: 'account:acc-1', requested_by: 'me' },
  ...extra,
})

describe('ToolReceiptLedger', () => {
  it('answers unknown for an operation it never saw', () => {
    const ledger = new ToolReceiptLedger(path)
    expect(ledger.lookup('toolop-never')).toEqual({ operationId: 'toolop-never', state: 'unknown' })
  })

  it('records dispatched before and settled after, and the receipt carries the result and who asked', () => {
    const ledger = new ToolReceiptLedger(path)
    ledger.recordDispatch(dispatch('toolop-1'))
    expect(ledger.lookup('toolop-1')).toMatchObject({
      state: 'dispatched', toolName: 'local.write', taskId: 'task-1', subtaskId: 'sub-1', principal: 'account:acc-1',
      idempotencyKey: 'task-1:toolop-1', argumentsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    ledger.recordSettled('toolop-1', { ok: true, result: { path: 'note.txt', bytes: 5 } })
    expect(ledger.lookup('toolop-1')).toMatchObject({ state: 'settled', ok: true, result: { path: 'note.txt', bytes: 5 } })
    // two lines on disk, in order, each a complete JSON document
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => line.kind)).toEqual(['dispatched', 'settled'])
  })

  it('keeps the failure code of a settled error', () => {
    const ledger = new ToolReceiptLedger(path)
    ledger.recordDispatch(dispatch('toolop-2'))
    ledger.recordSettled('toolop-2', { ok: false, error: 'tool scope workspace is not the active workspace', code: 'SCOPE_MISMATCH' })
    expect(ledger.lookup('toolop-2')).toMatchObject({ state: 'settled', ok: false, code: 'SCOPE_MISMATCH' })
  })

  it('survives a restart: the ledger on disk is the truth, not the process memory', () => {
    const first = new ToolReceiptLedger(path)
    first.recordDispatch(dispatch('toolop-3'))
    first.recordSettled('toolop-3', { ok: true, result: { bytes: 5 } })
    const second = new ToolReceiptLedger(path)
    expect(second.lookup('toolop-3')).toMatchObject({ state: 'settled', ok: true, result: { bytes: 5 } })
  })

  // 上一个进程写了 dispatched 就崩了:这一进程启动时还没执行过任何操作,悬着的一定是它的。
  it('settles a dangling dispatched record as INTERRUPTED on load', () => {
    const first = new ToolReceiptLedger(path)
    first.recordDispatch(dispatch('toolop-4'))
    const second = new ToolReceiptLedger(path)
    expect(second.lookup('toolop-4')).toMatchObject({ state: 'settled', ok: false, code: 'INTERRUPTED', error: INTERRUPTED_ERROR })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('ignores a truncated trailing line and keeps reading the rest', () => {
    const first = new ToolReceiptLedger(path)
    first.recordDispatch(dispatch('toolop-5'))
    first.recordSettled('toolop-5', { ok: true, result: null })
    appendFileSync(path, '{"kind":"dispatched","operationId":"toolop-6","at":"2026-')
    const second = new ToolReceiptLedger(path)
    expect(second.lookup('toolop-5')).toMatchObject({ state: 'settled', ok: true })
    expect(second.lookup('toolop-6')).toEqual({ operationId: 'toolop-6', state: 'unknown' })
  })

  it('keeps the first settlement when a result is delivered twice', () => {
    const ledger = new ToolReceiptLedger(path)
    ledger.recordDispatch(dispatch('toolop-7'))
    ledger.recordSettled('toolop-7', { ok: true, result: { first: true } })
    ledger.recordSettled('toolop-7', { ok: true, result: { second: true } })
    expect(ledger.lookup('toolop-7')).toMatchObject({ result: { first: true } })
  })

  it('stores only a hash for oversized results', () => {
    const ledger = new ToolReceiptLedger(path)
    ledger.recordDispatch(dispatch('toolop-8'))
    ledger.recordSettled('toolop-8', { ok: true, result: { output: 'x'.repeat(RECEIPT_RESULT_MAX_BYTES + 1) } })
    expect(ledger.lookup('toolop-8')).toMatchObject({ state: 'settled', ok: true, result: { truncated: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } })
  })

  it('refuses to record a dispatch it cannot persist', () => {
    // the ledger path is an existing directory: open(..., 'a') fails, and the caller must not execute
    const asDir = new ToolReceiptLedger(dir)
    expect(() => asDir.recordDispatch(dispatch('toolop-9'))).toThrow()
    expect(asDir.lookup('toolop-9').state).toBe('unknown')
  })
})
