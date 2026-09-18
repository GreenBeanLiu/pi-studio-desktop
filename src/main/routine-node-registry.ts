export type RoutineValueSchema<T> = { parse: (value: unknown) => T }

export type RoutineNodePresentation = {
  label: string
  kind: 'source' | 'transform' | 'wait' | 'side-effect' | 'sink'
}

export type RoutineNodeContext = {
  signal: AbortSignal
  waiting: (reason: string) => void
  resumed: (reason: string) => void
}

export type RoutineNodeShape = { input: unknown; output: unknown }

export type RoutineNodeDefinition<K extends string, I, O, C extends RoutineNodeContext> = {
  type: K
  inputSchema: RoutineValueSchema<I>
  outputSchema: RoutineValueSchema<O>
  presentation: RoutineNodePresentation
  execute: (input: I, context: C) => Promise<O> | O
}

type ErasedRoutineNodeDefinition<C extends RoutineNodeContext> = {
  inputSchema: RoutineValueSchema<unknown>
  outputSchema: RoutineValueSchema<unknown>
  presentation: RoutineNodePresentation
  execute: (input: unknown, context: C) => Promise<unknown> | unknown
}

/** Typed routine-node seam: each node owns validation, execution and presentation. */
export class RoutineNodeRegistry<
  M extends { [K in keyof M]: RoutineNodeShape },
  C extends RoutineNodeContext = RoutineNodeContext,
> {
  private readonly definitions = new Map<keyof M & string, ErasedRoutineNodeDefinition<C>>()

  register<T extends keyof M & string>(
    definition: RoutineNodeDefinition<T, M[T]['input'], M[T]['output'], C>,
  ): this {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Routine node is already registered: ${definition.type}`)
    }
    this.definitions.set(definition.type, {
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      presentation: definition.presentation,
      execute: (input, context) => definition.execute(input as M[T]['input'], context),
    })
    return this
  }

  execute<T extends keyof M & string>(type: T, input: M[T]['input'], context: C): Promise<M[T]['output']> {
    const definition = this.definitions.get(type)
    if (!definition) return Promise.reject(new Error(`Unsupported workflow node: ${type}`))
    try {
      const parsedInput = definition.inputSchema.parse(input)
      return Promise.resolve(definition.execute(parsedInput, context)).then(
        (output) => definition.outputSchema.parse(output),
      ) as Promise<M[T]['output']>
    } catch (error) {
      return Promise.reject(error)
    }
  }

  list(): Array<{ type: keyof M & string; presentation: RoutineNodePresentation }> {
    return [...this.definitions].map(([type, definition]) => ({
      type,
      presentation: definition.presentation,
    }))
  }

  types(): Array<keyof M & string> {
    return [...this.definitions.keys()]
  }
}

export type WorkflowValueSchema<T> = RoutineValueSchema<T>
export type WorkflowNodePresentation = RoutineNodePresentation
export type WorkflowNodeContext = RoutineNodeContext
export type WorkflowNodeShape = RoutineNodeShape
export type WorkflowNodeDefinition<K extends string, I, O, C extends RoutineNodeContext> = RoutineNodeDefinition<K, I, O, C>
export const WorkflowNodeRegistry = RoutineNodeRegistry
