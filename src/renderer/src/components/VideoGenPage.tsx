import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Alert, App as AntApp, Button, Empty, Input, Segmented, Select, Tooltip } from 'antd'
import { Clapperboard, Copy, Download, ImagePlus, RefreshCw, X } from 'lucide-react'

import { api, type ImageGenHistoryItem, type VideoAspectRatio, type VideoGenHistoryItem, type VideoResolution } from '../lib/api'

/**
 * 视频生成(2026-10-20 加回来):首帧 + 怎么动 → 一条短视频。
 * 首帧可以从出图历史里挑(做商品图的场景图直接接着做主图视频),也可以传本地图;
 * 不给首帧就是文生视频。结果和历史都在云端,页面直接播。
 */
type Frame = { kind: 'local'; dataUrl: string } | { kind: 'cloud'; url: string } | null

const MAX_BYTES = 18 * 1024 * 1024
const PROMPT_MAX = 2000
const DURATIONS = [6, 8, 10, 12, 15]
const ASPECTS: VideoAspectRatio[] = ['9:16', '16:9', '1:1', '3:2', '2:3']
// APIMart 标价换算成人民币(USD 7.2):480p 是模型页写的;720p 暂按宁可多算的价,对账后改
const YUAN_PER_SECOND: Record<VideoResolution, number> = { '480p': 0.0102 * 7.2, '720p': 0.056 * 7.2 }

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp)(\?|$)/i.test(url)
}

export default function VideoGenPage(): React.JSX.Element {
  const { styles, cx } = useStyles()
  const { message } = AntApp.useApp()
  const fileInput = useRef<HTMLInputElement>(null)
  const [health, setHealth] = useState<{ ok: boolean; reason?: string }>()
  const [frame, setFrame] = useState<Frame>(null)
  const [recentImages, setRecentImages] = useState<ImageGenHistoryItem[]>([])
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(6)
  const [resolution, setResolution] = useState<VideoResolution>('480p')
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>('9:16')
  const [busySince, setBusySince] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [current, setCurrent] = useState<string | null>(null)
  const [history, setHistory] = useState<VideoGenHistoryItem[]>([])

  async function refresh(): Promise<void> {
    const [h, videos, images] = await Promise.all([api.videoGen.health(), api.videoGen.history(60), api.imageGen.history(24)])
    setHealth(h.ok ? { ok: true } : { ok: false, reason: h.reason })
    if (Array.isArray(videos)) setHistory(videos)
    if (Array.isArray(images)) setRecentImages(images.filter((item) => isImageUrl(item.url)).slice(0, 12))
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (busySince === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busySince])

  async function pickLocal(file?: File): Promise<void> {
    if (!file) return
    if (!file.type.startsWith('image/')) return void message.error('请选择图片文件')
    if (file.size > MAX_BYTES) return void message.error('图片需小于 18MB')
    try {
      setFrame({ kind: 'local', dataUrl: await readFileAsDataUrl(file) })
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function generate(): Promise<void> {
    setBusySince(Date.now())
    setNow(Date.now())
    try {
      const result = await api.videoGen.generate({
        prompt,
        ...(frame?.kind === 'local' ? { frameDataUrl: frame.dataUrl } : frame?.kind === 'cloud' ? { frameUrl: frame.url } : {}),
        duration,
        resolution,
        aspectRatio,
      })
      if ('error' in result) {
        message.error(`没有生成成功：${result.error}`)
        return
      }
      setCurrent(result.videoUrl)
      message.success('视频好了')
      const videos = await api.videoGen.history(60)
      if (Array.isArray(videos)) setHistory(videos)
    } finally {
      setBusySince(null)
    }
  }

  async function copy(url: string): Promise<void> {
    await api.clipboard.writeText(url)
    message.success('已复制视频链接')
  }

  async function download(url: string): Promise<void> {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(String(response.status))
      const objectUrl = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `pi-video-${Date.now()}.mp4`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
    } catch {
      await api.clipboard.writeText(url)
      message.warning('下载失败，已复制视频链接')
    }
  }

  const busy = busySince !== null
  const estimate = YUAN_PER_SECOND[resolution] * duration
  const frameSrc = frame?.kind === 'local' ? frame.dataUrl : frame?.kind === 'cloud' ? frame.url : null
  const canGenerate = !busy && health?.ok === true && prompt.trim().length > 0 && prompt.length <= PROMPT_MAX

  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <div className={styles.title}><Clapperboard size={16} /> 视频生成</div>
        {health && !health.ok && <Alert type="warning" showIcon message="现在出不了视频" description={health.reason} />}

        <div className={styles.label}>首帧（可选，不选就是文生视频）</div>
        {frameSrc ? (
          <div className={styles.framePreview}>
            <img src={frameSrc} alt="首帧" />
            <Button size="small" shape="circle" icon={<X size={14} />} className={styles.frameClear} onClick={() => setFrame(null)} title="去掉首帧" />
          </div>
        ) : (
          <Button icon={<ImagePlus size={15} />} onClick={() => fileInput.current?.click()}>上传本地图片</Button>
        )}
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => { void pickLocal(event.target.files?.[0]); event.target.value = '' }} />
        {recentImages.length > 0 && (
          <>
            <div className={styles.hint}>或者从最近出的图里挑一张：</div>
            <div className={styles.thumbs}>
              {recentImages.map((item) => (
                <Tooltip key={item.id} title={item.prompt.slice(0, 80)}>
                  <img
                    src={item.url}
                    alt=""
                    className={cx(styles.thumb, frame?.kind === 'cloud' && frame.url === item.url && styles.thumbOn)}
                    onClick={() => setFrame({ kind: 'cloud', url: item.url })}
                  />
                </Tooltip>
              ))}
            </div>
          </>
        )}

        <div className={styles.label}>画面怎么动</div>
        <Input.TextArea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          autoSize={{ minRows: 4, maxRows: 10 }}
          maxLength={PROMPT_MAX}
          showCount
          placeholder={frame ? '只写怎么动：动作、镜头，例如：镜头缓慢推近，杯口冒出热气，晨光轻轻移动' : '画面、动作、镜头，例如：一只白色保温杯放在木桌上，镜头缓慢环绕，清晨阳光'}
        />

        <div className={styles.row}>
          <div className={styles.field}>
            <span className={styles.label}>时长</span>
            <Select value={duration} onChange={setDuration} options={DURATIONS.map((value) => ({ value, label: `${value} 秒` }))} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>清晰度</span>
            <Segmented value={resolution} onChange={(value) => setResolution(value as VideoResolution)} options={[{ value: '480p', label: '480p 试效果' }, { value: '720p', label: '720p 成片' }]} />
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>画幅</span>
          <Segmented value={aspectRatio} onChange={(value) => setAspectRatio(value as VideoAspectRatio)} options={ASPECTS.map((value) => ({ value, label: value === '9:16' ? '9:16 竖屏' : value === '16:9' ? '16:9 横屏' : value }))} />
        </div>

        <div className={styles.footer}>
          <span className={styles.hint}>约 ¥{estimate.toFixed(2)}（APIMart 暂定价，待对账）</span>
          <Button type="primary" loading={busy} disabled={!canGenerate} onClick={() => void generate()}>
            {busy ? `生成中 ${clock(now - (busySince ?? now))}` : '生成视频'}
          </Button>
        </div>
        {busy && <div className={styles.hint}>一般 1–3 分钟，可以先去做别的，好了会提示。</div>}
      </section>

      <section className={styles.panel}>
        <div className={styles.titleRow}>
          <div className={styles.title}>结果和历史</div>
          <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void refresh()}>刷新</Button>
        </div>
        {current && (
          <div className={styles.current}>
            <video src={current} controls autoPlay loop className={styles.player} />
            <div className={styles.actions}>
              <Button icon={<Copy size={14} />} onClick={() => void copy(current)}>复制链接</Button>
              <Button icon={<Download size={14} />} onClick={() => void download(current)}>下载</Button>
            </div>
          </div>
        )}
        {history.length === 0 ? (
          <Empty description="还没有生成过视频" />
        ) : (
          <div className={styles.grid}>
            {history.map((item) => (
              <div key={item.id} className={styles.card}>
                <video src={item.url} controls preload="metadata" className={styles.cardVideo} />
                <div className={styles.cardPrompt} title={item.prompt}>{item.prompt}</div>
                <div className={styles.cardMeta}>
                  <span>{new Date(item.created_at).toLocaleString()}</span>
                  <span className={styles.cardActions}>
                    <Button size="small" type="text" icon={<Copy size={13} />} onClick={() => void copy(item.url)} title="复制链接" />
                    <Button size="small" type="text" icon={<Download size={13} />} onClick={() => void download(item.url)} title="下载" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
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
    gap: 12px;
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
  titleRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 120px;
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
  `,
  framePreview: css`
    position: relative;
    align-self: flex-start;
    img {
      display: block;
      max-width: 220px;
      max-height: 260px;
      border-radius: ${token.borderRadius}px;
      border: 1px solid ${token.colorBorderSecondary};
    }
  `,
  frameClear: css`
    position: absolute;
    top: 6px;
    right: 6px;
  `,
  thumbs: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
    gap: 6px;
  `,
  thumb: css`
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: ${token.borderRadiusSM}px;
    border: 2px solid transparent;
    cursor: pointer;
    &:hover { border-color: ${token.colorPrimaryBorder}; }
  `,
  thumbOn: css`
    border-color: ${token.colorPrimary};
  `,
  current: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  player: css`
    width: 100%;
    max-height: 60vh;
    background: #000;
    border-radius: ${token.borderRadius}px;
  `,
  actions: css`
    display: flex;
    gap: 8px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
  `,
  cardVideo: css`
    width: 100%;
    aspect-ratio: 9 / 16;
    object-fit: contain;
    background: #000;
    border-radius: ${token.borderRadiusSM}px;
  `,
  cardPrompt: css`
    font-size: 12px;
    color: ${token.colorText};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,
  cardMeta: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  cardActions: css`
    display: flex;
    gap: 2px;
  `,
}))
