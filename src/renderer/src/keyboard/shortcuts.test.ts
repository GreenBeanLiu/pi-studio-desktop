import { describe, expect, it } from 'vitest'
import { DEFAULT_BINDINGS } from './bindings'
import { comboFromEvent, displayCombo, normalizeCombo } from './normalize'
import { resolveShortcut, type ResolveInput } from './resolve'
import type { ShortcutContext } from './actions'

const IDLE: ShortcutContext = {
  view: 'chat',
  focus: 'other',
  workspace: true,
  agentRunning: false,
  modalOpen: false,
}

function press(combo: Partial<ResolveInput> & { key: string; code?: string }): ResolveInput {
  return {
    key: combo.key,
    code: combo.code ?? '',
    ctrlKey: combo.ctrlKey ?? false,
    metaKey: combo.metaKey ?? false,
    altKey: combo.altKey ?? false,
    shiftKey: combo.shiftKey ?? false,
    repeat: combo.repeat,
    isComposing: combo.isComposing,
  }
}

function actionFor(event: ResolveInput, ctx: ShortcutContext = IDLE): string | null {
  return resolveShortcut(event, ctx, DEFAULT_BINDINGS)?.binding.action ?? null
}

describe('combo normalization', () => {
  it('orders modifiers consistently', () => {
    expect(normalizeCombo('Alt+Mod+t')).toBe('Mod+Alt+T')
  })

  // Shift+1 reports key '!', so digits must come from event.code
  it('reads digits from code, not key', () => {
    expect(comboFromEvent(press({ key: '!', code: 'Digit1', ctrlKey: true }))).toBe('Mod+Digit1')
  })

  it('renders Mod as Ctrl and digits bare', () => {
    expect(displayCombo('Mod+Digit3')).toBe('Ctrl+3')
    expect(displayCombo('Mod+Alt+T')).toBe('Ctrl+Alt+T')
  })
})

describe('view routing', () => {
  it('routes Ctrl+1-5 to the five views', () => {
    const views = ['view.chat', 'view.routines', 'view.imagegen', 'view.model3d', 'view.video']
    views.forEach((action, i) => {
      expect(actionFor(press({ key: String(i + 1), code: `Digit${i + 1}`, ctrlKey: true }))).toBe(
        action,
      )
    })
  })

  it('works from any current view', () => {
    expect(
      actionFor(press({ key: '1', code: 'Digit1', ctrlKey: true }), { ...IDLE, view: 'model3d' }),
    ).toBe('view.chat')
  })
})

describe('editable scope', () => {
  it('still allows modifier shortcuts while typing', () => {
    expect(
      actionFor(press({ key: 'l', ctrlKey: true }), { ...IDLE, focus: 'composer' }),
    ).toBe('composer.focus')
  })

  // F2/Delete/arrows must stay with the input
  it('does not fire bare-key bindings inside an input', () => {
    const bare = [
      { id: 'f2', action: 'session.new' as const, combo: 'F2', help: { section: 't', label: 't' } },
    ]
    expect(resolveShortcut(press({ key: 'F2' }), { ...IDLE, focus: 'editable' }, bare)).toBeNull()
    expect(resolveShortcut(press({ key: 'F2' }), IDLE, bare)?.binding.id).toBe('f2')
  })
})

describe('guards', () => {
  it('does not fire while an IME is composing', () => {
    expect(actionFor(press({ key: 'l', ctrlKey: true, isComposing: true }))).toBeNull()
  })

  it('does not leak through an open modal', () => {
    expect(actionFor(press({ key: 'l', ctrlKey: true }), { ...IDLE, modalOpen: true })).toBeNull()
    expect(
      actionFor(press({ key: 'l', ctrlKey: true }), { ...IDLE, focus: 'command-center' }),
    ).toBeNull()
  })

  it('only stops the agent while it is running', () => {
    expect(actionFor(press({ key: '.', ctrlKey: true }))).toBeNull()
    expect(actionFor(press({ key: '.', ctrlKey: true }), { ...IDLE, agentRunning: true })).toBe(
      'agent.stop',
    )
  })

  it('requires a workspace for a new session', () => {
    expect(actionFor(press({ key: 'n', ctrlKey: true }), { ...IDLE, workspace: false })).toBeNull()
    expect(actionFor(press({ key: 'n', ctrlKey: true }))).toBe('session.new')
  })

  it('scopes the sidebar toggle to the chat view', () => {
    expect(actionFor(press({ key: 'b', ctrlKey: true }))).toBe('sidebar.toggle')
    expect(actionFor(press({ key: 'b', ctrlKey: true }), { ...IDLE, view: 'imagegen' })).toBeNull()
  })

  it('ignores auto-repeat for state-changing actions but not navigation', () => {
    expect(actionFor(press({ key: 'n', ctrlKey: true, repeat: true }))).toBeNull()
    expect(
      actionFor(press({ key: '1', code: 'Digit1', ctrlKey: true, repeat: true })),
    ).toBe('view.chat')
  })

  it('returns null for an unbound combo so native behaviour survives', () => {
    expect(actionFor(press({ key: 'z', ctrlKey: true }))).toBeNull()
    expect(actionFor(press({ key: 'a' }))).toBeNull()
  })

  it('ignores a lone modifier keydown', () => {
    expect(actionFor(press({ key: 'Control', ctrlKey: true }))).toBeNull()
  })
})

describe('registry integrity', () => {
  it('has unique ids and combos', () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.id)
    const combos = DEFAULT_BINDINGS.map((b) => normalizeCombo(b.combo))
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('gives every binding help text for the generated list', () => {
    for (const b of DEFAULT_BINDINGS) {
      expect(b.help.section).toBeTruthy()
      expect(b.help.label).toBeTruthy()
    }
  })
})
