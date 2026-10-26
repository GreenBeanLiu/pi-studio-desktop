import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
  type OnConnectEnd,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { createStyles } from 'antd-style'
import { App as AntApp, Button, Input, Select, Tooltip } from 'antd'
import { Clapperboard, Copy, Image as ImageIcon, ImagePlus, Loader2, Play, Plus, Shuffle, Type, X } from 'lucide-react'

import { api, type ImageModel, type VideoGenPayload, type VideoModelOption } from '../lib/api'
import {
  blankData,
  buildCanvasImageRequest,
  buildCanvasVideoPayload,
  canConnect,
  estimateVideoYuan,
  fitVideoOptions,
  freeSpot,
  newId,
  parseCanvas,
  serializeCanvas,
  variantOf,
  type CanvasNodeData,
  type CanvasNodeKind,
  type ImageNodeData,
  type TextNodeData,
  type VideoNodeData,
} from '../lib/canvas-graph'
import { IMAGE_MODELS, imageModel } from './image-generation-models'

/**
 * 画布(2026-10-26):生图 + 生视频摊在一张无限画布上。连线规则和请求拼装在 lib/canvas-graph.ts。
 *
 * 画布本身存在 localStorage(只存链接,图和视频在 R2);生成请求走的还是出图页 / 视频页那两条
 * IPC,结果照样进云端历史。页面在 App 里首次打开后常驻(display 切换),视频一跑十几分钟,
 * 中途切去聊天再回来结果不能丢。
 */
const STORAGE_KEY = 'pi-studio.canvas.v1'
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024
const NODE_WIDTH = 280
// 适应视图时给左上的工具栏、右下的小地图让位置,别压住节点
const FIT_VIEW: FitViewOptions = { padding: { top: '72px', left: '48px', right: '200px', bottom: '48px' } }

type CanvasNode = Node<CanvasNodeData>

type Actions = {
  patch: (id: string, patch: Partial<CanvasNodeData>) => void
  run: (id: string) => void
  variant: (id: string) => void
  remove: (id: string) => void
  copy: (url: string) => void
  videoModels: VideoModelOption[]
}
const ActionsContext = createContext<Actions | null>(null)
function useActions(): Actions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('canvas actions missing')
  return actions
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Elapsed({ since }: { since?: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span>{since ? clock(now - since) : ''}</span>
}

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    background: ${token.colorBgLayout};
  `,
  toolbar: css`
    display: flex;
    gap: 6px;
    padding: 6px;
    border-radius: 10px;
    background: ${token.colorBgElevated};
    border: 1px solid ${token.colorBorderSecondary};
    box-shadow: ${token.boxShadowTertiary};
  `,
  node: css`
    width: ${NODE_WIDTH}px;
    border-radius: 10px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorder};
    box-shadow: ${token.boxShadowTertiary};
    font-size: 12px;
    color: ${token.colorText};
    .react-flow__node.selected > & {
      border-color: ${token.colorPrimary};
      box-shadow: 0 0 0 1px ${token.colorPrimary};
    }
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    font-weight: 500;
  `,
  headerTitle: css`
    flex: 1;
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  `,
  media: css`
    width: 100%;
    max-height: 320px;
    object-fit: contain;
    border-radius: 6px;
    background: ${token.colorFillQuaternary};
    display: block;
  `,
  placeholder: css`
    height: 140px;
    border-radius: 6px;
    border: 1px dashed ${token.colorBorder};
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: ${token.colorTextTertiary};
  `,
  error: css`
    color: ${token.colorError};
    white-space: pre-wrap;
    word-break: break-all;
  `,
  row: css`
    display: flex;
    gap: 6px;
    align-items: center;
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  hint: css`
    color: ${token.colorTextTertiary};
  `,
  spin: css`
    animation: canvas-spin 1s linear infinite;
    @keyframes canvas-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  menu: css`
    position: absolute;
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border-radius: 8px;
    background: ${token.colorBgElevated};
    border: 1px solid ${token.colorBorderSecondary};
    box-shadow: ${token.boxShadowSecondary};
  `,
  empty: css`
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    color: ${token.colorTextTertiary};
    text-align: center;
    line-height: 1.8;
  `,
}))

function NodeHeader({ id, icon, title, extra }: { id: string; icon: React.ReactNode; title: string; extra?: React.ReactNode }) {
  const { styles } = useStyles()
  const { remove } = useActions()
  return (
    <div className={styles.header}>
      {icon}
      <span className={styles.headerTitle}>{title}</span>
      {extra}
      <Button size="small" type="text" icon={<X size={12} />} onClick={() => remove(id)} />
    </div>
  )
}

const TextNode = memo(function TextNode({ id, data }: NodeProps<Node<TextNodeData>>) {
  const { styles } = useStyles()
  const { patch } = useActions()
  return (
    <div className={styles.node}>
      <NodeHeader id={id} icon={<Type size={13} />} title="文本" />
      <div className={styles.body}>
        <Input.TextArea
          className="nodrag nowheel"
          autoSize={{ minRows: 3, maxRows: 12 }}
          value={data.text}
          placeholder="描述主体、风格、场景……连到图片或视频节点上当提示词"
          onChange={(e) => patch(id, { text: e.target.value })}
        />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

function RunStatus({ data }: { data: ImageNodeData | VideoNodeData }) {
  const { styles, cx } = useStyles()
  if (data.status === 'running') {
    return (
      <div className={styles.placeholder}>
        <Loader2 size={14} className={cx(styles.spin)} /> 生成中 <Elapsed since={data.startedAt} />
      </div>
    )
  }
  return null
}

const ImageNode = memo(function ImageNode({ id, data }: NodeProps<Node<ImageNodeData>>) {
  const { styles } = useStyles()
  const { patch, run, variant, copy } = useActions()
  const running = data.status === 'running'
  const model = imageModel(data.model)
  return (
    <div className={styles.node}>
      <Handle type="target" position={Position.Left} />
      <NodeHeader
        id={id}
        icon={<ImageIcon size={13} />}
        title={data.uploaded ? '图片 · 上传' : '图片'}
        extra={data.url ? <Button size="small" type="text" icon={<Copy size={12} />} title="复制链接" onClick={() => copy(data.url!)} /> : null}
      />
      <div className={styles.body}>
        {running ? (
          <RunStatus data={data} />
        ) : data.url ? (
          <img className={styles.media} src={data.url} draggable={false} />
        ) : (
          <div className={styles.placeholder}>
            <ImageIcon size={14} /> 还没生成
          </div>
        )}
        {data.error && <div className={styles.error}>{data.error}</div>}
        {!data.uploaded && (
          <>
            <Input.TextArea
              className="nodrag nowheel"
              autoSize={{ minRows: 2, maxRows: 8 }}
              value={data.prompt}
              placeholder="补充提示词（会接在上游文本后面）"
              onChange={(e) => patch(id, { prompt: e.target.value })}
            />
            <div className={styles.row}>
              <Select<ImageModel>
                className={`nodrag ${styles.grow}`}
                size="small"
                value={data.model}
                options={IMAGE_MODELS.map((m) => ({ value: m.key, label: m.label }))}
                onChange={(value) => patch(id, { model: value })}
                popupMatchSelectWidth={false}
              />
              <Tooltip title="同样的输入再出一张，放在旁边">
                <Button size="small" icon={<Shuffle size={12} />} onClick={() => variant(id)} />
              </Tooltip>
              <Button size="small" type="primary" icon={<Play size={12} />} loading={running} onClick={() => run(id)}>
                {data.url ? '重画' : '生成'}
              </Button>
            </div>
            {!model.acceptsImage && <div className={styles.hint}>{model.label} 只能文生图，接不了参考图</div>}
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const VideoNode = memo(function VideoNode({ id, data }: NodeProps<Node<VideoNodeData>>) {
  const { styles } = useStyles()
  const { patch, run, variant, copy, videoModels } = useActions()
  const running = data.status === 'running'
  const model = videoModels.find((m) => m.id === data.model) ?? videoModels[0]
  const price = estimateVideoYuan(data, model)
  return (
    <div className={styles.node}>
      <Handle type="target" position={Position.Left} />
      <NodeHeader
        id={id}
        icon={<Clapperboard size={13} />}
        title="视频"
        extra={data.url ? <Button size="small" type="text" icon={<Copy size={12} />} title="复制链接" onClick={() => copy(data.url!)} /> : null}
      />
      <div className={styles.body}>
        {running ? (
          <RunStatus data={data} />
        ) : data.url ? (
          <video className={`${styles.media} nodrag`} src={data.url} controls loop playsInline />
        ) : (
          <div className={styles.placeholder}>
            <Clapperboard size={14} /> 连一张图当首帧，或直接文生视频
          </div>
        )}
        {data.error && <div className={styles.error}>{data.error}</div>}
        <Input.TextArea
          className="nodrag nowheel"
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={data.prompt}
          placeholder="画面怎么动、镜头怎么走"
          onChange={(e) => patch(id, { prompt: e.target.value })}
        />
        {model && (
          <>
            <Select
              className="nodrag"
              size="small"
              value={model.id}
              options={videoModels.map((m) => ({ value: m.id, label: m.ok ? m.label : `${m.label}（不可用）`, disabled: !m.ok }))}
              onChange={(value) => {
                const next = videoModels.find((m) => m.id === value)
                if (next) patch(id, fitVideoOptions(data, next))
              }}
            />
            <div className={styles.row}>
              <Select
                className={`nodrag ${styles.grow}`}
                size="small"
                value={data.duration ?? model.defaults.duration}
                options={model.durations.map((d) => ({ value: d, label: `${d} 秒` }))}
                onChange={(value) => patch(id, { duration: value })}
              />
              <Select
                className={`nodrag ${styles.grow}`}
                size="small"
                value={data.resolution ?? model.defaults.resolution}
                options={model.resolutions.map((r) => ({ value: r, label: r }))}
                onChange={(value) => patch(id, { resolution: value })}
              />
              <Select
                className={`nodrag ${styles.grow}`}
                size="small"
                value={data.aspectRatio ?? model.defaults.aspectRatio}
                options={model.aspectRatios.map((r) => ({ value: r, label: r === 'adaptive' ? '跟首帧' : r }))}
                onChange={(value) => patch(id, { aspectRatio: value })}
              />
            </div>
          </>
        )}
        <div className={styles.row}>
          <span className={`${styles.hint} ${styles.grow}`}>{price != null ? `约 ¥${price.toFixed(2)}` : ''}</span>
          <Tooltip title="同样的输入再出一条">
            <Button size="small" icon={<Shuffle size={12} />} onClick={() => variant(id)} />
          </Tooltip>
          <Button size="small" type="primary" icon={<Play size={12} />} loading={running} onClick={() => run(id)}>
            {data.url ? '重拍' : '生成'}
          </Button>
        </div>
      </div>
    </div>
  )
})

const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode }

type DropMenu = { x: number; y: number; flow: { x: number; y: number }; from: string; fromKind: CanvasNodeKind }

function CanvasInner({ appearance }: { appearance: 'dark' | 'light' }): React.JSX.Element {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()
  const rf = useReactFlow<CanvasNode, Edge>()
  const wrapper = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const initial = useMemo(() => {
    try {
      return parseCanvas(localStorage.getItem(STORAGE_KEY))
    } catch {
      return null
    }
  }, [])
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>((initial?.nodes as CanvasNode[]) ?? [])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial?.edges ?? [])
  const [videoModels, setVideoModels] = useState<VideoModelOption[]>([])
  const [menu, setMenu] = useState<DropMenu | null>(null)
  const viewport = useRef(initial?.viewport)

  useEffect(() => {
    void api.videoGen.health().then((h) => setVideoModels(h.models ?? []))
  }, [])

  // 落盘节流:打字时每个字都 setNodes,存档等停下来 500ms 再写
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeCanvas({ nodes, edges, viewport: viewport.current }))
      } catch (error) {
        console.warn('canvas save failed', error)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [nodes, edges])

  const patch = useCallback(
    (id: string, change: Partial<CanvasNodeData>) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...change } as CanvasNodeData } : n)))
    },
    [setNodes],
  )

  const run = useCallback(
    async (id: string) => {
      const ns = rf.getNodes()
      const es = rf.getEdges()
      const node = ns.find((n) => n.id === id)
      if (!node || node.data.kind === 'text' || node.data.status === 'running') return
      const request = node.data.kind === 'image' ? buildCanvasImageRequest(ns, es, id, crypto.randomUUID()) : buildCanvasVideoPayload(ns, es, id)
      if ('error' in request) return patch(id, { error: request.error, status: 'error' })
      patch(id, { status: 'running', error: undefined, startedAt: Date.now() })
      // IPC 也会直接抛(网络切换时主进程报 ERR_NETWORK_CHANGED),不接住节点就永远停在"生成中"
      try {
        if (node.data.kind === 'image') {
          const result = await api.imageGen.generate(request as Parameters<typeof api.imageGen.generate>[0])
          if ('error' in result) return patch(id, { status: 'error', error: result.error, startedAt: undefined })
          patch(id, { status: 'done', url: result.urls?.[0] ?? result.publicUrl ?? result.dataUrl, startedAt: undefined })
        } else {
          const result = await api.videoGen.generate(request as VideoGenPayload)
          if ('error' in result) return patch(id, { status: 'error', error: result.error, startedAt: undefined })
          patch(id, { status: 'done', url: result.videoUrl, startedAt: undefined })
        }
      } catch (error) {
        patch(id, { status: 'error', error: error instanceof Error ? error.message : String(error), startedAt: undefined })
      }
    },
    [rf, patch],
  )

  const variant = useCallback(
    (id: string) => {
      const copy = variantOf(rf.getNodes(), rf.getEdges(), id)
      if (!copy) return
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...(copy.node as CanvasNode), selected: true }])
      setEdges((es) => [...es, ...copy.edges])
      // 新节点的入线和原节点一样,直接跑
      setTimeout(() => void run(copy.node.id), 0)
    },
    [rf, setNodes, setEdges, run],
  )

  const remove = useCallback((id: string) => void rf.deleteElements({ nodes: [{ id }] }), [rf])
  const copy = useCallback(
    (url: string) => {
      void api.clipboard.writeText(url).then(() => message.success('链接已复制'))
    },
    [message],
  )
  const actions = useMemo<Actions>(
    () => ({ patch, run: (id) => void run(id), variant, remove, copy, videoModels }),
    [patch, run, variant, remove, copy, videoModels],
  )

  const addNode = useCallback(
    (kind: CanvasNodeKind, position?: { x: number; y: number }, data?: CanvasNodeData): string => {
      const rect = wrapper.current?.getBoundingClientRect()
      const at =
        position ??
        freeSpot(
          rf.getNodes(),
          rf.screenToFlowPosition({
            x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2 - NODE_WIDTH / 2,
            y: (rect?.top ?? 0) + (rect?.height ?? 600) / 3,
          }),
          NODE_WIDTH,
        )
      const id = newId(kind)
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: kind, position: at, data: data ?? blankData(kind), selected: true }])
      return id
    },
    [rf, setNodes],
  )

  async function onUpload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      message.error('图片太大（18MB 以内）')
      return
    }
    const id = addNode('image', undefined, { ...(blankData('image') as ImageNodeData), uploaded: true, status: 'running', startedAt: Date.now() })
    try {
      const dataUrl = await readFileAsDataUrl(file)
      // 先传 R2:下游改图 / 图生视频都要公网链接,存档里也不塞 base64
      const result = await api.imageGen.uploadReference(dataUrl)
      if ('error' in result) patch(id, { status: 'error', error: result.error, startedAt: undefined })
      else patch(id, { status: 'done', url: result.url, startedAt: undefined })
    } catch (error) {
      patch(id, { status: 'error', error: error instanceof Error ? error.message : String(error), startedAt: undefined })
    }
  }

  const isValidConnection = useCallback(
    (c: Connection | Edge) => canConnect(rf.getNodes(), rf.getEdges(), c.source, c.target),
    [rf],
  )
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: newId('e') }, es)), [setEdges])

  // 从出口拖到空白处松手:弹个小菜单,选了就在松手的位置建节点并连上
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode || state.fromHandle?.type !== 'source') return
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      const rect = wrapper.current?.getBoundingClientRect()
      if (!rect) return
      const kind = (state.fromNode.data as CanvasNodeData).kind
      setMenu({
        x: point.clientX - rect.left,
        y: point.clientY - rect.top,
        flow: rf.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        from: state.fromNode.id,
        fromKind: kind,
      })
    },
    [rf],
  )

  function spawnFromMenu(kind: 'image' | 'video') {
    if (!menu) return
    const id = addNode(kind, { x: menu.flow.x, y: menu.flow.y - 40 })
    setEdges((es) => [...es, { id: newId('e'), source: menu.from, target: id }])
    setMenu(null)
  }

  return (
    <ActionsContext.Provider value={actions}>
      <div className={styles.page} ref={wrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onPaneClick={() => setMenu(null)}
          onMoveStart={() => setMenu(null)}
          onMoveEnd={(_e, vp) => {
            viewport.current = vp
          }}
          defaultViewport={initial?.viewport ?? { x: 0, y: 0, zoom: 1 }}
          defaultEdgeOptions={{ animated: false }}
          deleteKeyCode={['Backspace', 'Delete']}
          minZoom={0.1}
          maxZoom={2}
          colorMode={appearance}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
          <MiniMap pannable zoomable style={{ width: 160, height: 100 }} />
          <Panel position="top-left">
            <div className={styles.toolbar}>
              <Button size="small" icon={<Type size={13} />} onClick={() => addNode('text')}>
                文本
              </Button>
              <Button size="small" icon={<Plus size={13} />} onClick={() => addNode('image')}>
                生图
              </Button>
              <Button size="small" icon={<ImagePlus size={13} />} onClick={() => fileInput.current?.click()}>
                上传图片
              </Button>
              <Button size="small" icon={<Clapperboard size={13} />} onClick={() => addNode('video')}>
                视频
              </Button>
            </div>
          </Panel>
        </ReactFlow>
        {nodes.length === 0 && (
          <div className={styles.empty}>
            左上角加一个文本或生图节点开始
            <br />
            从节点右边的圆点拖出去，松手就能接着生图 / 生视频
          </div>
        )}
        {menu && (
          <div className={styles.menu} style={{ left: menu.x, top: menu.y }}>
            <Button size="small" type="text" icon={<ImageIcon size={13} />} onClick={() => spawnFromMenu('image')}>
              {menu.fromKind === 'image' ? '以此改图' : '生图'}
            </Button>
            <Button size="small" type="text" icon={<Clapperboard size={13} />} onClick={() => spawnFromMenu('video')}>
              {menu.fromKind === 'image' ? '当首帧生视频' : '生视频'}
            </Button>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void onUpload(file)
          }}
        />
      </div>
    </ActionsContext.Provider>
  )
}

export default function CanvasPage({ appearance }: { appearance: 'dark' | 'light' }): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner appearance={appearance} />
    </ReactFlowProvider>
  )
}
