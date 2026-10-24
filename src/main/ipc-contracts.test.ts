import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLlmProfileId, parseLlmProfileSavePayload } from './ipc-contracts'

const ipcSource = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')

const profile = {
  id: 'three-a-main',
  display_name: '3A Main',
  base_url: 'https://api.3a-api.com/v1',
  api_type: 'openai-completions',
  api_key: 'secret',
  models: ['gpt-5.5'],
  enabled: true,
  sort_order: 0,
}

describe('llm profile IPC contract', () => {
  it('accepts only a valid provider id for model verification', () => {
    expect(parseLlmProfileId('three-a-main')).toBe('three-a-main')
    expect(() => parseLlmProfileId('../bad')).toThrow('线路 ID')
  })

  it('requires a key when creating a profile', () => {
    expect(() =>
      parseLlmProfileSavePayload({ create: true, profile: { ...profile, api_key: '' } }),
    ).toThrow('API Key')
  })

  it('allows an empty key when updating a profile', () => {
    expect(
      parseLlmProfileSavePayload({ create: false, profile: { ...profile, api_key: '' } }),
    ).toEqual({ create: false, profile: { ...profile, api_key: '' } })
  })

  it.each([
    { ...profile, id: '../bad' },
    { ...profile, base_url: 'not-a-url' },
    { ...profile, api_type: 'anthropic' },
    { ...profile, models: ['ok', 3] },
    { ...profile, enabled: 'yes' },
  ])('rejects malformed renderer input', (invalidProfile) => {
    expect(() =>
      parseLlmProfileSavePayload({ create: false, profile: invalidProfile }),
    ).toThrow()
  })
})

describe('backup restore IPC contract', () => {
  it('registers both handlers and validates the backup name centrally', () => {
    expect(ipcSource).toContain("ipcMain.handle('diagnostics:listBackups'")
    expect(ipcSource).toContain("ipcMain.handle('diagnostics:restoreBackup'")
    expect(ipcSource).toContain("requiredString(payload.name, '备份名称')")
  })
})

describe('provider health IPC contract', () => {
  it('registers the provider health handler', () => {
    expect(ipcSource).toContain("ipcMain.handle('llmProfiles:providerHealth'")
  })
})

describe('model verification IPC contract', () => {
  it('registers the validated discovery handler', () => {
    expect(ipcSource).toContain("ipcMain.handle('modelCatalog:verifyDiscoveredModels'")
  })
})
