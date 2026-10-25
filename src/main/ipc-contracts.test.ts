import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ipcSource = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')

describe('backup restore IPC contract', () => {
  it('registers both handlers and validates the backup name centrally', () => {
    expect(ipcSource).toContain("ipcMain.handle('diagnostics:listBackups'")
    expect(ipcSource).toContain("ipcMain.handle('diagnostics:restoreBackup'")
    expect(ipcSource).toContain("requiredString(payload.name, '备份名称')")
  })
})

describe('route management IPC is gone (T3.4, D7)', () => {
  it('registers no route write, refresh, health or verification handlers', () => {
    for (const channel of [
      'llmProfiles:save',
      'llmProfiles:delete',
      'llmProfiles:refreshModels',
      'llmProfiles:providerHealth',
      'modelCatalog:verifyDiscoveredModels',
    ]) {
      expect(ipcSource).not.toContain(`ipcMain.handle('${channel}'`)
    }
    expect(ipcSource).toContain("ipcMain.handle('llmProfiles:list'")
  })
})
