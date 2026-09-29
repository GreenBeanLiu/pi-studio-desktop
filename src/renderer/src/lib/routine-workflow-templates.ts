import type { RoutineNotify, RoutineSchedule, RoutineStep } from './api'

export type RoutineWorkflowTemplate = {
  name: string
  input: string
  steps: RoutineStep[]
  workspacePath: string
  scheduleType: RoutineSchedule['type']
  minutes: number
  minute: number
  time: string
  day: number
  notify: RoutineNotify
  pushEachStep: boolean
}

function templateStepId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const MANUAL_WORKFLOW_DEFAULTS = {
  scheduleType: 'manual' as const,
  minutes: 60,
  minute: 0,
  time: '09:00',
  day: 1,
  notify: 'error' as const,
  pushEachStep: false,
}

export function memeWorkflowTemplate(workspacePath: string): RoutineWorkflowTemplate {
  return {
    name: '表情包生成',
    input: '描述主题、情绪、使用场景和必须出现的短文案，例如：加班到深夜，嘴硬但崩溃，用于群聊回复。',
    workspacePath,
    ...MANUAL_WORKFLOW_DEFAULTS,
    steps: [
      {
        id: templateStepId(),
        name: '策划表情包',
        type: 'agent',
        prompt:
          '你是熟悉中文互联网语境的表情包策划。根据需求「{{routine.input}}」设计一张适合聊天发送的表情包。' +
          '先判断情绪和使用场景，再给出唯一方案。严格按以下格式输出：\n' +
          '【上方文案】（没有则写“无”）\n' +
          '【下方文案】（没有则写“无”）\n' +
          '【画面】主体、表情、动作、构图和背景\n' +
          '【风格】视觉风格与配色\n' +
          '文案口语化、有梗、避免解释笑点；每行不超过 10 个汉字，总共不超过 20 个汉字。' +
          '用户已经指定的文案必须原样保留，不要添加 Logo、水印或无关文字。',
      },
      {
        id: templateStepId(),
        name: '确认梗和文案',
        type: 'review',
        message: '请检查表情包的梗、上下文案和画面方案。确认后将调用云端生图。',
      },
      {
        id: templateStepId(),
        name: '生成表情包',
        type: 'imagegen',
        engine: 'openai',
        size: '1024x1024',
        prompt:
          '生成一张 1:1 正方形中文聊天表情包，只生成单张图片，不要九宫格或多格漫画。' +
          '严格执行下面的策划案：人物或动物表情夸张但清晰，主体突出，背景简洁，在手机聊天缩略图中仍容易辨认。' +
          '策划案中标注“无”的文案不要出现在画面；其余中文文案必须逐字准确、醒目易读，不增加任何额外文字。' +
          '不要 Logo、签名、水印、边框或平台标识。\n\n策划案：\n{{steps.策划表情包.output}}',
      },
      {
        id: templateStepId(),
        name: '确认表情包成品',
        type: 'review',
        message: '请检查成品的表情、构图和中文文案是否准确；确认后本次工作流完成。',
      },
    ],
  }
}
