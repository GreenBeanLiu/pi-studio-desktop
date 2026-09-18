import { describe, expect, it } from 'vitest'
import { RoutineNodeRegistry } from './routine-node-registry'

const context = {
  signal: new AbortController().signal,
  waiting: () => {},
  resumed: () => {},
}
const stringSchema = { parse: (value: unknown): string => String(value) }
type TestNodes = {
  text: { input: string; output: string }
  count: { input: string; output: string }
  missing: { input: string; output: string }
}

describe('RoutineNodeRegistry', () => {
  it('dispatches nodes without a central type switch', async () => {
    const registry = new RoutineNodeRegistry<TestNodes>()
      .register({
        type: 'text',
        inputSchema: stringSchema,
        outputSchema: stringSchema,
        presentation: { label: 'Text', kind: 'transform' },
        execute: (input) => input.toUpperCase(),
      })
      .register({
        type: 'count',
        inputSchema: stringSchema,
        outputSchema: stringSchema,
        presentation: { label: 'Count', kind: 'transform' },
        execute: async (input) => String(input.length),
      })

    await expect(registry.execute('text', 'hello', context)).resolves.toBe('HELLO')
    await expect(registry.execute('count', 'hello', context)).resolves.toBe('5')
    expect(registry.types()).toEqual(['text', 'count'])
    expect(registry.list().map((definition) => definition.presentation.label)).toEqual(['Text', 'Count'])
  })

  it('rejects duplicate and unknown node definitions', async () => {
    const definition = {
      type: 'text' as const,
      inputSchema: stringSchema,
      outputSchema: stringSchema,
      presentation: { label: 'Text', kind: 'transform' as const },
      execute: (input: string) => input,
    }
    const registry = new RoutineNodeRegistry<TestNodes>().register(definition)
    expect(() => registry.register(definition)).toThrow('already registered')
    await expect(registry.execute('missing', 'hello', context)).rejects.toThrow('Unsupported workflow node')
  })

  it('validates values at the node boundary', async () => {
    const schema = { parse: (value: unknown) => String(value).trim() }
    const registry = new RoutineNodeRegistry<{ text: { input: string; output: string } }>().register({
      type: 'text',
      inputSchema: schema,
      outputSchema: schema,
      presentation: { label: 'Text', kind: 'transform' },
      execute: (input) => ` ${input.toUpperCase()} `,
    })

    await expect(registry.execute('text', ' hi ', context)).resolves.toBe('HI')
  })
})
