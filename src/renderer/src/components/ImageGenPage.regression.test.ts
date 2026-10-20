import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./ImageGenPage.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('./ImageGenerationWorkspace.tsx', import.meta.url), 'utf8')
const selector = readFileSync(new URL('./ImageModelSelector.tsx', import.meta.url), 'utf8')
const output = readFileSync(new URL('./ImageOutputSection.tsx', import.meta.url), 'utf8')
const historyRow = readFileSync(new URL('./ImageHistoryBatchRow.tsx', import.meta.url), 'utf8')
const mainImageGen = readFileSync(new URL('../../../main/image-gen.ts', import.meta.url), 'utf8')
const input = readFileSync(new URL('./ImageInputSection.tsx', import.meta.url), 'utf8')
const models = readFileSync(new URL('./image-generation-models.ts', import.meta.url), 'utf8')

describe('Image generation workspace regressions', () => {
  it('uses the modular workspace instead of the legacy tab page', () => {
    expect(page).toContain('<ImageGenerationWorkspace MaskEditorComponent={ImageMaskEditor} />')
    expect(workspace).toContain('<ImageModelSelector')
    expect(workspace).toContain('<ImageInputSection')
    expect(workspace).toContain('<ImageOutputSection')
  })

  it('selects growing model catalogs from one grouped dropdown', () => {
    expect(selector).toContain('<Select')
    expect(selector).toContain('IMAGE_MODELS.filter')
    expect(selector).not.toContain('<Tabs')
  })

  it('offers model-specific output parameters and one to four images', () => {
    expect(output).toContain("model.parameters === 'gpt'")
    expect(output).not.toContain("model.parameters === 'gemini'") // Gemini 2026-10-20 下线
    expect(output).toContain("model.parameters === 'grok'")
    expect(output).toContain('[1, 2, 3, 4]')
    expect(output).toContain('hasMask && count !== 1')
  })

  it('submits and renders one generation batch', () => {
    expect(workspace).toContain('const batchId = crypto.randomUUID()')
    expect(workspace).toContain('groupImageGenerationHistory')
    expect(workspace).toContain('historyDeleteBatch')
    expect(historyRow).toContain('grid-template-columns: repeat(auto-fill, minmax(180px, 220px))')
    expect(historyRow).toContain('text-overflow: ellipsis')
    expect(historyRow).toContain('position: absolute')
    expect(mainImageGen).toContain('return { ...resolved, urls }')
    expect(workspace).toContain('result.urls?.length ? result.urls')
  })

  it('previews images directly and only reveals actions on hover', () => {
    expect(historyRow).toContain('onClick={() => onPreview(image.url)}')
    expect(historyRow).not.toContain('<Checkbox')
    expect(historyRow).not.toContain('styles.badge')
    expect(historyRow).toContain('&:hover .image-actions')
    expect(historyRow).toContain('opacity: 0')
    expect(workspace).toContain('<img src={preview} alt="预览" />')
    expect(workspace).not.toContain('selectedByBatch')
  })

  it('picks a style template instead of the old one-line example prompts', () => {
    // 五条示例短句已被 22 个风格模板取代,别退回去
    expect(input).not.toContain('EXAMPLE_PROMPTS')
    expect(input).toContain('风格模板')
    expect(input).toContain('filterImageStyleTemplates(templateQuery, templateCategory)')
    expect(input).toContain('IMAGE_STYLE_CATEGORIES.map')
    expect(input).toContain('onApplyTemplate(template)')
  })

  it('applies the template canvas to whichever field the current engine reads', () => {
    // gpt 吃 size、grok 吃比例,点一个模板两者都要落到位(gemini 2026-10-20 下线)
    expect(workspace).toContain('function applyStyleTemplate(template: ImageStyleTemplate)')
    expect(workspace).toContain('const ratio = templateAspectRatio(template.size)')
    expect(workspace).toContain('size: template.size,')
    expect(workspace).toContain('grokAspectRatio: ratio,')
    // 提示词上限挪进 lib 才能被数据层测试守住
    expect(workspace).toContain('promptMax={IMAGE_PROMPT_MAX}')
    expect(workspace).not.toContain('const PROMPT_MAX =')
  })

  it('stops silently truncating long prompts', () => {
    // 旧行为是 value.slice(0, promptMax),粘 1000 字的提示词会被无声吃掉尾巴
    expect(input).not.toContain('slice(0, promptMax)')
    expect(input).toContain('prompt.length > promptMax ? styles.captionOver')
    expect(workspace).toContain('const promptTooLong = prompt.length > IMAGE_PROMPT_MAX')
    expect(workspace).toContain('!promptTooLong &&')
  })

  it('exposes providerStyle alongside the other advanced gpt parameters', () => {
    expect(output).toContain("['vivid', 'natural']")
    expect(models).toContain('providerStyle: args.output.providerStyle,')
  })
})
