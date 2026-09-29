/**
 * 快捷键动作标识(见 优化.md「快捷键设计」)。
 *
 * action id 与 binding id 一旦发布就保持稳定:将来支持用户改键时,
 * 用户配置以 id 为键,默认组合调整也不会丢失用户覆盖。
 */
export type ShortcutActionId =
  | 'command-center.toggle'
  | 'shortcuts.show'
  | 'workspace.open'
  | 'session.new'
  | 'view.chat'
  | 'view.routines'
  | 'view.imagegen'
  | 'view.model3d'
  | 'sidebar.toggle'
  | 'settings.toggle'
  | 'composer.focus'
  | 'agent.stop'
  | 'theme.toggle'

/** 焦点所在的作用域;决定一条 binding 是否该让位给当前控件。 */
export type FocusScope =
  | 'modal'
  | 'command-center'
  | 'composer'
  | 'editable'
  | 'session-list'
  | 'other'

export type ShortcutView = 'chat' | 'routines' | 'imagegen' | 'model3d'

export type ShortcutContext = {
  view: ShortcutView
  focus: FocusScope
  /** 是否已打开工作区 */
  workspace: boolean
  /** agent 是否正在运行(来自 A3 的权威快照) */
  agentRunning: boolean
  /** 任意 Modal 是否打开 */
  modalOpen: boolean
}

export type ShortcutBinding = {
  id: string
  action: ShortcutActionId
  combo: string
  when?: {
    view?: ShortcutView
    focus?: FocusScope
    workspace?: boolean
    agentRunning?: boolean
  }
  /** 默认忽略长按重复;只有纯导航类才允许 */
  repeat?: boolean
  help: { section: string; label: string }
}
