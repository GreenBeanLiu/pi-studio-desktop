import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { App as AntApp, Button, Spin, Tooltip } from 'antd'
import { createStyles } from 'antd-style'
import { Image as ImageIcon, RefreshCw, Sparkles } from 'lucide-react'

import {
  api,
  type ImageGenHealth,
  type ImageGenHistoryItem,
  type ImageModel,
} from '../lib/api'
import ImageHistoryBatchRow from './ImageHistoryBatchRow'
import ImageInputSection, { type ReferenceUploadState } from './ImageInputSection'
import ImageModelSelector from './ImageModelSelector'
import ImageOutputSection from './ImageOutputSection'
import { groupImageGenerationHistory } from './image-generation-history'
import {
  buildImageGenerationRequest,
  defaultImageModel,
  imageModel,
  type ImageOutputSettings,
} from './image-generation-models'
import {
  IMAGE_PROMPT_MAX,
  templateAspectRatio,
  type ImageStyleTemplate,
} from '../lib/image-style-templates'

const PAGE_SIZE = 60

const DEFAULT_OUTPUT: ImageOutputSettings = {
  count: 1,
  size: '1024x1024',
  quality: 'auto',
  background: 'auto',
  outputFormat: 'png',
  outputCompression: 90,
  moderation: 'auto',
  responseFormat: 'b64_json',
  providerStyle: 'vivid',
  requestUser: '',
  advanced: false,
  grokAspectRatio: '1:1',
  grokImageSize: '1K',
}

type PendingBatch = { id: string; prompt: string; model: string; count: number }
type SessionImage = ImageGenHistoryItem & { local: true }

type MaskEditorProps = {
  open: boolean
  src: string
  onCancel: () => void
  onApply: (mask: string) => void
}

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(340px, 35fr) minmax(0, 65fr);
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
    @media (max-width: 900px) { grid-template-columns: 1fr; overflow-y: auto; }
  `,
  panel: css`
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
  `,
  sectionTitle: css`
    font-size: 12px;
    line-height: 18px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
  `,
  modelHint: css`
    margin-top: -8px;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  warning: css`
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorWarningBg};
    color: ${token.colorWarningText};
    font-size: 12px;
  `,
  gallery: css`
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
  `,
  galleryHead: css`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    font-size: 15px;
    line-height: 22px;
    font-weight: 500;
    .sub { font-size: 11px; font-weight: 400; color: ${token.colorTextTertiary}; }
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  pending: css`
    min-height: 104px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px;
    border: 1px dashed ${token.colorPrimaryBorder};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorPrimaryBg};
  `,
  empty: css`
    min-height: 260px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    color: ${token.colorTextTertiary};
  `,
  load: css`
    min-height: 32px;
    display: grid;
    place-items: center;
    color: ${token.colorTextTertiary};
    font-size: 11px;
  `,
  lightbox: css`
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    background: ${token.colorBgMask};
    cursor: zoom-out;
    img { max-width: 92vw; max-height: 92vh; object-fit: contain; }
  `,
}))

function timestampLabel(value: number) {
  return new Date(value > 1e12 ? value : value * 1000).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function providerTag(engine: string, provider: string | null, model: string | null) {
  const providerName = provider === 'three-a-grok'
    ? '3A'
    : provider === 'three-a'
      ? '3A'
      : provider === 'tikhub'
        ? 'TikHub'
        : provider === 'tuzi'
          ? 'Tu-zi'
          : provider === 'ourzhishi'
            ? 'OurZhishi'
            : provider
  // sdxl/comfy 分支保留:历史画廊里可能还有本地引擎时代生成的旧图
  const modelName = model === 'sdxl-local'
    ? 'SDXL'
    : model?.startsWith('gemini')
      ? 'Gemini'
      : model?.startsWith('grok')
        ? 'Grok'
        : engine.startsWith('comfy')
          ? 'SDXL'
          : 'GPT'
  return providerName ? `${modelName} · ${providerName}` : modelName
}

export default function ImageGenerationWorkspace({
  MaskEditorComponent,
}: {
  MaskEditorComponent: ComponentType<MaskEditorProps>
}) {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()
  const [health, setHealth] = useState<ImageGenHealth | null>(null)
  const [modelKey, setModelKey] = useState<ImageModel>('gpt-image-2')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState<ImageOutputSettings>(DEFAULT_OUTPUT)
  const [baseImage, setBaseImage] = useState<string | null>(null)
  const [upload, setUpload] = useState<ReferenceUploadState>({ status: 'idle' })
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null)
  const [maskEditorOpen, setMaskEditorOpen] = useState(false)
  const [history, setHistory] = useState<ImageGenHistoryItem[]>([])
  const [sessionImages, setSessionImages] = useState<SessionImage[]>([])
  const [pending, setPending] = useState<PendingBatch[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [historyDone, setHistoryDone] = useState(false)
  const uploadOwnerRef = useRef<string | null>(null)
  const galleryRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const limitRef = useRef(PAGE_SIZE)

  const model = imageModel(modelKey)
  const batches = useMemo(
    () => groupImageGenerationHistory([...sessionImages, ...history]),
    [history, sessionImages],
  )
  /** 点模板:填入骨架,并把推荐画幅落到当前模型吃的那个字段上。 */
  function applyStyleTemplate(template: ImageStyleTemplate): void {
    setPrompt(template.skeleton.slice(0, IMAGE_PROMPT_MAX))
    const ratio = templateAspectRatio(template.size)
    setOutput((current) => ({
      ...current,
      size: template.size,
      grokAspectRatio: ratio,
    }))
  }

  async function refreshHealth() {
    setHealth(await api.imageGen.health())
  }

  async function fetchHistory(limit = limitRef.current) {
    const result = await api.imageGen.history(limit)
    if (!Array.isArray(result)) return
    setHistory(result)
    const persistedUrls = new Set(result.map((item) => item.url))
    setSessionImages((items) => items.filter((item) => !persistedUrls.has(item.url)))
    const batchCount = new Set(result.map((item) => item.batch_id || item.id)).size
    setHistoryDone(batchCount < limit)
  }

  async function loadMore() {
    if (loadingMore || historyDone) return
    setLoadingMore(true)
    try {
      limitRef.current += PAGE_SIZE
      await fetchHistory(limitRef.current)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void Promise.all([
      api.settings.load().catch(() => null),
      api.imageGen.health(),
    ]).then(([settings, initialHealth]) => {
      setHealth(initialHealth)
      setModelKey(defaultImageModel(settings?.imageEngine))
    })
    void fetchHistory()
  }, [])

  useEffect(() => {
    const root = galleryRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [historyDone, loadingMore])

  function clearInputImage() {
    setBaseImage(null)
    setMaskDataUrl(null)
    setUpload({ status: 'idle' })
    uploadOwnerRef.current = null
  }

  function selectModel(next: ImageModel) {
    const definition = imageModel(next)
    if (!definition.acceptsImage) clearInputImage()
    if (!definition.acceptsMask) {
      setMaskDataUrl(null)
      setMaskEditorOpen(false)
    }
    setModelKey(next)
  }

  function handleFile(file?: File) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error('图片不能超过 20MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      const dataUrl = reader.result
      setBaseImage(dataUrl)
      setMaskDataUrl(null)
      uploadOwnerRef.current = dataUrl
      if (!health?.keyConfigured) {
        setUpload({ status: 'idle' })
        return
      }
      setUpload({ status: 'uploading' })
      void api.imageGen.uploadReference(dataUrl).then((result) => {
        if (uploadOwnerRef.current !== dataUrl) return
        setUpload('error' in result ? { status: 'error', error: result.error } : { status: 'done', url: result.url })
      }).catch((error: unknown) => {
        if (uploadOwnerRef.current !== dataUrl) return
        setUpload({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    }
    reader.onerror = () => message.error('读取图片失败')
    reader.readAsDataURL(file)
  }

  function useAsInput(url: string) {
    setBaseImage(url)
    setMaskDataUrl(null)
    setUpload({ status: 'done', url })
    uploadOwnerRef.current = url
    message.success('已设为输入图片')
  }

  async function generate() {
    if (pending.length >= 3) return
    const batchId = crypto.randomUUID()
    const reference = baseImage
      ? upload.status === 'done'
        ? upload.url
        : baseImage
      : undefined
    let request
    try {
      request = buildImageGenerationRequest({
        modelKey,
        prompt,
        batchId,
        referenceUrls: reference ? [reference] : undefined,
        maskDataUrl: maskDataUrl ?? undefined,
        output,
      })
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return
    }

    const pendingBatch: PendingBatch = {
      id: batchId,
      prompt: request.prompt,
      model: model.label,
      count: request.n,
    }
    setPending((items) => [pendingBatch, ...items])
    try {
      const results = [await api.imageGen.generate(request)]
      const error = results.find((result) => 'error' in result)
      if (error && 'error' in error) message.error(error.error)

      const successfulResults = results.filter(
        (result): result is { dataUrl: string; publicUrl: string | null; urls?: string[] } => 'dataUrl' in result,
      )
      const immediateImages = successfulResults.flatMap((result) => {
        const urls = result.urls?.length ? result.urls : result.publicUrl ? [result.publicUrl] : []
        return urls.length ? urls : [result.dataUrl]
      })
      if (immediateImages.length) {
        const now = Date.now()
        setSessionImages((items) => [
          ...immediateImages.map((url, index): SessionImage => ({
            id: `${batchId}-${index}`,
            batch_id: batchId,
            prompt: request.prompt,
            engine: request.engine,
            model: modelKey,
            provider: '本次会话',
            url,
            created_at: now + index,
            local: true,
          })),
          ...items,
        ])
      }
      if (successfulResults.some((result) => result.publicUrl || result.urls?.length)) await fetchHistory()
    } finally {
      setPending((items) => items.filter((item) => item.id !== batchId))
    }
  }

  async function deleteImage(id: string) {
    const local = sessionImages.some((item) => item.id === id)
    if (!local) {
      const result = await api.imageGen.historyDelete(id)
      if (!result.ok) {
        message.error('删除失败')
        return
      }
      setHistory((items) => items.filter((item) => item.id !== id))
    } else {
      setSessionImages((items) => items.filter((item) => item.id !== id))
    }
  }

  async function deleteBatch(batchId: string) {
    const hasRemote = history.some((item) => item.batch_id === batchId)
    if (hasRemote) {
      const result = await api.imageGen.historyDeleteBatch(batchId)
      if (!result.ok) {
        message.error('删除批次失败')
        return
      }
    }
    setHistory((items) => items.filter((item) => item.batch_id !== batchId))
    setSessionImages((items) => items.filter((item) => item.batch_id !== batchId))
  }

  async function download(url: string) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(String(response.status))
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `pi-image-${Date.now()}.${blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png'}`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
    } catch {
      await api.clipboard.writeText(url)
      message.warning('下载失败，已复制图片链接')
    }
  }

  const promptTooLong = prompt.length > IMAGE_PROMPT_MAX
  const canGenerate =
    pending.length < 3 &&
    !promptTooLong &&
    (!!prompt.trim() || (!!baseImage && model.acceptsImage)) &&
    !!health?.keyConfigured

  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <span className={styles.sectionTitle}>模型</span>
        <ImageModelSelector value={modelKey} cloudAvailable={!!health?.keyConfigured} onChange={selectModel} />
        <span className={styles.modelHint}>{model.description}</span>

        <ImageInputSection
          prompt={prompt}
          promptMax={IMAGE_PROMPT_MAX}
          acceptsImage={model.acceptsImage}
          acceptsMask={model.acceptsMask}
          baseImage={baseImage}
          maskDataUrl={maskDataUrl}
          upload={upload}
          onPromptChange={setPrompt}
          onApplyTemplate={applyStyleTemplate}
          onFile={handleFile}
          onPreview={setPreview}
          onClearImage={clearInputImage}
          onEditMask={() => setMaskEditorOpen(true)}
          onClearMask={() => setMaskDataUrl(null)}
        />

        <ImageOutputSection
          modelKey={modelKey}
          value={output}
          hasMask={!!maskDataUrl}
          onChange={(patch) => setOutput((current) => ({ ...current, ...patch }))}
        />

        {promptTooLong && (
          <div className={styles.warning}>
            提示词超出 {IMAGE_PROMPT_MAX} 字符上限（当前 {prompt.length}），请精简后再生成。
          </div>
        )}
        {!canGenerate && !promptTooLong && !health?.ok && (
          <div className={styles.warning}>当前模型服务不可用，请检查云端生图配置或刷新状态。</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip title="重新检测服务状态">
            <Button icon={<RefreshCw size={14} />} onClick={() => void refreshHealth()} />
          </Tooltip>
          <Button
            block
            type="primary"
            size="large"
            icon={<Sparkles size={15} />}
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            生成 {maskDataUrl ? 1 : output.count} 张图片
          </Button>
        </div>
      </section>

      <section className={styles.gallery} ref={galleryRef}>
        <div className={styles.galleryHead}>
          历史记录（{batches.length} 批）
          {pending.length > 0 && <span className="sub">{pending.length} 批生成中</span>}
        </div>
        {!batches.length && !pending.length && (
          <div className={styles.empty}><ImageIcon size={38} strokeWidth={1.2} />还没有生成记录</div>
        )}
        <div className={styles.rows}>
          {pending.map((item) => (
            <div key={item.id} className={styles.pending}>
              <Spin size="small" />
              <div><strong>{item.model} · 正在生成 {item.count} 张</strong><div>{item.prompt}</div></div>
            </div>
          ))}
          {batches.map((batch) => (
            <ImageHistoryBatchRow
              key={batch.id}
              batch={batch}
              tag={providerTag(batch.engine, batch.provider, batch.model)}
              time={timestampLabel(batch.createdAt)}
              canUseAsInput={model.acceptsImage}
              onPreview={setPreview}
              onDownload={(url) => void download(url)}
              onCopyPrompt={() => void api.clipboard.writeText(batch.prompt).then(() => message.success('提示词已复制'))}
              onCopyLink={(url) => void api.clipboard.writeText(url).then(() => message.success('图片链接已复制'))}
              onUseAsInput={useAsInput}
              onDeleteImage={(id) => void deleteImage(id)}
              onDeleteBatch={() => void deleteBatch(batch.id)}
            />
          ))}
        </div>
        <div ref={sentinelRef} />
        {!!batches.length && <div className={styles.load}>{loadingMore ? <Spin size="small" /> : historyDone ? '没有更多了' : ''}</div>}
      </section>

      {preview && <div className={styles.lightbox} onClick={() => setPreview(null)}><img src={preview} alt="预览" /></div>}
      {baseImage && (
        <MaskEditorComponent
          open={maskEditorOpen}
          src={baseImage}
          onCancel={() => setMaskEditorOpen(false)}
          onApply={(mask) => {
            setMaskDataUrl(mask)
            setMaskEditorOpen(false)
            setOutput((current) => ({ ...current, count: 1 }))
            message.success('蒙版已保存，局部重绘固定输出 1 张')
          }}
        />
      )}
    </div>
  )
}
