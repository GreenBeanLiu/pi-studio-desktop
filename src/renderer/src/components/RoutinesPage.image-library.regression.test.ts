import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./RoutinesPage.tsx', import.meta.url), 'utf8')
const picker = readFileSync(new URL('./RoutineImageReferencePicker.tsx', import.meta.url), 'utf8')

describe('workflow image library regressions', () => {
  it('lets the image reference select from generated image history', () => {
    expect(page).toContain('title="选择参考图"')
    expect(page).toContain('updateStep(step.id, { imageRef })')
    expect(picker).toContain('api.imageGen.history(100)')
    expect(picker).toContain('onChange(item.url)')
  })

  it('keeps workflow templates in one compact dropdown', () => {
    expect(page).toContain('const templateMenu =')
    expect(page).toContain('<Dropdown menu={templateMenu}')
    expect(page).toContain('>模板</Button>')
  })
})
