import type { ShortcutBinding } from './actions'

/**
 * 唯一默认 binding registry。快捷键列表和命令中心都从这里生成,
 * 不允许任何地方另写一份按键说明 —— 否则文档和实际行为会漂移。
 *
 * K1 范围:Ctrl+K / Ctrl+O / Ctrl+1-4 / Ctrl+, / Ctrl+L / Ctrl+.
 * 其余(Ctrl+N、Ctrl+B、Ctrl+/、Ctrl+Alt+T)一并登记,便于后续阶段接线。
 */
export const DEFAULT_BINDINGS: ShortcutBinding[] = [
  {
    id: 'command-center',
    action: 'command-center.toggle',
    combo: 'Mod+K',
    help: { section: '全局', label: '打开命令中心' },
  },
  {
    id: 'shortcuts-help',
    action: 'shortcuts.show',
    combo: 'Mod+/',
    help: { section: '全局', label: '快捷键列表' },
  },
  {
    id: 'workspace-open',
    action: 'workspace.open',
    combo: 'Mod+O',
    help: { section: '全局', label: '打开工作区' },
  },
  {
    id: 'session-new',
    action: 'session.new',
    combo: 'Mod+N',
    when: { workspace: true },
    help: { section: '全局', label: '新建会话' },
  },
  {
    id: 'view-chat',
    action: 'view.chat',
    combo: 'Mod+Digit1',
    repeat: true,
    help: { section: '导航', label: '切换到聊天' },
  },
  {
    id: 'view-routines',
    action: 'view.routines',
    combo: 'Mod+Digit2',
    repeat: true,
    help: { section: '导航', label: '切换到例程' },
  },
  {
    id: 'view-imagegen',
    action: 'view.imagegen',
    combo: 'Mod+Digit3',
    repeat: true,
    help: { section: '导航', label: '切换到图像生成' },
  },
  {
    id: 'view-model3d',
    action: 'view.model3d',
    combo: 'Mod+Digit4',
    repeat: true,
    help: { section: '导航', label: '切换到 3D 生成' },
  },
  {
    id: 'sidebar-toggle',
    action: 'sidebar.toggle',
    combo: 'Mod+B',
    when: { view: 'chat' },
    help: { section: '聊天', label: '显示/隐藏会话栏' },
  },
  {
    id: 'settings-toggle',
    action: 'settings.toggle',
    combo: 'Mod+,',
    help: { section: '全局', label: '打开设置' },
  },
  {
    id: 'composer-focus',
    action: 'composer.focus',
    combo: 'Mod+L',
    help: { section: '全局', label: '聚焦输入框' },
  },
  {
    id: 'agent-stop',
    action: 'agent.stop',
    combo: 'Mod+.',
    when: { agentRunning: true },
    help: { section: '聊天', label: '停止当前运行' },
  },
  {
    id: 'theme-toggle',
    action: 'theme.toggle',
    combo: 'Mod+Alt+T',
    help: { section: '全局', label: '切换亮色/暗色' },
  },
]
