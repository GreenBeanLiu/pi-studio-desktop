import { describe, expect, it } from 'vitest'
import type { PiRuntimeEvent } from './ipc/contract'
import { SERVED_BY_STATUS_KEY, servedByFromStatusEvent } from './served-by'

function status(statusKey: string, statusText: unknown): PiRuntimeEvent {
  return { type: 'extension_ui_request', id: 'id', method: 'setStatus', statusKey, statusText }
}

describe('servedByFromStatusEvent', () => {
  it('turns the extension status into a served_by event', () => {
    expect(
      servedByFromStatusEvent(status(SERVED_BY_STATUS_KEY, JSON.stringify({ profileId: 'deepseek', upstreamModel: 'deepseek-v4-flash' }))),
    ).toEqual({ type: 'served_by', profileId: 'deepseek', upstreamModel: 'deepseek-v4-flash' })
  })

  it('drops an empty upstream model', () => {
    expect(servedByFromStatusEvent(status(SERVED_BY_STATUS_KEY, JSON.stringify({ profileId: 'a', upstreamModel: '' })))).toEqual({
      type: 'served_by',
      profileId: 'a',
    })
  })

  it('ignores other statuses, other events and malformed payloads', () => {
    expect(servedByFromStatusEvent(status('other', JSON.stringify({ profileId: 'a' })))).toBeNull()
    expect(servedByFromStatusEvent(status(SERVED_BY_STATUS_KEY, 'not json'))).toBeNull()
    expect(servedByFromStatusEvent(status(SERVED_BY_STATUS_KEY, JSON.stringify({ profileId: ' ' })))).toBeNull()
    expect(servedByFromStatusEvent(status(SERVED_BY_STATUS_KEY, undefined))).toBeNull()
    expect(servedByFromStatusEvent({ type: 'run_failed', scope: 'prompt', message: 'x' })).toBeNull()
  })
})
