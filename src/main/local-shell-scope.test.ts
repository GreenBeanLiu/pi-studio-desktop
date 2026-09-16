import { describe, expect, it } from 'vitest'
import contract from '../shared/contracts/permissions-v1.json'
import cases from '../shared/contracts/permissions-v1-shell-cases.json'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS_CONTRACT, SHELL_PERMISSIONS, isLocalShellPermission, requiredLocalShellPermission } from './local-shell-scope'

describe('permissions/v1 (mirror of pi-studio-control-plane contracts/permissions-v1.json)', () => {
  it('is the v1 contract and the docs copy is byte-identical to the one the code loads', () => {
    expect(PERMISSIONS_CONTRACT).toBe('permissions/v1')
    const root = join(__dirname, '..', '..')
    for (const name of ['permissions-v1.json', 'permissions-v1-shell-cases.json']) {
      const inSrc = readFileSync(join(root, 'src', 'shared', 'contracts', name))
      const inDocs = readFileSync(join(root, 'docs', 'contracts', name === 'permissions-v1.json' ? name : join('fixtures', name)))
      expect(inSrc.equals(inDocs), `${name} drifted between src/shared/contracts and docs/contracts`).toBe(true)
    }
  })

  it('shell permissions are shell_read plus every capability except task_execution', () => {
    const capabilities = Object.keys(contract.capabilities)
    expect(new Set(SHELL_PERMISSIONS)).toEqual(new Set(['shell_read', ...capabilities.filter((c) => c !== 'task_execution')]))
    for (const permission of SHELL_PERMISSIONS) expect(isLocalShellPermission(permission)).toBe(true)
    expect(isLocalShellPermission('task_execution')).toBe(false)
    expect(isLocalShellPermission('sudo')).toBe(false)
  })

  it.each(cases.cases.map((c) => [c.command, c.permission] as const))(
    'conformance: %j → %s',
    (command, permission) => {
      expect(requiredLocalShellPermission(command)).toBe(permission)
    },
  )

  it('rejects an empty command', () => {
    expect(() => requiredLocalShellPermission(' ')).toThrow('arguments.command is required')
  })
})
