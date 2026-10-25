import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_EXTENSION_SOURCE } from './agent-status-extension-sync'
import { servedByFromStatusEvent } from '../shared/served-by'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

type Handler = (event: unknown, ctx: unknown) => unknown

/** 把扩展源码真的跑起来:转成 CommonJS,依赖换成桩，收集它注册的事件处理器。 */
function loadExtension(): Map<string, Handler[]> {
  const js = ts.transpileModule(AGENT_STATUS_EXTENSION_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const anything: unknown = new Proxy(() => anything, { get: () => anything, apply: () => anything })
  const fakeRequire = (name: string): unknown => (name === 'typebox' ? { Type: anything } : {})
  const module = { exports: {} as { default?: (pi: unknown) => void } }
  new Function('require', 'module', 'exports', js)(fakeRequire, module, module.exports)
  const handlers = new Map<string, Handler[]>()
  module.exports.default?.({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: () => {},
  })
  return handlers
}

/** 跑一次 after_provider_response,返回扩展发出的 setStatus,按 rpc 模式的形状包成事件。 */
function fireProviderResponse(headers: Record<string, string>): PiRuntimeEvent[] {
  const emitted: PiRuntimeEvent[] = []
  const ctx = {
    ui: {
      setStatus: (statusKey: string, statusText: string | undefined) =>
        emitted.push({ type: 'extension_ui_request', id: 'x', method: 'setStatus', statusKey, statusText }),
    },
  }
  for (const handler of loadExtension().get('after_provider_response') ?? []) {
    handler({ type: 'after_provider_response', status: 200, headers }, ctx)
  }
  return emitted
}

describe('pi-studio agent status extension source', () => {
  it('is valid TypeScript after being generated', () => {
    const result = ts.transpileModule(AGENT_STATUS_EXTENSION_SOURCE, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
    expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('registers a workspace-scoped artifact reader that accepts IDs rather than paths', () => {
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("name: 'read_agent_artifact'")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('artifact_id: Type.String')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('PI_STUDIO_ARTIFACT_WORKSPACE_KEY')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("throw new Error('Artifact integrity check failed')")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("'\\nUse read_agent_artifact with this id")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('max_chars: Type.Optional')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('maximum: 12000')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('next_offset_chars')
    expect(AGENT_STATUS_EXTENSION_SOURCE).not.toContain('file_path: Type.String')
  })

  it('does not artifactize the artifact reader result again', () => {
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain(
      "if (event.toolName === 'read_agent_artifact') return undefined",
    )
  })

  it('reports which gateway route served the response', () => {
    const emitted = fireProviderResponse({
      'content-type': 'text/event-stream',
      'x-pi-served-by': 'heilovehei',
      'x-pi-upstream-model': 'gpt-6-sol-2026',
    })
    expect(emitted).toHaveLength(1)
    expect(servedByFromStatusEvent(emitted[0]!)).toEqual({
      type: 'served_by',
      profileId: 'heilovehei',
      upstreamModel: 'gpt-6-sol-2026',
    })
  })

  it('reads the headers case-insensitively', () => {
    const emitted = fireProviderResponse({ 'X-Pi-Served-By': 'deepseek' })
    expect(servedByFromStatusEvent(emitted[0]!)).toEqual({ type: 'served_by', profileId: 'deepseek' })
  })

  it('stays silent without the header so the last known route is kept', () => {
    expect(fireProviderResponse({ 'content-type': 'application/json' })).toEqual([])
  })
})
