import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// D7:线路管理只在管理台。设置页曾经能增删改线路、刷新/验证模型、写 DeepSeek 官方线路，
// 和网关的登记表各说各的(T3.3 之前 0.18.7/0.18.8 的两个 bug 都出在这)。
const settings = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

describe('settings model routes are read-only', () => {
  it('no longer writes, refreshes or verifies routes', () => {
    for (const call of [
      'api.llmProfiles.save',
      'api.llmProfiles.delete',
      'api.llmProfiles.refreshModels',
      'api.llmProfiles.providerHealth',
      'api.modelCatalog.verifyDiscoveredModels',
    ]) {
      expect(settings).not.toContain(call)
    }
  })

  it('lists routes and model keys and sends edits to the admin console', () => {
    expect(settings).toContain('api.llmProfiles.list()')
    expect(settings).toContain('api.modelCatalog.listModels()')
    expect(settings).toContain('api.settings.openAdminConsole()')
    expect(settings).toContain('去管理台')
  })
})
