import type { RoutineStep, RoutineStepType } from './api'

export type RoutineNodePreset = {
  id: string
  category: 'input' | 'article' | 'media' | 'output' | 'generic'
  label: string
  description: string
  step: Omit<RoutineStep, 'id'>
}

const articlePrompt = {
  research:
    '围绕 {{routine.input}} 检索并整理 5-8 条可靠资料。列出关键事实、来源链接、争议点和不能确认的内容，不要开始写文章。',
  outline:
    '基于上一步资料，为 {{routine.input}} 设计公众号文章大纲：标题候选 5 个、摘要、开头钩子、3-5 个小节、结尾 CTA。保留来源对应关系。',
  draft:
    '根据资料和大纲写一篇适合微信公众号的中文初稿。要求：事实可追溯、段落短、标题清晰、避免营销夸大，正文约 1800-2500 字，包含标题、摘要和正文。',
  review:
    '审校上一步公众号初稿，逐条检查事实、来源、广告法风险、绝对化表述、错别字和标题党问题。先列问题，再给出可直接替换的修订稿。',
}

export const ROUTINE_NODE_PRESETS: RoutineNodePreset[] = [
  {
    id: 'input.material-folder',
    category: 'input',
    label: '读取素材文件夹',
    description: '读取工作区内的文档和图片，供后续写作与发布使用',
    step: { name: '本地素材', type: 'folder-input', path: '' },
  },
  {
    id: 'article.research',
    category: 'article',
    label: '资料与事实',
    description: '检索资料、来源、争议点',
    step: { name: '资料与事实', type: 'agent', prompt: articlePrompt.research },
  },
  {
    id: 'article.outline',
    category: 'article',
    label: '文章大纲',
    description: '标题、摘要、结构和 CTA',
    step: { name: '文章大纲', type: 'agent', prompt: articlePrompt.outline },
  },
  {
    id: 'article.draft',
    category: 'article',
    label: '公众号初稿',
    description: '生成适合手机阅读的正文',
    step: { name: '公众号初稿', type: 'agent', prompt: articlePrompt.draft },
  },
  {
    id: 'article.review',
    category: 'article',
    label: '事实与合规审校',
    description: '检查事实、广告法和错别字',
    step: { name: '事实与合规审校', type: 'agent', prompt: articlePrompt.review },
  },
  {
    id: 'article.approval',
    category: 'article',
    label: '人工审核',
    description: '暂停流程，确认后继续',
    step: {
      name: '人工审核',
      type: 'review',
      message: '请检查上一步生成的公众号草稿，确认后继续。',
    },
  },
  {
    id: 'media.cover',
    category: 'media',
    label: '公众号封面图',
    description: '根据文章内容生成封面图',
    step: {
      name: '公众号封面图',
      type: 'imagegen',
      engine: 'openai',
      size: '1536x1024',
      prompt:
        '为这篇微信公众号文章生成一张横版封面图（16:9），画面简洁有吸引力、贴合主题，不要文字和 Logo。\n\n文章正文：{{steps.公众号初稿.output}}',
    },
  },
  {
    id: 'media.image-to-3d',
    category: 'media',
    label: '图生 3D 模型',
    description: '把上一步生成的图片重建成 3D 模型(glb),存进工作区',
    step: { name: '图生 3D', type: 'model3d', imageRef: '{{prev.imageUrl}}', provider: 'tripo' },
  },
  {
    id: 'media.app-icon-master',
    category: 'media',
    label: '应用图标母图',
    description: '生成适合四端适配的 1024×1024 透明母图',
    step: {
      name: '应用图标母图',
      type: 'imagegen',
      engine: 'openai',
      size: '1024x1024',
      prompt:
        '为「{{routine.input}}」设计应用图标母图。1024×1024 正方形 PNG，透明背景，主体居中，四周保留约 20% 安全边距；符号简洁、轮廓清晰、在 16px 仍可辨认。不要预先添加圆角、外框、投影、文字、水印或设备模型。',
    },
  },
  {
    id: 'output.wechat-html',
    category: 'output',
    label: '导出公众号 HTML',
    description: '把上一步 Markdown 转成公众号 HTML',
    step: {
      name: '保存公众号草稿',
      type: 'export',
      path: '.pi-studio/articles/wechat-draft',
      format: 'html',
    },
  },
  {
    id: 'output.markdown',
    category: 'output',
    label: '导出 Markdown',
    description: '保存为工作区内的 Markdown 文件',
    step: {
      name: '保存 Markdown 草稿',
      type: 'export',
      path: '.pi-studio/articles/article-draft',
      format: 'markdown',
    },
  },
  {
    id: 'output.feishu-doc',
    category: 'output',
    label: '存飞书文档',
    description: '把正文存成飞书云文档',
    step: {
      name: '存飞书文档',
      type: 'feishu-doc',
      message: '{{prev.output}}',
      path: '{{routine.name}} · {{trigger.time}}',
    },
  },
  {
    id: 'output.wechat-draft',
    category: 'output',
    label: '微信公众号草稿',
    description: '上传图片并创建微信公众号草稿（不自动群发）',
    step: {
      name: '微信公众号草稿',
      type: 'wechat-draft',
      message: '{{prev.output}}',
      path: '{{routine.input}} · {{trigger.time}}',
    },
  },
  {
    id: 'output.notify',
    category: 'output',
    label: '发送预览提醒',
    description: '把产物路径发送到通知渠道',
    step: {
      name: '发送预览提醒',
      type: 'notify',
      message: '草稿已生成：{{prev.output}}\n请人工确认后再发布。',
    },
  },
  {
    id: 'output.app-icon-bundle',
    category: 'output',
    label: '导出应用图标包',
    description: '一次导出 Android、iOS、macOS 和 Windows 工程资源',
    step: {
      name: '导出应用图标包',
      type: 'app-icon',
      imageRef: '{{prev.imageUrl}}',
      appName: '',
      path: '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}',
      backgroundColor: '',
      platforms: ['android', 'ios', 'macos', 'windows'],
    },
  },
  {
    id: 'generic.agent',
    category: 'generic',
    label: '通用智能体',
    description: '自定义提示词的 Agent 节点',
    step: { name: '智能体', type: 'agent', prompt: '' },
  },
  {
    id: 'generic.imagegen',
    category: 'generic',
    label: '通用生图',
    description: '自定义提示词的生图节点',
    step: { name: '生图', type: 'imagegen', engine: 'openai', prompt: '' },
  },
  {
    id: 'generic.model3d',
    category: 'generic',
    label: '通用 3D 生成',
    description: '上游图片或文字 → 3D 模型(glb)',
    step: { name: '3D 模型', type: 'model3d', prompt: '', imageRef: '{{prev.imageUrl}}', provider: 'tripo' },
  },
  {
    id: 'generic.export',
    category: 'generic',
    label: '通用导出',
    description: '把上一步内容写到工作区',
    step: { name: '导出文件', type: 'export', path: '.pi-studio/articles/article-draft', format: 'markdown' },
  },
  {
    id: 'generic.notify',
    category: 'generic',
    label: '通用通知',
    description: '把上一步输出发送到渠道',
    step: { name: '通知', type: 'notify', message: '{{prev.output}}' },
  },
]

export function createRoutineStepFromPreset(presetId: string, channelId?: string): RoutineStep | null {
  const preset = ROUTINE_NODE_PRESETS.find((item) => item.id === presetId)
  if (!preset) return null
  return {
    ...preset.step,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...(preset.step.type === 'notify' && channelId ? { channelId } : {}),
  }
}

export function routineNodePresetOptions(): Array<{
  key: string
  label: string
  description: string
  stepType: RoutineStepType
}> {
  return ROUTINE_NODE_PRESETS.map((preset) => ({
    key: preset.id,
    label: preset.label,
    description: preset.description,
    stepType: preset.step.type,
  }))
}
