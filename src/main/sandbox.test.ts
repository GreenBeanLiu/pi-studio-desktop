import { describe, expect, it } from 'vitest'
import {
  buildSandboxDockerArgs,
  sandboxAgentPath,
  sandboxRpcShimSource,
  sandboxSessionPathToContainer,
  sandboxSessionPathToHost,
} from './sandbox'

describe('buildSandboxDockerArgs', () => {
  const base = {
    image: 'pi-studio-sandbox:0.79.10',
    hostWorkspace: 'D:\\Works\\proj',
    hostAgentDir: 'C:\\Users\\me\\AppData\\Roaming\\pi-studio\\pi-agent',
  }

  it('mounts workspace at /workspace and agent dir at /agent, ending with the image', () => {
    const args = buildSandboxDockerArgs({ ...base, envNames: [] })
    expect(args.slice(0, 3)).toEqual(['run', '-i', '--rm'])
    expect(args).toContain('/workspace')
    expect(args).toEqual(expect.arrayContaining(['-v', 'D:\\Works\\proj:/workspace']))
    expect(args).toEqual(expect.arrayContaining(['-v', `${base.hostAgentDir}:/agent`]))
    expect(args).toEqual(expect.arrayContaining(['-e', 'PI_CODING_AGENT_DIR=/agent']))
    expect(args[args.length - 1]).toBe(base.image) // image is the last token; shim appends `pi <argv>`
    expect(args).toEqual(expect.arrayContaining(['-w', '/workspace']))
  })

  it('passes through named env vars with -e NAME (value inherited by the shim)', () => {
    const args = buildSandboxDockerArgs({ ...base, envNames: ['OPENAI_API_KEY', 'TAVILY_API_KEY'] })
    expect(args).toEqual(expect.arrayContaining(['-e', 'OPENAI_API_KEY']))
    expect(args).toEqual(expect.arrayContaining(['-e', 'TAVILY_API_KEY']))
  })

  it('never passes host PI_CODING_AGENT_DIR through (it is forced to /agent) nor the internal marker', () => {
    const args = buildSandboxDockerArgs({
      ...base,
      envNames: ['PI_CODING_AGENT_DIR', 'PISTUDIO_DOCKER_ARGS', 'ANTHROPIC_API_KEY'],
    })
    // -e PI_CODING_AGENT_DIR appears exactly once, and it is the =/agent override form
    const eFlags = args.filter((_, i) => args[i - 1] === '-e')
    expect(eFlags.filter((v) => v.startsWith('PI_CODING_AGENT_DIR'))).toEqual(['PI_CODING_AGENT_DIR=/agent'])
    expect(eFlags).not.toContain('PISTUDIO_DOCKER_ARGS')
    expect(eFlags).toContain('ANTHROPIC_API_KEY')
  })

  it('deduplicates forwarded environment names', () => {
    const args = buildSandboxDockerArgs({ ...base, envNames: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] })
    const eFlags = args.filter((_, i) => args[i - 1] === '-e')
    expect(eFlags.filter((v) => v === 'OPENAI_API_KEY')).toHaveLength(1)
  })

  it('mounts the workspace read-only when requested', () => {
    const args = buildSandboxDockerArgs({ ...base, envNames: [], workspaceReadOnly: true })
    expect(args).toEqual(expect.arrayContaining(['-v', `${base.hostWorkspace}:/workspace:ro`]))
  })
})

describe('sandbox RPC shim', () => {
  it('hides the long-running docker console window on Windows', () => {
    expect(sandboxRpcShimSource()).toMatch(
      /spawn\('docker',[\s\S]*windowsHide:\s*true/,
    )
  })
})

describe('sandbox session path mapping', () => {
  const hostAgentDir = 'C:\\Users\\me\\AppData\\Roaming\\pi-studio\\pi-agent'

  it('maps container session paths back to the host mount', () => {
    expect(
      sandboxSessionPathToHost('/agent/sessions/workspace/session.jsonl', hostAgentDir),
    ).toBe(`${hostAgentDir}\\sessions\\workspace\\session.jsonl`)
    expect(sandboxSessionPathToHost('C:\\other\\session.jsonl', hostAgentDir)).toBe(
      'C:\\other\\session.jsonl',
    )
  })

  it('maps host paths selected by the session sidebar into /agent', () => {
    expect(
      sandboxSessionPathToContainer(
        `${hostAgentDir}\\sessions\\workspace\\session.jsonl`,
        hostAgentDir,
      ),
    ).toBe('/agent/sessions/workspace/session.jsonl')
    expect(sandboxSessionPathToContainer('C:\\other\\session.jsonl', hostAgentDir)).toBe(
      'C:\\other\\session.jsonl',
    )
  })

  it('maps explicit app extension paths into the Docker agent mount', () => {
    expect(
      sandboxAgentPath(
        `${hostAgentDir}\\pi-studio-reviewed-extensions\\web-search.ts`,
        'docker',
        hostAgentDir,
      ),
    ).toBe('/agent/pi-studio-reviewed-extensions/web-search.ts')
  })
})
