/**
 * 「可用模型」文本框和 profile.models 之间的转换。
 *
 * 编辑时文本框持有的是原始文本,不是解析后的数组:受控输入如果每次 onChange 都
 * split → filter(Boolean) → join 回去,刚敲下的换行/逗号会被当成空段落立刻抹掉,
 * 光标永远换不了行,第二个模型根本打不进去。只在保存那一刻才解析。
 */
export function parseLlmProfileModels(text: string): string[] {
  const models: string[] = []
  for (const raw of text.split(/[,，\n]/)) {
    const model = raw.trim()
    if (model && !models.includes(model)) models.push(model)
  }
  return models
}

export function formatLlmProfileModels(models: readonly string[]): string {
  return models.join('\n')
}
