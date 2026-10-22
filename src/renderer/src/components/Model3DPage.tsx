import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import {
  Alert,
  Divider,
  App as AntApp,
  Button,
  Empty,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Slider,
  Spin,
  Switch,
  Tooltip,
} from 'antd'
import { Box, Sparkles, Trash2, ImagePlus, X, Wrench } from 'lucide-react'
import {
  api,
  type BlenderSetupStatus,
  type Model3DHistoryItem,
  type Model3DOptions,
  type Model3DProvider,
} from '../lib/api'
import { assessReferenceImage, normalizeReferenceImage } from '../lib/reference-check'
import ModelViewer from './ModelViewer'

const PROVIDERS: Array<{
  value: Model3DProvider
  label: string
  supportsText: boolean
  versions: Array<{ value: string; label: string }>
  /** 每个模型版本的面数上限(Tripo) */
  faceMax?: Record<string, number>
  /** 支持 geometry_quality(Ultra 模式)的版本 */
  geometryQuality?: string[]
}> = [
  {
    value: 'tripo',
    label: 'Tripo',
    supportsText: true,
    // 不放 v1.4/v1.3:face_limit/texture/pbr 这组参数只对 >=v2.0 有效,
    // 放进来会让下面的参数面板对它们失效(v1.3 官方也已标废弃)。
    versions: [
      { value: 'P1-20260311', label: 'P1(最新)' },
      { value: 'Turbo-v1.0-20250506', label: 'Turbo v1.0' },
      { value: 'v3.1-20260211', label: 'v3.1' },
      { value: 'v3.0-20250812', label: 'v3.0' },
      { value: 'v2.5-20250123', label: 'v2.5' },
      { value: 'v2.0-20240919', label: 'v2.0' },
    ],
    // 面数上限随版本变(文档 Generation 的表格);未列出的版本按保守值。
    faceMax: {
      'P1-20260311': 500_000,
      'Turbo-v1.0-20250506': 500_000,
      'v3.1-20260211': 2_000_000,
      'v3.0-20250812': 2_000_000,
      'v2.5-20250123': 500_000,
      'v2.0-20240919': 500_000,
    },
    // geometry_quality 只对 >=v3.0 有效,且 P1 明确不支持(质量已预调优)
    geometryQuality: ['v3.1-20260211', 'v3.0-20250812'],
  },
]

// 视觉闭环阈值:达到 LOOP_THRESHOLD 分或跑满 LOOP_MAX_ROUNDS 轮即停
const LOOP_THRESHOLD = 85
const LOOP_MAX_ROUNDS = 5

const STATUS_TEXT: Record<string, string> = {
  'generating-image': 'AI 生图中…',
  uploading: '上传参考图…',
  submitting: '提交任务…',
  queued: '排队中…',
  running: '生成中…',
  downloading: '下载模型…',
  building: 'agent 建模中…',
  repairing: '报错修复中…',
  exporting: '导出模型…',
  done: '完成',
  error: '失败',
}

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(340px, 35fr) minmax(0, 65fr);
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    line-height: 22px;
    font-weight: 500;
    color: ${token.colorText};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  `,
  dropzone: css`
    position: relative;
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadiusLG}px;
    min-height: 150px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    &:hover {
      border-color: ${token.colorPrimary};
    }
  `,
  dropImg: css`
    max-width: 100%;
    max-height: 220px;
    object-fit: contain;
  `,
  clearImg: css`
    position: absolute;
    top: 6px;
    right: 6px;
  `,
  right: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  `,
  stage: css`
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  gallery: css`
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 10px;
    max-height: 220px;
    overflow-y: auto;
    padding: 2px;
  `,
  card: css`
    position: relative;
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    border: 2px solid transparent;
    cursor: pointer;
    background: ${token.colorFillQuaternary};
    &:hover .del {
      opacity: 1;
    }
  `,
  cardActive: css`
    border-color: ${token.colorPrimary};
  `,
  thumb: css`
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  thumbFallback: css`
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${token.colorTextQuaternary};
  `,
  del: css`
    position: absolute;
    top: 4px;
    right: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  `,
  scoreBadge: css`
    position: absolute;
    left: 4px;
    bottom: 4px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    color: #fff;
    pointer-events: none;
  `,
  placeholderCard: css`
    position: relative;
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    border: 2px solid ${token.colorPrimaryBorder};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextSecondary};
    font-size: 11px;
    text-align: center;
    padding: 4px;
  `,
}))

/** 还原度配色:≥80 绿 / ≥60 橙 / 其余红 */
function scoreColor(score: number): string {
  return score >= 80 ? '#52c41a' : score >= 60 ? '#faad14' : '#ff4d4f'
}

export default function Model3DPage(): React.JSX.Element {
  const { styles, cx } = useStyles()
  const { message } = AntApp.useApp()
  const supportsBlender = api.platform === 'win32'

  const [configured, setConfigured] = useState(true)
  const [providerReady, setProviderReady] = useState<Record<string, boolean> | null>(null)
  const [mode, setMode] = useState<'text' | 'image' | 'code' | 'blender'>('text')
  const [prompt, setPrompt] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  // 图生模式的图从哪来:上传 or gpt-image-2 生成
  const [imgSource, setImgSource] = useState<'upload' | 'ai'>('upload')
  const [refWarnings, setRefWarnings] = useState<string[]>([])
  const [blenderStatus, setBlenderStatus] = useState<BlenderSetupStatus | null>(null)
  const [blenderSetupLoading, setBlenderSetupLoading] = useState(false)
  const [refineText, setRefineText] = useState('')
  const provider: Model3DProvider = 'tripo'
  const [opts, setOpts] = useState<Model3DOptions>({
    texture: true,
    pbr: false,
    modelVersion: PROVIDERS[0].versions[0].value,
  })
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<{ status: string; progress: number } | null>(null)
  const [history, setHistory] = useState<Model3DHistoryItem[]>([])
  const [selected, setSelected] = useState<Model3DHistoryItem | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 代码模式「视觉闭环」:渲染→AI 评审→自动改码→再渲染,到分/到轮数停
  const [autoLoop, setAutoLoop] = useState(true)
  const [loopInfo, setLoopInfo] = useState('')
  const snapshotResolve = useRef<((d: string) => void) | null>(null)
  const loopAbort = useRef(false)

  const activeProvider = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0]
  // 只有云端模式(文生/图生)依赖服务商密钥;代码建模/Blender 走本地 agent
  // 建模方式:云端(文生/图生,走服务商)vs 本地(代码/Blender,内嵌 agent 驱动本机)。
  // 服务商和模型版本只对云端有意义,不该在本地建模时还杵在上面。
  const kind: 'cloud' | 'local' = mode === 'code' || mode === 'blender' ? 'local' : 'cloud'
  function onSwitchKind(next: 'cloud' | 'local'): void {
    if (next === kind) return
    setMode(next === 'local' ? 'code' : activeProvider.supportsText ? 'text' : 'image')
  }

  const cloudProviderMissing =
    (mode === 'text' || mode === 'image') && providerReady?.[provider] === false
  const versionOptions = activeProvider.versions
  const currentVersion = opts.modelVersion ?? versionOptions[0].value
  const faceMax = activeProvider.faceMax?.[currentVersion] ?? 50_000
  const supportsGeometryQuality = activeProvider.geometryQuality?.includes(currentVersion) ?? false

  useEffect(() => {
    void api.model3d.health().then((h) => {
      setConfigured(h.configured)
      setProviderReady(h.providers ?? null)
    })
    void api.model3d.history().then((items) => {
      setHistory(items)
      if (items[0]) setSelected(items[0])
    })
    const off = api.model3d.onProgress((data) => setProgress({ status: data.status, progress: data.progress }))
    const offScored = api.model3d.onScored(({ id, fidelity }) => {
      setHistory((prev) => prev.map((it) => (it.id === id ? { ...it, fidelity } : it)))
      setSelected((cur) => (cur?.id === id ? { ...cur, fidelity } : cur))
    })
    return () => {
      off()
      offScored()
    }
  }, [])

  useEffect(() => {
    if (mode === 'blender') void api.model3d.blenderStatus().then(setBlenderStatus)
  }, [mode])

  const onSetupBlender = async (): Promise<void> => {
    setBlenderSetupLoading(true)
    try {
      const status = await api.model3d.setupBlender()
      setBlenderStatus(status)
      if (status.connected) message.success('Blender 已启动，blender-mcp 已连接')
      else message.error(status.error ?? 'Blender 启动失败')
    } finally {
      setBlenderSetupLoading(false)
    }
  }

  const pickFile = (file: File | null | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setRefWarnings([])
      // 透明底先压平到白底(否则 Tripo 压成黑底重建出黑色面片),预览即所传;
      // 压平过的图背景必然纯白,跳过背景类预检
      void normalizeReferenceImage(reader.result as string).then(async ({ dataUrl, flattened }) => {
        setImageDataUrl(dataUrl)
        const r = await assessReferenceImage(dataUrl, { skipBackground: flattened })
        setRefWarnings(r.warnings)
      })
    }
    reader.readAsDataURL(file)
  }

  // 让 ModelViewer 渲染某个模型并回传一帧截图(供评审)
  const captureRender = (item: Model3DHistoryItem): Promise<string> =>
    new Promise((resolve) => {
      snapshotResolve.current = resolve
      setSelected(item) // ModelViewer 渲染它 → onSnapshot 触发 → resolve
    })

  // 代码模式视觉闭环:出码→渲染→评审→按点评改码…直到 ≥阈值 / 到轮数 / 叫停
  const runVisualLoop = async (basePrompt: string): Promise<void> => {
    loopAbort.current = false
    setGenerating(true)
    setLoopInfo('第 1 轮 · 生成中')
    setProgress({ status: 'building', progress: 0 })
    try {
      const first = await api.model3d.generateCode({ prompt: basePrompt })
      if ('error' in first) return void message.error(first.error)
      let item: Model3DHistoryItem = first
      setHistory((prev) => [item, ...prev])
      let best: Model3DHistoryItem = item
      let bestScore = -1
      for (let round = 1; round <= LOOP_MAX_ROUNDS; round++) {
        setLoopInfo(`第 ${round} 轮 · 渲染评审中`)
        const shot = await captureRender(item)
        const review = await api.model3d.reviewRound({ id: item.id, dataUrl: shot, prompt: basePrompt })
        const score = 'error' in review ? 0 : review.score
        if (score > bestScore) {
          bestScore = score
          best = item
        }
        setLoopInfo(`第 ${round} 轮 · 还原度 ${score} 分`)
        if (score >= LOOP_THRESHOLD || round === LOOP_MAX_ROUNDS || loopAbort.current) break
        setLoopInfo(`第 ${round + 1} 轮 · 按点评改码中`)
        const notes = 'error' in review ? '' : review.notes
        const instruction = `当前还原度约 ${score} 分。主要差异:${notes}。请据此改进模型,使其更贴合「${basePrompt}」。`
        const next = await api.model3d.generateCode({ prompt: instruction, sourceId: item.id })
        if ('error' in next) {
          message.warning('本轮改码失败,保留当前最好一版')
          break
        }
        setHistory((prev) => [next, ...prev])
        item = next
      }
      setSelected(best)
      message.success(
        loopAbort.current ? `已停止,最佳还原度 ${bestScore} 分` : `自动优化完成,最佳还原度 ${bestScore} 分`,
      )
    } catch (err) {
      message.error(err instanceof Error ? err.message : '视觉闭环出错')
    } finally {
      setGenerating(false)
      setProgress(null)
      setLoopInfo('')
    }
  }

  const onGenerate = async (): Promise<void> => {
    if (mode === 'image') {
      if (imgSource === 'upload' && !imageDataUrl) return void message.warning('请选择参考图片')
      if (imgSource === 'ai' && !prompt.trim()) return void message.warning('请输入模型描述')
    } else if (!prompt.trim()) {
      return void message.warning('请输入描述')
    }
    if (mode === 'code' && autoLoop) return void runVisualLoop(prompt)
    const aiImage = mode === 'image' && imgSource === 'ai'
    setGenerating(true)
    setProgress({
      status: mode === 'code' || mode === 'blender' ? 'building' : aiImage ? 'generating-image' : 'submitting',
      progress: 0,
    })
    try {
      const res =
        mode === 'blender'
          ? await api.model3d.generateBlender({ prompt })
          : mode === 'code'
          ? await api.model3d.generateCode({ prompt })
          : await api.model3d.generate({
              mode,
              prompt,
              ...(aiImage ? { aiImage: true } : {}),
              ...(mode === 'image' && !aiImage && imageDataUrl ? { imageDataUrl } : {}),
              provider,
              options: opts,
            })
      if ('error' in res) {
        message.error(res.error)
      } else {
        setHistory((prev) => [res, ...prev])
        setSelected(res)
        message.success(mode === 'code' || mode === 'blender' ? '模型已生成' : '3D 模型已生成')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  /** 迭代修改选中的代码建模/Blender 模型:以其脚本为起点生成新版本(原模型保留)。 */
  const onRefine = async (): Promise<void> => {
    if (!selected || !refineText.trim()) return void message.warning('请输入修改要求')
    const source = selected
    setGenerating(true)
    setProgress({ status: 'building', progress: 0 })
    try {
      const payload = { prompt: refineText.trim(), sourceId: source.id }
      const res =
        source.mode === 'blender'
          ? await api.model3d.generateBlender(payload)
          : await api.model3d.generateCode(payload)
      if ('error' in res) {
        message.error(res.error)
      } else {
        setHistory((prev) => [res, ...prev])
        setSelected(res)
        setRefineText('')
        message.success('修改版已生成(原模型保留在历史里)')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    await api.model3d.historyDelete(id)
    setHistory((prev) => {
      const next = prev.filter((it) => it.id !== id)
      setSelected((cur) => (cur?.id === id ? next[0] ?? null : cur))
      return next
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.title}>
          <Box size={16} /> 3D 生成
        </div>

        {!configured && (
          <div style={{ fontSize: 12, color: '#faad14' }}>
            未配置云端中继,请到「设置 → 生图 → 云端中继」填写(3D 生成与生图共用)。
          </div>
        )}

        <Segmented
          block
          value={kind}
          onChange={(v) => onSwitchKind(v as 'cloud' | 'local')}
          options={[
            { label: '云端生成', value: 'cloud' },
            { label: '本地建模', value: 'local' },
          ]}
        />

        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as 'text' | 'image' | 'code' | 'blender')}
          options={
            kind === 'cloud'
              ? [
                  { label: '文生 3D', value: 'text', disabled: !activeProvider.supportsText },
                  { label: '图生 3D', value: 'image' },
                ]
              : [
                  { label: '代码建模', value: 'code' },
                  ...(supportsBlender ? [{ label: 'Blender', value: 'blender' }] : []),
                ]
          }
        />

        {mode === 'blender' && (
          <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
            由内嵌 agent 驱动本机 Blender(blender-mcp)建模并导出 glb,可用修改器/布尔/倒角等真建模工具。
            {blenderStatus?.connected === false && (
              <div style={{ color: '#faad14', marginTop: 4 }}>
                <div>尚未连接 Blender。首次使用会安装经过校验的 blender-mcp addon。</div>
                <Button
                  size="small"
                  type="link"
                  loading={blenderSetupLoading}
                  onClick={() => void onSetupBlender()}
                  style={{ padding: 0, height: 24 }}
                >
                  一键安装并启动 Blender
                </Button>
              </div>
            )}
            {blenderStatus?.connected && (
              <div style={{ color: '#52c41a', marginTop: 4 }}>
                Blender 已连接{blenderStatus.version ? ` (${blenderStatus.version})` : ''}
              </div>
            )}
          </div>
        )}

        {mode === 'code' && (
          <>
            <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
              由内嵌 agent 用 three.js 程序化手搓「可动画/可拆解」的代码模型,导出为 glb。
              比 Tripo 慢(数分钟),适合游戏道具、需要绑定交互的场景。
            </div>
            <div className={styles.field}>
              <span className={styles.label}>生成方式</span>
              <Segmented
                block
                value={autoLoop ? 'loop' : 'once'}
                onChange={(v) => setAutoLoop(v === 'loop')}
                options={[
                  { label: '一次生成', value: 'once' },
                  { label: `自动优化(≤${LOOP_MAX_ROUNDS}轮)`, value: 'loop' },
                ]}
              />
              <span className={styles.label} style={{ fontSize: 12 }}>
                自动优化:每轮 渲染 → AI 评审 → 按点评改码,到 {LOOP_THRESHOLD} 分或 {LOOP_MAX_ROUNDS} 轮停
              </span>
            </div>
          </>
        )}

        {mode !== 'image' ? (
          <div className={styles.field}>
            <span className={styles.label}>{mode === 'text' ? '提示词' : '模型描述'}</span>
            <Input.TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === 'code' || mode === 'blender'
                  ? '例如:一个带铰链盖子和金属搭扣的木质宝箱'
                  : '例如:a cute low-poly red mushroom'
              }
              autoSize={{ minRows: 3, maxRows: 6 }}
            />
          </div>
        ) : (
          <div className={styles.field}>
            <Segmented
              block
              value={imgSource}
              onChange={(v) => setImgSource(v as 'upload' | 'ai')}
              options={[
                { label: '上传参考图', value: 'upload' },
                { label: 'AI 生图', value: 'ai' },
              ]}
              style={{ marginBottom: 10 }}
            />
            {imgSource === 'ai' ? (
              <>
                <span className={styles.label}>模型描述（gpt-image-2 生图 → 图生 3D）</span>
                <Input.TextArea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例如:一只赛博朋克风格的机械猫"
                  autoSize={{ minRows: 3, maxRows: 6 }}
                />
                <span className={styles.label} style={{ fontSize: 12 }}>
                  先按描述生成一张纯白底参考图,再据此图生 3D
                </span>
              </>
            ) : (
              <>
                <span className={styles.label}>参考图片</span>
                <div className={styles.dropzone} onClick={() => fileRef.current?.click()}>
                  {imageDataUrl ? (
                    <>
                      <img className={styles.dropImg} src={imageDataUrl} alt="reference" />
                      <Button
                        className={styles.clearImg}
                        size="small"
                        icon={<X size={14} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          setImageDataUrl(null)
                          setRefWarnings([])
                        }}
                      />
                    </>
                  ) : (
                    <div style={{ textAlign: 'center' }}>
                      <ImagePlus size={26} />
                      <div style={{ marginTop: 6, fontSize: 12 }}>点击选择图片</div>
                    </div>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
                <span className={styles.label} style={{ fontSize: 12 }}>
                  建议:单一主体、白底或透明底、无遮挡,重建效果最好
                </span>
                {refWarnings.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    title={
                      refWarnings.length === 1 ? (
                        refWarnings[0]
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {refWarnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      )
                    }
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* Tripo 专属参数,仅云端文生/图生模式显示(代码建模/Blender 用不上) */}
        {(mode === 'text' || mode === 'image') && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>模型版本</span>
              <Select
                value={opts.modelVersion ?? versionOptions[0].value}
                onChange={(v) =>
                  setOpts((o) => {
                    const nextMax = activeProvider.faceMax?.[v] ?? 50_000
                    return {
                      ...o,
                      modelVersion: v || undefined,
                      // 换到上限更低的版本时收回超限值,否则会被 API 拒
                      faceLimit: o.faceLimit ? Math.min(o.faceLimit, nextMax) : undefined,
                      // P1 等版本不接受 geometry_quality,别把它带过去
                      geometryQuality: activeProvider.geometryQuality?.includes(v)
                        ? o.geometryQuality
                        : undefined,
                    }
                  })
                }
                options={versionOptions}
              />
            </div>

            {supportsGeometryQuality && (
              <div className={styles.field}>
                <span className={styles.label}>几何质量</span>
                <Select
                  value={opts.geometryQuality ?? 'standard'}
                  onChange={(v) => setOpts((o) => ({ ...o, geometryQuality: v }))}
                  options={[
                    { value: 'standard', label: '标准(速度与细节平衡)' },
                    { value: 'detailed', label: 'Ultra(最高细节)' },
                  ]}
                />
              </div>
            )}

            <div className={styles.row}>
              <span className={styles.label}>贴图纹理</span>
              <Switch checked={opts.texture ?? true} onChange={(v) => setOpts((o) => ({ ...o, texture: v }))} />
            </div>
            <div className={styles.row}>
              <span className={styles.label}>PBR 材质</span>
              <Switch checked={opts.pbr ?? false} onChange={(v) => setOpts((o) => ({ ...o, pbr: v }))} />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>面数上限(0 = 自动)：{opts.faceLimit ?? 0}</span>
              <Slider
                min={0}
                max={faceMax}
                step={Math.max(1000, Math.round(faceMax / 100))}
                value={Math.min(opts.faceLimit ?? 0, faceMax)}
                onChange={(v) => setOpts((o) => ({ ...o, faceLimit: v || undefined }))}
              />
            </div>
          </>
        )}

        {/* 云端服务商未配置密钥时直接拦住,不让用户点了才拿到一个服务端错误 */}
        {cloudProviderMissing && (
          <Alert
            type="warning"
            showIcon
            message={`${activeProvider.label} 尚未配置密钥`}
            description="在服务端 .env 里填 TRIPO_SECRET 后重启 worker。"
          />
        )}

        <Button
          type="primary"
          icon={<Sparkles size={15} />}
          loading={generating}
          disabled={generating || cloudProviderMissing}
          onClick={onGenerate}
          block
        >
          生成 3D 模型
        </Button>

        {selected && (selected.mode === 'code' || selected.mode === 'blender') && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div className={styles.field}>
              <span className={styles.label}>修改选中的模型</span>
              <span
                style={{ fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={selected.prompt}
              >
                {selected.prompt}
              </span>
              <Input.TextArea
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                placeholder="例如:盖子再大一点,正面加一把锁"
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                {selected.fidelity?.notes && (
                  <Tooltip title={selected.fidelity.notes}>
                    <Button
                      size="small"
                      onClick={() => setRefineText(`按以下点评改进:${selected.fidelity!.notes}`)}
                    >
                      按 AI 点评修改
                    </Button>
                  </Tooltip>
                )}
                {/* 次级动作:页面唯一的主要强调点留给「生成 3D 模型」 */}
                <Button
                  size="small"
                  icon={<Wrench size={13} />}
                  loading={generating}
                  disabled={generating || !refineText.trim()}
                  onClick={onRefine}
                  style={{ marginLeft: 'auto' }}
                >
                  生成修改版
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className={styles.right}>
        <div className={styles.stage}>
          {selected ? (
            <ModelViewer
              url={selected.modelUrl}
              downloadUrl={selected.cloudModelUrl ?? null}
              onSnapshot={
                !selected.thumbnailUrl && (selected.mode === 'code' || selected.mode === 'blender')
                  ? async (dataUrl) => {
                      // 视觉闭环在等这一帧:直接交给闭环,别走 saveThumbnail
                      if (snapshotResolve.current) {
                        const resolve = snapshotResolve.current
                        snapshotResolve.current = null
                        resolve(dataUrl)
                        return
                      }
                      const r = await api.model3d.saveThumbnail({ id: selected.id, dataUrl })
                      if (!('error' in r)) {
                        setHistory((prev) => prev.map((it) => (it.id === r.id ? r : it)))
                        setSelected((cur) => (cur?.id === r.id ? r : cur))
                      }
                    }
                  : undefined
              }
            />
          ) : (
            <Empty description="还没有 3D 模型" image={<Box size={48} strokeWidth={1} />} />
          )}
        </div>

        {(generating || history.length > 0) && (
          <div className={styles.gallery}>
            {generating && (
              <div className={styles.placeholderCard}>
                <Spin size="small" />
                <span>
                  {loopInfo || (STATUS_TEXT[progress?.status ?? 'submitting'] ?? '生成中…')}
                  {!loopInfo && progress && progress.progress > 0 ? ` ${Math.round(progress.progress)}%` : ''}
                </span>
                {loopInfo && (
                  <Button
                    size="small"
                    onClick={() => {
                      loopAbort.current = true
                      setLoopInfo((s) => (s.includes('停止') ? s : `${s} · 停止中`))
                    }}
                  >
                    停止
                  </Button>
                )}
              </div>
            )}
            {history.map((it) => (
              <div
                key={it.id}
                className={cx(styles.card, selected?.id === it.id && styles.cardActive)}
                onClick={() => setSelected(it)}
                title={it.prompt}
              >
                {it.thumbnailUrl ? (
                  <img className={styles.thumb} src={it.thumbnailUrl} alt={it.prompt} />
                ) : (
                  <div className={styles.thumbFallback}>
                    <Box size={22} />
                  </div>
                )}
                {it.fidelity && (
                  <span
                    className={styles.scoreBadge}
                    style={{ background: scoreColor(it.fidelity.score) }}
                  >
                    {it.fidelity.score}
                  </span>
                )}
                <Popconfirm
                  title="删除这个模型?"
                  onConfirm={(e) => {
                    e?.stopPropagation()
                    void onDelete(it.id)
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Tooltip title="删除">
                    <Button
                      className={cx(styles.del, 'del')}
                      size="small"
                      danger
                      icon={<Trash2 size={13} />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Tooltip>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
