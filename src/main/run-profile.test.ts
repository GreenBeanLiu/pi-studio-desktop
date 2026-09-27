import { describe, expect, it, vi } from 'vitest'
import { RunProfileCompiler } from './run-profile'

describe('RunProfileCompiler', () => {
  it('reports an unsandboxed chat as unrestricted host execution', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: false, subagentsEnabled: true }),
      prepareRuntime: async () => ({
        provider: 'openai',
        model: 'gpt-test',
        env: { OPENAI_API_KEY: 'secret' },
        gatewayProfiles: [],
      }),
      prepareSandbox: async () => {
        throw new Error('sandbox should not be prepared')
      },
      resolveCliPath: () => 'C:\\pi\\cli.js',
    })

    const profile = await compiler.compile('chat', 'D:\\repo')

    expect(profile.security).toEqual({
      requested: 'full-access',
      filesystemMode: 'danger-full-access',
      networkMode: 'unrestricted',
      backend: 'host',
      enforcement: 'none',
      hostCodeExecution: false,
      reason: 'Sandbox is disabled; Pi runs with the desktop user permissions.',
    })
    expect(profile.declaredCapabilities).toEqual({ subagents: true })
  })

  it('reports WSL confinement and host-side generated-code execution separately', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: true }),
      prepareRuntime: async () => ({
        provider: 'openai',
        model: 'gpt-test',
        env: { OPENAI_API_KEY: 'secret' },
        gatewayProfiles: [],
      }),
      prepareSandbox: async (_cwd, env) => ({
        cliPath: 'C:\\sandbox-shim.cjs',
        env: { ...env, PISTUDIO_WSL_ARGS: '[]' },
        mode: 'wsl',
      }),
      resolveCliPath: () => {
        throw new Error('host CLI should not be resolved')
      },
    })

    const profile = await compiler.compile('code-model', 'D:\\model-work')

    expect(profile.security).toEqual({
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'allowlist',
      backend: 'wsl-bwrap',
      enforcement: 'partial',
      hostCodeExecution: true,
      reason:
        'Pi is confined by WSL bubblewrap and the outbound allowlist; generated code is still executed by the host.',
    })
  })

  it('does not claim that the Docker fallback enforces the network allowlist', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: true }),
      prepareRuntime: async () => ({
        provider: 'openai',
        env: {},
        gatewayProfiles: [],
      }),
      prepareSandbox: async () => ({
        cliPath: 'C:\\docker-shim.cjs',
        env: { PISTUDIO_DOCKER_ARGS: '[]' },
        mode: 'docker',
      }),
      resolveCliPath: () => 'unused',
    })

    const profile = await compiler.compile('routine', 'D:\\repo')

    expect(profile.security).toEqual({
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'unrestricted',
      backend: 'docker',
      enforcement: 'partial',
      hostCodeExecution: false,
      reason: 'Pi filesystem access is confined by Docker; outbound network access is unrestricted.',
    })
  })

  it('reports macOS Seatbelt confinement with the allowlist proxy', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: true }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox: async () => ({ cliPath: '/shim.cjs', env: {}, mode: 'seatbelt' }),
      resolveCliPath: () => 'unused',
    })

    const profile = await compiler.compile('chat', '/Users/me/repo')

    expect(profile.security).toEqual({
      requested: 'confined',
      filesystemMode: 'workspace-write',
      networkMode: 'allowlist',
      backend: 'macos-seatbelt',
      enforcement: 'full',
      hostCodeExecution: false,
      reason: 'Pi filesystem writes and outbound network are confined by the macOS Seatbelt sandbox.',
    })
  })

  it('drops write tools and marks the workspace read-only for read-only routines', async () => {
    const prepareSandbox = vi.fn(async () => ({ cliPath: '/shim.cjs', env: {}, mode: 'wsl' as const }))
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: true }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox,
      resolveCliPath: () => 'unused',
    })

    const profile = await compiler.compile('routine', 'D:\\repo', { workspaceReadOnly: true })

    expect(profile.args).toEqual([
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--tools',
      'read,grep,find,ls,web_search',
    ])
    expect(prepareSandbox).toHaveBeenCalledWith('D:\\repo', {}, { workspaceReadOnly: true })
    expect(profile.security.filesystemMode).toBe('workspace-read-only')
    expect(profile.security.reason).toContain('read-only')
  })

  it('keeps the host posture honest for a read-only routine without a sandbox', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: false }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox: async () => {
        throw new Error('unused')
      },
      resolveCliPath: () => 'C:\\pi\\cli.js',
    })

    const profile = await compiler.compile('routine', 'D:\\repo', { workspaceReadOnly: true })

    expect(profile.args).toContain('read,grep,find,ls,web_search')
    expect(profile.security.filesystemMode).toBe('danger-full-access')
    expect(profile.security.reason).toContain('read-only tools')
  })

  it('compiles model builders with the minimum Pi capability set', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: false }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox: async () => {
        throw new Error('unused')
      },
      resolveCliPath: () => 'C:\\pi\\cli.js',
    })

    const profile = await compiler.compile('blender-model', 'D:\\model-work')

    expect(profile.args).toEqual([
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--tools',
      'read,edit,write',
    ])
  })

  it('compiles unattended routines from explicit reviewed capabilities only', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: false }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox: async () => {
        throw new Error('unused')
      },
      resolveCliPath: () => 'C:\\pi\\cli.js',
    })

    const profile = await compiler.compile('routine', 'D:\\repo', {
      extensions: ['C:\\pi-studio\\workspace-memory.ts', 'C:\\pi-studio\\web-search.ts'],
    })

    expect(profile.args).toEqual([
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--extension',
      'C:\\pi-studio\\workspace-memory.ts',
      '--extension',
      'C:\\pi-studio\\web-search.ts',
      '--tools',
      'read,edit,write,grep,find,ls,web_search',
    ])
  })

  it('maps explicit routine extensions into the WSL sandbox filesystem', async () => {
    const compiler = new RunProfileCompiler({
      loadSettings: () => ({ sandboxEnabled: true }),
      prepareRuntime: async () => ({ provider: 'openai', env: {}, gatewayProfiles: [] }),
      prepareSandbox: async () => ({ cliPath: 'C:\\shim.cjs', env: {}, mode: 'wsl' }),
      resolveCliPath: () => 'unused',
    })

    const profile = await compiler.compile('routine', 'D:\\repo', {
      extensions: ['C:\\Users\\me\\pi-agent\\extensions\\workspace-memory.ts'],
    })

    expect(profile.args).toContain(
      '/mnt/c/Users/me/pi-agent/extensions/workspace-memory.ts',
    )
  })

  it('fingerprints capability configuration without hashing secret values', async () => {
    const compilerFor = (apiKey: string) =>
      new RunProfileCompiler({
        loadSettings: () => ({ sandboxEnabled: false }),
        prepareRuntime: async () => ({
          provider: 'openai',
          model: 'gpt-test',
          env: { OPENAI_API_KEY: apiKey },
          gatewayProfiles: [],
        }),
        prepareSandbox: async () => {
          throw new Error('unused')
        },
        resolveCliPath: () => 'C:\\pi\\cli.js',
      })

    const first = await compilerFor('first-secret').compile('chat', 'D:\\repo')
    const second = await compilerFor('second-secret').compile('chat', 'D:\\repo')

    expect(first.profileDigest).toBe(second.profileDigest)
    expect(first.profileDigest).not.toContain('secret')
  })
})
