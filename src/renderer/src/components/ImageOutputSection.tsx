import { Input, InputNumber, Select } from 'antd'
import { createStyles } from 'antd-style'

import type {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  GrokImageAspectRatio,
  GrokImageResolution,
  ImageGenQuality,
  ImageGenSize,
} from '../lib/api'
import { imageModel, type ImageOutputSettings } from './image-generation-models'
import type { ImageModel } from '../lib/api'

const GPT_SIZES: ImageGenSize[] = [
  '256x256', '512x512', '1024x1024', '1024x1536',
  '1536x1024', '1024x1792', '1792x1024', 'auto',
]
const GROK_RATIOS: GrokImageAspectRatio[] = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto',
]
// 只有 1K/2K —— 4K 会被后端 400 挡下
const GROK_SIZES: GrokImageResolution[] = ['1K', '2K']
const NANO_RATIOS: GeminiImageAspectRatio[] = [
  'auto', '1:1', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9',
  '1:4', '4:1', '1:8', '8:1',
]
// 按张计费:1K $0.012、2K/4K 更贵(以 APIMart 账单为准)
const NANO_SIZES: GeminiImageResolution[] = ['1K', '2K', '4K']
const QUALITIES: ImageGenQuality[] = ['low', 'medium', 'high', 'auto', 'standard', 'hd']

// 全部走主题 token,不再硬编码浅色 —— 之前 rgba(0,0,0,…) 在暗色下几乎不可见
const useStyles = createStyles(({ token, css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  `,
  option: css`
    min-width: 0;
    min-height: 38px;
    border: 1px solid ${token.colorBorder};
    border-radius: 6px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorText};
    cursor: pointer;
    transition: all ${token.motionDurationFast};
    &:hover:not(:disabled) {
      border-color: ${token.colorPrimaryBorder};
    }
    &:disabled {
      cursor: not-allowed;
    }
  `,
  optionActive: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimary};
  `,
  sectionTitle: css`
    font-size: 12px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
  `,
  label: css`
    font-size: 11px;
    font-weight: 500;
    color: ${token.colorTextTertiary};
    margin-top: 2px;
  `,
  advancedToggle: css`
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: ${token.colorTextTertiary};
    &:hover {
      color: ${token.colorText};
    }
  `,
  advancedGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    color: ${token.colorTextSecondary};
    font-size: 12px;
    & label {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    & .ant-select,
    & .ant-input,
    & .ant-input-number {
      width: 100%;
    }
  `,
  maskHint: css`
    font-size: 11px;
    color: ${token.colorWarning};
  `,
}))

function Options<T extends string>({
  values,
  value,
  onChange,
}: {
  values: readonly T[]
  value: T
  onChange: (value: T) => void
}) {
  const { styles, cx } = useStyles()
  return (
    <div className={styles.grid}>
      {values.map((option) => (
        <button
          key={option}
          type="button"
          className={cx(styles.option, option === value && styles.optionActive)}
          onClick={() => onChange(option)}
        >
          {option.replace('x', '×')}
        </button>
      ))}
    </div>
  )
}

export default function ImageOutputSection({
  modelKey,
  value,
  hasMask,
  onChange,
}: {
  modelKey: ImageModel
  value: ImageOutputSettings
  hasMask: boolean
  onChange: (patch: Partial<ImageOutputSettings>) => void
}) {
  const { styles, cx } = useStyles()
  const model = imageModel(modelKey)
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className={styles.sectionTitle}>输出参数</div>

      {model.parameters === 'gpt' && (
        <>
          <span className={styles.label}>尺寸</span>
          <Options values={GPT_SIZES} value={value.size} onChange={(size) => onChange({ size })} />
          <span className={styles.label}>质量</span>
          <Options
            values={QUALITIES}
            value={value.quality}
            onChange={(quality) => onChange({ quality })}
          />
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => onChange({ advanced: !value.advanced })}
          >
            GPT Image 2 高级参数 {value.advanced ? '▴' : '▾'}
          </button>
          {value.advanced && (
            <div className={styles.advancedGrid}>
              <label>背景<Select value={value.background} options={['auto', 'transparent', 'opaque'].map((item) => ({ value: item, label: item }))} onChange={(background) => onChange({ background })} /></label>
              <label>格式<Select value={value.outputFormat} options={['png', 'jpeg', 'webp'].map((item) => ({ value: item, label: item }))} onChange={(outputFormat) => onChange({ outputFormat })} /></label>
              <label>压缩<InputNumber min={0} max={100} disabled={value.outputFormat === 'png'} value={value.outputCompression} onChange={(outputCompression) => onChange({ outputCompression: outputCompression ?? 0 })} /></label>
              <label>审核<Select value={value.moderation} options={['auto', 'low'].map((item) => ({ value: item, label: item }))} onChange={(moderation) => onChange({ moderation })} /></label>
              <label>响应<Select value={value.responseFormat} options={['b64_json', 'url'].map((item) => ({ value: item, label: item }))} onChange={(responseFormat) => onChange({ responseFormat })} /></label>
              <label>风格<Select value={value.providerStyle} options={['vivid', 'natural'].map((item) => ({ value: item, label: item }))} onChange={(providerStyle) => onChange({ providerStyle })} /></label>
              <label>用户<Input maxLength={64} value={value.requestUser} onChange={(event) => onChange({ requestUser: event.target.value })} /></label>
            </div>
          )}
        </>
      )}

      {model.parameters === 'grok' && (
        <>
          <span className={styles.label}>画幅比例</span>
          <Options values={GROK_RATIOS} value={value.grokAspectRatio} onChange={(grokAspectRatio) => onChange({ grokAspectRatio })} />
          <span className={styles.label}>分辨率</span>
          <Options values={GROK_SIZES} value={value.grokImageSize} onChange={(grokImageSize) => onChange({ grokImageSize })} />
        </>
      )}

      {model.parameters === 'nano' && (
        <>
          <span className={styles.label}>画幅比例(auto 跟参考图)</span>
          <Options values={NANO_RATIOS} value={value.nanoAspectRatio} onChange={(nanoAspectRatio) => onChange({ nanoAspectRatio })} />
          <span className={styles.label}>分辨率</span>
          <Options values={NANO_SIZES} value={value.nanoImageSize} onChange={(nanoImageSize) => onChange({ nanoImageSize })} />
        </>
      )}

      <span className={styles.label}>一次生成</span>
      <div className={styles.grid}>
        {[1, 2, 3, 4].map((count) => (
          <button
            key={count}
            type="button"
            disabled={hasMask && count !== 1}
            className={cx(
              styles.option,
              count === (hasMask ? 1 : value.count) && styles.optionActive,
            )}
            style={hasMask && count !== 1 ? { opacity: 0.4 } : undefined}
            onClick={() => onChange({ count })}
          >
            {count} 张
          </button>
        ))}
      </div>
      {hasMask && <span className={styles.maskHint}>蒙版局部重绘固定输出 1 张</span>}
    </section>
  )
}
