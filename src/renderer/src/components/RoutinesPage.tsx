import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import {
  Button,
  Drawer,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Tag,
  TimePicker,
  App as AntApp,
} from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'

dayjs.extend(customParseFormat)
import {
  Box,
  CalendarClock,
  Play,
  Square,
  Pencil,
  Trash2,
  Plus,
  CheckCircle2,
  XCircle,
  Clock3,
  ArrowDown,
  ArrowUp,
  GitBranch,
  Bell,
  Bot,
  Image as ImageIcon,
  Circle,
  MinusCircle,
  Loader2,
  FileText,
  FileUp,
  ShieldCheck,
  FolderSearch,
  AppWindow,
  Shirt,
  ChevronDown,
} from 'lucide-react'
import {
  api,
  type Channel,
  type AppIconPlatform,
  type ImageGenSize,
  type Routine,
  type RoutineNotify,
  type RoutineRun,
  type RoutineStep,
  type RoutineStepType,
  type RoutineStepProgress,
  type RoutineSchedule,
  type RoutineReviewRequest,
  type Workspace,
} from '../lib/api'
import { createRoutineStepFromPreset, routineNodePresetOptions } from '../lib/routine-node-presets'
import { dressupVideoWorkflowTemplate, memeWorkflowTemplate } from '../lib/routine-workflow-templates'
import RoutineImageReferencePicker from './RoutineImageReferencePicker'

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function scheduleLabel(s: RoutineSchedule): string {
  switch (s.type) {
    case 'manual':
      return '按需（手动）'
    case 'interval':
      return `每 ${s.minutes} 分钟`
    case 'hourly':
      return `每小时 ${s.minute} 分`
    case 'daily':
      return `每天 ${s.time}`
    case 'weekly':
      return `${DAYS[s.day] ?? '?'} ${s.time}`
  }
}

const NOTIFY_LABEL: Record<RoutineNotify, string> = {
  error: '仅失败时通知',
  always: '每次都通知',
  never: '从不通知',
}

const STEP_TYPE_META: Record<RoutineStepType, { label: string; icon: typeof Bot }> = {
  agent: { label: '智能体', icon: Bot },
  'folder-input': { label: '读取素材', icon: FolderSearch },
  imagegen: { label: '生图', icon: ImageIcon },
  'app-icon': { label: '应用图标', icon: AppWindow },
  model3d: { label: '3D 生成', icon: Box },
  dressup: { label: '换装视频', icon: Shirt },
  review: { label: '人工审核', icon: ShieldCheck },
  notify: { label: '通知', icon: Bell },
  export: { label: '导出文章', icon: FileText },
  'feishu-doc': { label: '存飞书文档', icon: FileUp },
  'wechat-draft': { label: '微信公众号草稿', icon: FileText },
}

type FormState = {
  id?: string
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
  notifyChannelId?: string
  pushEachStep?: boolean
}

/** '' = 不传 size,让服务端定;其余取值与生图页保持一致。 */
const ROUTINE_IMAGE_SIZES: { value: '' | ImageGenSize; label: string }[] = [
  { value: '', label: '服务端默认' },
  { value: '1024x1024', label: '1024×1024 方' },
  { value: '1024x1536', label: '1024×1536 竖' },
  { value: '1536x1024', label: '1536×1024 横' },
  { value: '1024x1792', label: '1024×1792 长竖' },
  { value: '1792x1024', label: '1792×1024 长横' },
  { value: '512x512', label: '512×512' },
  { value: '256x256', label: '256×256' },
  { value: 'auto', label: 'auto' },
]

const createStep = (type: RoutineStepType = 'agent'): RoutineStep => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: '',
  type,
  ...(type === 'imagegen' ? { engine: 'openai' as const, imageRef: '' } : {}),
  ...(type === 'model3d' ? { imageRef: '{{prev.imageUrl}}', provider: 'tripo' as const } : {}),
  ...(type === 'dressup' ? { personRef: '', garmentRef: '', prompt: '' } : {}),
  ...(type === 'app-icon'
    ? {
        imageRef: '{{prev.imageUrl}}',
        appName: '',
        path: '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}',
        backgroundColor: '',
        platforms: ['android', 'ios', 'macos', 'windows'] as const,
      }
    : {}),
  ...(type === 'folder-input' ? { path: '' } : {}),
  ...(type === 'review' ? { message: '请检查上一步生成的内容，确认后继续。' } : {}),
  ...(type === 'export' ? { format: 'html' as const, path: '.pi-studio/articles/article-draft' } : {}),
  ...(type === 'feishu-doc'
    ? {
        message: '{{prev.output}}',
        path: '{{routine.name}} · {{trigger.time}}',
      }
    : {}),
  ...(type === 'wechat-draft'
    ? {
        message: '{{prev.output}}',
        path: '{{routine.name}} · {{trigger.time}}',
      }
    : {}),
})

function appIconWorkflowTemplate(workspacePath: string): FormState {
  return {
    ...emptyForm(workspacePath),
    name: '我的应用',
    input: '应用名称与功能，例如：FocusFlow，一款帮助独立开发者专注工作的效率应用',
    scheduleType: 'manual',
    steps: [
      {
        ...createStep('imagegen'),
        name: '应用图标母图',
        prompt:
          '为「{{routine.input}}」设计一个专业应用图标母图。1024×1024 正方形 PNG，透明背景，主体居中，四周保留约 20% 安全边距；使用一个简洁、独特、轮廓清晰的核心符号，在 16px 仍可辨认。不要预先添加圆角、外框、投影、文字、水印或设备模型。',
      },
      {
        ...createStep('review'),
        name: '确认图标方案',
        message: '请检查图标是否清晰、无文字、没有预先烘焙圆角，确认后导出四个平台资源包。',
      },
      {
        ...createStep('app-icon'),
        name: '导出四端图标包',
        imageRef: '{{steps.应用图标母图.imageUrl}}',
        appName: '',
        path: '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}',
        backgroundColor: '',
        platforms: ['android', 'ios', 'macos', 'windows'],
      },
    ],
  }
}
const emptyForm = (workspacePath: string): FormState => ({
  name: '',
  input: '',
  steps: [createStep()],
  workspacePath,
  scheduleType: 'daily',
  minutes: 60,
  minute: 0,
  time: '09:00',
  day: 1,
  notify: 'error',
})

function articleWorkflowTemplate(workspacePath: string, channels: Channel[]): FormState {
  const step = (type: RoutineStepType, name: string, extra: Partial<RoutineStep>): RoutineStep => ({
    ...createStep(type),
    name,
    ...extra,
  })
  const notifyChannelId = channels[0]?.id
  const feishuChannelId = channels.find((channel) => channel.type === 'feishu-app')?.id
  const wechatChannelId = channels.find((channel) => channel.type === 'wechat-official')?.id
  // 本地素材可选；留空时继续使用联网检索。微信草稿先落地，已配置飞书时再额外归档。
  return {
    ...emptyForm(workspacePath),
    name: '微信公众号文章生成',
    scheduleType: 'manual',
    pushEachStep: true,
    notifyChannelId,
    input: '只写文章主题即可,例如:AI 如何改变远程办公',
    steps: [
      step('folder-input', '本地素材', {
        path: '',
      }),
      step('agent', '事实梳理', {
        prompt:
          '围绕主题「{{routine.input}}」联网检索,整理 5–8 条真实、可核查的关键事实/数据/案例,' +
          '每条必须注明来源名称和完整可点击的 http(s) URL。优先吸收下面的本地素材，只输出事实清单,不要写成文章。\n\n' +
          '本地素材:\n{{steps.本地素材.output}}',
      }),
      step('agent', '写正文', {
        prompt:
          '你是资深公众号编辑。基于下面的事实清单,就主题「{{routine.input}}」写一篇 1200–2000 字的微信公众号文章:' +
          '有吸引力的标题、开头钩子、分小标题的正文、结尾金句。用 Markdown,# 作文章标题,## 作小标题。\n\n' +
          '事实清单:\n{{steps.事实梳理.output}}\n\n' +
          '文末必须增加“资料来源”小节，保留并整理事实清单中的所有完整 http(s) URL，使用 Markdown 链接格式，不要只写来源名称。',
      }),
      step('review', '人工审核正文', {
        message: '请检查正文的事实、结构和表达，确认后再生成并上传配图。',
      }),
      step('imagegen', '封面配图', {
        engine: 'openai',
        prompt:
          '为这篇微信公众号文章生成一张横版封面图(16:9),画面简洁有吸引力、贴合主题,不要文字和 Logo。\n\n' +
          '文章:{{steps.写正文.output}}',
      }),
      step('imagegen', '正文配图 1', {
        engine: 'openai',
        prompt:
          '从这篇文章中选择第一个最适合视觉化的核心分论点，生成一张微信公众号正文插图(16:9)。' +
          '画面要具体、有信息感、不要文字和 Logo，不能与封面或其它插图重复。\n\n文章:\n{{steps.写正文.output}}',
      }),
      step('imagegen', '正文配图 2', {
        engine: 'openai',
        prompt:
          '从这篇文章中选择第二个最适合视觉化的核心分论点，生成一张微信公众号正文插图(16:9)。' +
          '画面要具体、有信息感、不要文字和 Logo，不能与封面或其它插图重复。\n\n文章:\n{{steps.写正文.output}}',
      }),
      step('wechat-draft', '微信公众号草稿', {
        message: '{{steps.写正文.output}}',
        path: '{{routine.input}} · {{trigger.time}}',
        ...(wechatChannelId ? { channelId: wechatChannelId } : {}),
      }),
      ...(feishuChannelId
        ? [
            step('feishu-doc', '存飞书文档', {
              message: '{{steps.写正文.output}}',
              path: '{{routine.input}} · {{trigger.time}}',
              channelId: feishuChannelId,
            }),
          ]
        : []),
    ],
  }
}

/** 步骤在流程图里的显示状态:实时进度 > 最近一次运行结果 > 待机 */
type StepDisplayStatus = 'idle' | 'running' | 'ok' | 'error' | 'timeout' | 'cancelled' | 'skipped'

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
  `,
  col: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: 16px;
    overflow-y: auto;
  `,
  left: css`
    width: 35%;
    min-width: 340px;
    flex-shrink: 0;
  `,
  right: css`
    flex: 1;
    min-width: 0;
  `,
  colTitle: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    line-height: 22px;
    font-weight: 500;
    color: ${token.colorText};
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.6;
  `,
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  cardClickable: css`
    cursor: pointer;
    transition: border-color 0.2s;

    &:hover {
      border-color: ${token.colorPrimaryBorderHover};
    }
  `,
  cardSelected: css`
    border-color: ${token.colorPrimary};
  `,
  cardHead: css`
    display: flex;
    align-items: center;
    gap: 8px;

    .name {
      flex: 1;
      font-weight: 600;
      color: ${token.colorText};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  cardMeta: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    flex-wrap: wrap;
  `,
  formRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,

  /* ── 流程图 ── */
  flow: css`
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  `,
  node: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  nodeRunning: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 3px ${token.colorPrimaryBg};
  `,
  nodeOk: css`
    border-color: ${token.colorSuccessBorder};
  `,
  nodeError: css`
    border-color: ${token.colorErrorBorder};
  `,
  nodeTimeout: css`
    border-color: ${token.colorWarningBorder};
  `,
  nodeSkipped: css`
    border-style: dashed;
    opacity: 0.65;
  `,
  nodeHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: ${token.colorText};
    font-size: 13px;

    .sname {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dur {
      font-weight: 400;
      font-size: 12px;
      color: ${token.colorTextTertiary};
    }
  `,
  nodeSub: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  nodePrompt: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,
  nodeSummary: css`
    font-size: 12.5px;
    line-height: 1.7;
    color: ${token.colorTextSecondary};
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 8px 10px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 150px;
    overflow-y: auto;
  `,
  nodeImage: css`
    max-width: 260px;
    max-height: 200px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    object-fit: cover;
  `,
  nodeErrText: css`
    font-size: 12.5px;
    color: ${token.colorError};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  connector: css`
    align-self: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    color: ${token.colorTextQuaternary};
    padding: 2px 0;

    .line {
      width: 2px;
      height: 12px;
      background: ${token.colorBorder};
    }
    svg {
      margin-top: -3px;
    }
  `,
  spin: css`
    animation: routine-spin 1s linear infinite;

    @keyframes routine-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `,
  lastRun: css`
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: ${token.colorTextTertiary};
    flex-wrap: wrap;
  `,
}))

export default function RoutinesPage({ workspace }: { workspace: Workspace | null }) {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [routineState, setRoutineState] = useState<{
    runningIds: string[]
    waitingIds: string[]
    cancellingIds: string[]
    queuedIds: string[]
    progress?: RoutineStepProgress[]
  }>({ runningIds: [], waitingIds: [], cancellingIds: [], queuedIds: [] })
  const [channels, setChannels] = useState<Channel[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stepProgress, setStepProgress] = useState<Record<string, Record<string, RoutineStepProgress['status']>>>({})
  const [reviewRequests, setReviewRequests] = useState<RoutineReviewRequest[]>([])
  const [reviewComment, setReviewComment] = useState('')
  const reviewRequest = reviewRequests[0] ?? null

  async function refresh() {
    const data = await api.routines.list()
    const state = await api.routines.state()
    setRoutines(data.routines)
    setRuns(data.runs)
    setRoutineState(state)
    setReviewRequests(state.pendingReviews)
    setStepProgress(
      (state.progress ?? []).reduce<Record<string, Record<string, RoutineStepProgress['status']>>>((acc, item) => {
        acc[item.routineId] = {
          ...acc[item.routineId],
          [item.stepId]: item.status,
        }
        return acc
      }, {}),
    )
    const activeId = [...state.runningIds, ...state.queuedIds][0]
    if (activeId) {
      setSelectedId((current) =>
        current && data.routines.some((routine) => routine.id === current) ? current : activeId,
      )
    }
  }

  useEffect(() => {
    refresh()
    api.channels
      .list()
      .then(setChannels)
      .catch(() => {})
    const offRun = api.routines.onRunFinished((run) => {
      setRuns((prev) => [run, ...prev].slice(0, 100))
      setRoutineState((prev) => ({
        runningIds: prev.runningIds.filter((id) => id !== run.routineId),
        waitingIds: prev.waitingIds.filter((id) => id !== run.routineId),
        cancellingIds: prev.cancellingIds.filter((id) => id !== run.routineId),
        queuedIds: prev.queuedIds.filter((id) => id !== run.routineId),
        progress: prev.progress?.filter((item) => item.routineId !== run.routineId),
      }))
      // 跑完后用 run 里的每步结果显示,清掉实时进度
      setStepProgress((prev) => {
        const next = { ...prev }
        delete next[run.routineId]
        return next
      })
    })
    const offStep = api.routines.onStepProgress((p) => {
      setRoutineState((prev) => ({
        runningIds: prev.runningIds.includes(p.routineId) ? prev.runningIds : [...prev.runningIds, p.routineId],
        queuedIds: prev.queuedIds.filter((id) => id !== p.routineId),
        waitingIds: prev.waitingIds,
        cancellingIds: prev.cancellingIds,
        progress: [...(prev.progress ?? []).filter((item) => item.stepId !== p.stepId), p],
      }))
      setStepProgress((prev) => ({
        ...prev,
        [p.routineId]: { ...prev[p.routineId], [p.stepId]: p.status },
      }))
    })
    const offReview = api.routines.onReviewRequested((request) => {
      setReviewRequests((current) =>
        current.some((item) => item.reviewId === request.reviewId) ? current : [...current, request],
      )
      setRoutineState((current) => ({
        ...current,
        waitingIds: current.waitingIds.includes(request.routineId)
          ? current.waitingIds
          : [...current.waitingIds, request.routineId],
      }))
    })
    const offReviewCancelled = api.routines.onReviewCancelled(({ reviewId, routineId, reason }) => {
      setReviewRequests((current) => current.filter((item) => item.reviewId !== reviewId))
      setRoutineState((current) => ({
        ...current,
        waitingIds: current.waitingIds.filter((id) => id !== routineId),
      }))
      setReviewComment('')
      message.warning(reason)
    })
    return () => {
      offRun()
      offStep()
      offReview()
      offReviewCancelled()
    }
  }, [])

  async function respondToReview(decision: 'approve' | 'reject') {
    if (!reviewRequest) return
    const result = await api.routines.reviewRespond(reviewRequest.reviewId, decision, reviewComment)
    if ('error' in result) {
      setReviewRequests((current) => current.filter((item) => item.reviewId !== reviewRequest.reviewId))
      setReviewComment('')
      setRoutineState((current) => ({
        ...current,
        waitingIds: current.waitingIds.filter((id) => id !== reviewRequest.routineId),
      }))
      message.error(result.error)
      return
    }
    setReviewRequests((current) => current.filter((item) => item.reviewId !== reviewRequest.reviewId))
    setRoutineState((current) => ({
      ...current,
      waitingIds: current.waitingIds.filter((id) => id !== reviewRequest.routineId),
    }))
    setReviewComment('')
    message.info(decision === 'approve' ? '审核通过，工作流继续执行' : '审核已拒绝，工作流将停止')
  }

  function buildSchedule(f: FormState): RoutineSchedule {
    switch (f.scheduleType) {
      case 'manual':
        return { type: 'manual' }
      case 'interval':
        return { type: 'interval', minutes: Math.max(5, f.minutes) }
      case 'hourly':
        return { type: 'hourly', minute: Math.min(59, Math.max(0, f.minute)) }
      case 'daily':
        return { type: 'daily', time: f.time }
      case 'weekly':
        return { type: 'weekly', day: f.day, time: f.time }
    }
  }

  const stepComplete = (s: RoutineStep): boolean =>
    !!s.name.trim() &&
    (s.type === 'notify'
      ? !!s.channelId
      : s.type === 'dressup'
        ? !!s.personRef?.trim() && !!s.garmentRef?.trim()
        : s.type === 'folder-input' ||
            s.type === 'review' ||
            s.type === 'export' ||
            s.type === 'feishu-doc' ||
            s.type === 'wechat-draft' ||
            s.type === 'app-icon' ||
            s.type === 'model3d'
          ? true
          : !!s.prompt?.trim())

  async function saveForm() {
    if (!form) return
    const steps = form.steps.filter(stepComplete)
    if (!form.name.trim() || !form.workspacePath.trim() || steps.length === 0) {
      message.warning('需要名称、工作区,以及至少一个完整的步骤(通知步骤要选渠道,其余要填提示词)')
      return
    }
    const next = await api.routines.save({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      input: form.input.trim(),
      steps,
      workspacePath: form.workspacePath.trim(),
      schedule: buildSchedule(form),
      notify: form.notify,
      ...(form.notifyChannelId ? { notifyChannelId: form.notifyChannelId } : {}),
      ...(form.pushEachStep ? { pushEachStep: true } : {}),
    })
    setRoutines(next)
    setForm(null)
    message.success('Saved')
  }

  function updateStep(id: string, patch: Partial<RoutineStep>) {
    if (!form) return
    setForm({
      ...form,
      steps: form.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    })
  }

  function changeStepType(id: string, type: RoutineStepType) {
    if (!form) return
    setForm({
      ...form,
      steps: form.steps.map((step) => {
        if (step.id !== id) return step
        return {
          id: step.id,
          name: step.name,
          type,
          ...(type !== 'notify' && type !== 'folder-input' ? { prompt: step.prompt ?? '' } : {}),
          ...(type === 'folder-input' ? { path: step.path ?? '' } : {}),
          ...(type === 'imagegen'
            ? {
                engine: step.engine ?? ('openai' as const),
                imageRef: step.imageRef ?? '',
                ...(step.size ? { size: step.size } : {}),
              }
            : {}),
          ...(type === 'model3d'
            ? {
                imageRef: step.imageRef ?? '{{prev.imageUrl}}',
                provider: step.provider ?? ('tripo' as const),
              }
            : {}),
          ...(type === 'dressup'
            ? {
                personRef: step.personRef ?? '',
                garmentRef: step.garmentRef ?? '',
                prompt: step.prompt ?? '',
              }
            : {}),
          ...(type === 'app-icon'
            ? {
                imageRef: step.imageRef ?? '{{prev.imageUrl}}',
                appName: step.appName ?? '',
                path: step.path ?? '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}',
                backgroundColor: step.backgroundColor ?? '',
                platforms: step.platforms ?? ['android', 'ios', 'macos', 'windows'],
              }
            : {}),
          ...(type === 'notify'
            ? {
                channelId: step.channelId ?? channels[0]?.id,
                message: step.message ?? '',
              }
            : {}),
          ...(type === 'review'
            ? {
                message: step.message ?? '请检查上一步生成的内容，确认后继续。',
              }
            : {}),
          ...(type === 'export'
            ? {
                path: step.path ?? '.pi-studio/articles/article-draft',
                format: step.format ?? ('html' as const),
              }
            : {}),
          ...(type === 'feishu-doc'
            ? {
                message: step.message ?? '{{prev.output}}',
                path: step.path ?? '{{routine.name}} · {{trigger.time}}',
                channelId: step.channelId,
              }
            : {}),
          ...(type === 'wechat-draft'
            ? {
                message: step.message ?? '{{prev.output}}',
                path: step.path ?? '{{routine.input}} · {{trigger.time}}',
                channelId: step.channelId,
              }
            : {}),
        }
      }),
    })
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!form) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= form.steps.length) return
    const steps = [...form.steps]
    ;[steps[index], steps[nextIndex]] = [steps[nextIndex], steps[index]]
    setForm({ ...form, steps })
  }

  function deleteStep(id: string) {
    if (!form) return
    setForm({ ...form, steps: form.steps.filter((step) => step.id !== id) })
  }

  function editRoutine(r: Routine) {
    setForm({
      id: r.id,
      name: r.name,
      input: r.input ?? '',
      steps: r.steps?.length ? r.steps.map((s) => ({ ...s })) : [createStep()],
      workspacePath: r.workspacePath,
      scheduleType: r.schedule.type,
      minutes: r.schedule.type === 'interval' ? r.schedule.minutes : 60,
      minute: r.schedule.type === 'hourly' ? r.schedule.minute : 0,
      time: 'time' in r.schedule ? r.schedule.time : '09:00',
      day: r.schedule.type === 'weekly' ? r.schedule.day : 1,
      notify: r.notify,
      notifyChannelId: r.notifyChannelId,
      pushEachStep: r.pushEachStep,
    })
  }

  async function runNow(r: Routine) {
    const res = await api.routines.runNow(r.id)
    if ('error' in res) {
      message.error(res.error)
      return
    }
    setSelectedId(r.id)
    setRoutineState((prev) => ({
      ...prev,
      runningIds: prev.runningIds.includes(r.id) ? prev.runningIds : [...prev.runningIds, r.id],
    }))
    message.info(`「${r.name}」开始执行,右侧流程图会实时显示进度`)
  }

  async function cancelRun(r: Routine) {
    const res = await api.routines.cancel(r.id)
    if ('error' in res) {
      message.error(res.error)
      return
    }
    setRoutineState((prev) => ({
      ...prev,
      cancellingIds: prev.runningIds.includes(r.id) ? [...new Set([...prev.cancellingIds, r.id])] : prev.cancellingIds,
      queuedIds: prev.queuedIds.filter((id) => id !== r.id),
    }))
    setTimeout(() => {
      void api.routines.state().then(setRoutineState).catch(() => {})
    }, 5_250)
    message.info(`正在停止「${r.name}」`)
  }

  const statusIcon = (s: RoutineRun['status']) =>
    s === 'ok' ? (
      <CheckCircle2 size={14} color="#4ade80" />
    ) : s === 'timeout' ? (
      <Clock3 size={14} color="#fbbf24" />
    ) : (
      <XCircle size={14} color="#f87171" />
    )

  const selected = routines.find((r) => r.id === selectedId) ?? routines[0] ?? null
  const latestRun = selected ? runs.find((run) => run.routineId === selected.id) : undefined
  const liveProgress = selected ? stepProgress[selected.id] : undefined
  const activeIds = [...routineState.runningIds, ...routineState.queuedIds]
  const selectedRunning = selected ? routineState.runningIds.includes(selected.id) : false
  const selectedQueued = selected ? routineState.queuedIds.includes(selected.id) : false
  const selectedActive = selectedRunning || selectedQueued

  function stepDisplay(step: RoutineStep): {
    status: StepDisplayStatus
    summary?: string
    imageUrl?: string
    durationMs?: number
  } {
    const live = liveProgress?.[step.id]
    if (live) return { status: live }
    // 正在执行但还没轮到的步骤不显示上一次的旧结果
    if (selectedActive) return { status: 'idle' }
    const past = latestRun?.steps?.find((s) => s.id === step.id)
    if (past) {
      return {
        status: past.status,
        summary: past.summary,
        imageUrl: past.imageUrl,
        durationMs: past.durationMs,
      }
    }
    return { status: 'idle' }
  }

  const stepIcon = (status: StepDisplayStatus) => {
    switch (status) {
      case 'running':
        return <Loader2 size={14} className={styles.spin} color="#60a5fa" />
      case 'ok':
        return <CheckCircle2 size={14} color="#4ade80" />
      case 'error':
        return <XCircle size={14} color="#f87171" />
      case 'timeout':
        return <Clock3 size={14} color="#fbbf24" />
      case 'cancelled':
        return <MinusCircle size={14} color="#f87171" />
      case 'skipped':
        return <MinusCircle size={14} color="#9ca3af" />
      default:
        return <Circle size={14} color="#9ca3af" />
    }
  }

  const nodeClass = (status: StepDisplayStatus) =>
    cx(
      styles.node,
      status === 'running' && styles.nodeRunning,
      status === 'ok' && styles.nodeOk,
      status === 'error' && styles.nodeError,
      status === 'timeout' && styles.nodeTimeout,
      status === 'cancelled' && styles.nodeError,
      status === 'skipped' && styles.nodeSkipped,
    )

  const connector = (key: string) => (
    <div key={key} className={styles.connector}>
      <div className="line" />
      <ArrowDown size={12} />
    </div>
  )

  const channelName = (id?: string): string => channels.find((c) => c.id === id)?.name ?? '(渠道已删除)'

  const stepTypeOptions = (Object.keys(STEP_TYPE_META) as RoutineStepType[]).map((t) => ({
    value: t,
    label: STEP_TYPE_META[t].label,
  }))

  function addPresetStep(presetId: string) {
    if (!form) return
    const step = createRoutineStepFromPreset(presetId, channels[0]?.id)
    if (!step) return
    setForm({ ...form, steps: [...form.steps, step] })
  }

  const nodeMenu = {
    items: routineNodePresetOptions().map((preset) => ({
      key: preset.key,
      label: (
        <div>
          <div>{preset.label}</div>
          <div style={{ fontSize: 11, opacity: 0.65 }}>{preset.description}</div>
        </div>
      ),
    })),
    onClick: ({ key }: { key: string }) => addPresetStep(key),
  }

  const templateMenu = {
    items: [
      { key: 'article', label: '文章模板' },
      { key: 'app-icon', label: '图标模板' },
      { key: 'dressup', label: '换装模板' },
      { key: 'meme', label: '表情包模板' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'article') setForm(articleWorkflowTemplate(workspace?.path ?? '', channels))
      if (key === 'app-icon') setForm(appIconWorkflowTemplate(workspace?.path ?? ''))
      if (key === 'dressup') setForm(dressupVideoWorkflowTemplate(workspace?.path ?? ''))
      if (key === 'meme') setForm(memeWorkflowTemplate(workspace?.path ?? ''))
    },
  }

  return (
    <>
      <div className={styles.page}>
        <section className={`${styles.col} ${styles.left}`}>
          <div className={styles.colTitle}>
            <CalendarClock size={16} />
            例程 ({routines.length})
            {activeIds.length > 0 && (
              <Tag color="processing" style={{ marginLeft: 8 }}>
                正在运行 {activeIds.length}
              </Tag>
            )}
            <div style={{ flex: 1 }} />
            <Button
              size="small"
              type="primary"
              icon={<Plus size={13} />}
              onClick={() => setForm(emptyForm(workspace?.path ?? ''))}
            >
              新建
            </Button>
            <Dropdown menu={templateMenu} trigger={['click']}>
              <Button size="small" icon={<ChevronDown size={13} />}>模板</Button>
            </Dropdown>
          </div>

          {form && (
            <Drawer
              title={form.id ? '编辑例程' : '新建例程'}
              open
              placement="right"
              width={560}
              destroyOnClose
              onClose={() => setForm(null)}
            >
              <div className={styles.card}>
                <span className={styles.label}>Name</span>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例程名称"
                />
                <span className={styles.label}>本次选题 / Brief</span>
                <Input.TextArea
                  value={form.input}
                  onChange={(e) => setForm({ ...form, input: e.target.value })}
                  placeholder="例如：面向独立开发者，解释 AI 编程工具如何减少重复劳动，并给出 3 个实践建议"
                  autoSize={{ minRows: 3, maxRows: 7 }}
                />
                <span className={styles.label}>{`步骤 (${form.steps.length})`}</span>
                <span className={styles.hint}>
                  {
                    '从节点库添加资料、写作、审校、封面、导出和通知节点；节点间传值:{{prev.output}} 上一步输出、{{steps.步骤名.output}} 任意步骤输出、{{steps.步骤名.imageUrl}} 生图链接。'
                  }
                </span>
                {form.steps.map((step, index) => (
                  <div key={step.id} className={styles.card} style={{ padding: 10 }}>
                    <div className={styles.formRow}>
                      <Select
                        value={step.type}
                        onChange={(v) => changeStepType(step.id, v)}
                        style={{ width: 96, flexShrink: 0 }}
                        options={stepTypeOptions}
                      />
                      <Input
                        value={step.name}
                        onChange={(e) => updateStep(step.id, { name: e.target.value })}
                        placeholder="Step name"
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<ArrowUp size={13} />}
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<ArrowDown size={13} />}
                        disabled={index === form.steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      />
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<Trash2 size={13} />}
                        disabled={form.steps.length === 1}
                        onClick={() => deleteStep(step.id)}
                      />
                    </div>
                    {step.type !== 'notify' &&
                      step.type !== 'export' &&
                      step.type !== 'review' &&
                      step.type !== 'feishu-doc' &&
                      step.type !== 'wechat-draft' &&
                      step.type !== 'app-icon' &&
                      step.type !== 'folder-input' && (
                        <Input.TextArea
                          value={step.prompt ?? ''}
                          onChange={(e) => updateStep(step.id, { prompt: e.target.value })}
                          placeholder={
                            step.type === 'imagegen'
                              ? '画什么(支持 {{prev.output}} 等变量)'
                              : step.type === 'model3d'
                                ? '文字描述(有上游图片时可留空 → 走图生 3D)'
                                : step.type === 'dressup'
                                  ? '可选：补充试衣与视频动作要求'
                                  : 'Instruction for this node'
                          }
                          autoSize={{ minRows: 3, maxRows: 8 }}
                        />
                      )}
                    {step.type === 'folder-input' && (
                      <>
                        <Input
                          value={step.path ?? ''}
                          onChange={(e) => updateStep(step.id, { path: e.target.value })}
                          placeholder="例如 materials（留空则跳过本地素材）"
                          addonBefore="工作区文件夹"
                        />
                        <span className={styles.hint}>
                          递归读取文本、Markdown、HTML、CSV、JSON、YAML 和常见图片；路径必须位于当前工作区内。
                        </span>
                      </>
                    )}
                    {step.type === 'imagegen' && (
                      <>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>引擎</span>
                          <Select
                            value={step.engine ?? 'openai'}
                            onChange={(v) => updateStep(step.id, { engine: v })}
                            style={{ width: 200 }}
                            options={[{ value: 'openai', label: '云端 gpt-image-2' }]}
                          />
                          <span className={styles.hint}>尺寸</span>
                          <Select<'' | ImageGenSize>
                            value={step.size ?? ''}
                            onChange={(v) => updateStep(step.id, { size: v || undefined })}
                            style={{ width: 160 }}
                            options={ROUTINE_IMAGE_SIZES}
                          />
                        </div>
                        <RoutineImageReferencePicker
                          label="参考图"
                          title="选择参考图"
                          value={step.imageRef ?? ''}
                          placeholder="留空即文生图；可填 {{prev.imageUrl}}、工作区路径或图片 URL"
                          onChange={(imageRef) => updateStep(step.id, { imageRef })}
                        />
                        <span className={styles.hint}>
                          填了参考图就是照着改，不是从零画；接在上一个生图节点后用 {'{{prev.imageUrl}}'} 即可。
                        </span>
                      </>
                    )}
                    {step.type === 'model3d' && (
                      <>
                        <Input
                          value={step.imageRef ?? '{{prev.imageUrl}}'}
                          onChange={(e) => updateStep(step.id, { imageRef: e.target.value })}
                          addonBefore="输入图"
                          placeholder="{{prev.imageUrl}}(解析为图 URL 则图生 3D,否则用上面文字文生 3D)"
                        />
                        <span className={styles.hint}>Tripo · 支持文生和图生 3D</span>
                        <span className={styles.hint}>
                          接在「生图」节点后即可图生 3D;glb 存到工作区 .pi-studio/models/
                        </span>
                      </>
                    )}
                    {step.type === 'dressup' && (
                      <>
                        <RoutineImageReferencePicker
                          label="人物图"
                          title="选择人物图"
                          value={step.personRef ?? ''}
                          placeholder="工作区路径、图片 URL 或 {{prev.imageUrl}}"
                          onChange={(personRef) => updateStep(step.id, { personRef })}
                        />
                        <RoutineImageReferencePicker
                          label="服装图"
                          title="选择服装图"
                          value={step.garmentRef ?? ''}
                          placeholder="工作区路径、图片 URL 或上游变量"
                          onChange={(garmentRef) => updateStep(step.id, { garmentRef })}
                        />
                        <span className={styles.hint}>
                          可先在左侧“生图”中批量生成人物或服装，再从生成记录中选择；也可继续填写路径或 URL。 执行 AI
                          试衣后调用 Kling 生成换装视频，本地 MP4 会作为工作流产物保存。
                        </span>
                      </>
                    )}
                    {step.type === 'app-icon' && (
                      <>
                        <Input
                          value={step.imageRef ?? '{{prev.imageUrl}}'}
                          onChange={(e) => updateStep(step.id, { imageRef: e.target.value })}
                          addonBefore="母图"
                          placeholder="{{prev.imageUrl}} 或工作区内的图片路径"
                        />
                        <Input
                          value={step.appName ?? ''}
                          onChange={(e) => updateStep(step.id, { appName: e.target.value })}
                          addonBefore="应用名"
                          placeholder="可选；留空则不写入假名称"
                        />
                        <Input
                          value={step.path ?? ''}
                          onChange={(e) => updateStep(step.id, { path: e.target.value })}
                          addonBefore="输出目录"
                          placeholder=".pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}"
                        />
                        <Input
                          value={step.backgroundColor ?? ''}
                          onChange={(e) =>
                            updateStep(step.id, {
                              backgroundColor: e.target.value,
                            })
                          }
                          addonBefore="品牌底色"
                          placeholder="留空则从母图边缘自动采样"
                        />
                        <div className={styles.formRow}>
                          <span className={styles.hint}>平台</span>
                          <Select
                            mode="multiple"
                            value={step.platforms ?? ['android', 'ios', 'macos', 'windows']}
                            onChange={(platforms) =>
                              updateStep(step.id, {
                                platforms: platforms as AppIconPlatform[],
                              })
                            }
                            style={{ flex: 1 }}
                            options={[
                              { value: 'android', label: 'Android' },
                              { value: 'ios', label: 'iOS / iPadOS' },
                              { value: 'macos', label: 'macOS' },
                              { value: 'windows', label: 'Windows' },
                            ]}
                          />
                        </div>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>保留最近</span>
                          <InputNumber
                            value={step.keepHistory ?? null}
                            onChange={(value) =>
                              updateStep(step.id, { keepHistory: value ?? undefined })
                            }
                            min={1}
                            max={999}
                            precision={0}
                            placeholder="留空 = 全部保留"
                            addonAfter="次"
                            style={{ flex: 1 }}
                          />
                        </div>
                        <span className={styles.hint}>
                          母图至少 1024×1024；输出目录须位于 .pi-studio/app-icons/ 的独立子目录。可用{' '}
                          {'{{trigger.stamp}}'} 让每次生成各占一个目录；目录重名时会自动顺延 -2、-3，不会覆盖上一次的结果。
                          填了「保留最近 N 次」就只留最新的 N 次，更旧的连同 .zip
                          一起删掉（只删本工作流自己生成、带 pi-studio manifest 的目录）。导出 Android
                          自适应资源、Xcode Asset Catalog、macOS iconset / Icon Composer 图层和 Windows ICO。
                        </span>
                      </>
                    )}
                    {step.type === 'notify' && (
                      <>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>渠道</span>
                          <Select
                            value={step.channelId}
                            onChange={(v) => updateStep(step.id, { channelId: v })}
                            style={{ flex: 1 }}
                            placeholder={channels.length ? '选择通知渠道' : '先去 设置→通知渠道 添加'}
                            options={channels.map((c) => ({
                              value: c.id,
                              label: c.name,
                            }))}
                          />
                        </div>
                        <Input.TextArea
                          value={step.message ?? ''}
                          onChange={(e) => updateStep(step.id, { message: e.target.value })}
                          placeholder={'发什么(支持 {{prev.output}} 等变量,留空 = 上一步输出)'}
                          autoSize={{ minRows: 2, maxRows: 6 }}
                        />
                      </>
                    )}
                    {step.type === 'export' && (
                      <>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>格式</span>
                          <Select
                            value={step.format ?? 'html'}
                            onChange={(v) => updateStep(step.id, { format: v })}
                            style={{ width: 160 }}
                            options={[
                              { value: 'html', label: '公众号 HTML' },
                              { value: 'markdown', label: 'Markdown' },
                            ]}
                          />
                        </div>
                        <Input
                          value={step.path ?? ''}
                          onChange={(e) => updateStep(step.id, { path: e.target.value })}
                          placeholder=".pi-studio/articles/article-draft"
                          addonBefore="文件"
                        />
                        <span className={styles.hint}>
                          只能写入工作区内的相对路径；HTML 会把上一步 Markdown 转成公众号正文片段。
                        </span>
                      </>
                    )}
                    {step.type === 'review' && (
                      <Input.TextArea
                        value={step.message ?? ''}
                        onChange={(e) => updateStep(step.id, { message: e.target.value })}
                        placeholder="审核提示"
                        autoSize={{ minRows: 2, maxRows: 4 }}
                      />
                    )}
                    {step.type === 'feishu-doc' && (
                      <>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>飞书应用</span>
                          <Select
                            value={step.channelId}
                            onChange={(v) => updateStep(step.id, { channelId: v })}
                            style={{ flex: 1 }}
                            allowClear
                            placeholder="自动选第一个「飞书应用」渠道"
                            options={channels
                              .filter((c) => c.type === 'feishu-app')
                              .map((c) => ({ value: c.id, label: c.name }))}
                          />
                        </div>
                        <Input
                          value={step.path ?? ''}
                          onChange={(e) => updateStep(step.id, { path: e.target.value })}
                          placeholder="{{routine.name}} · {{trigger.time}}"
                          addonBefore="标题"
                        />
                        <Input.TextArea
                          value={step.message ?? ''}
                          onChange={(e) => updateStep(step.id, { message: e.target.value })}
                          placeholder={'写入正文(支持 {{…}} 变量,留空 = 上一步输出)'}
                          autoSize={{ minRows: 2, maxRows: 6 }}
                        />
                        <span className={styles.hint}>
                          需要「飞书应用」渠道且应用开通 docx:document 权限;在飞书里建个文件夹分享给应用,把 folder_token
                          填到渠道设置,文档就会存到你能看到的地方。配图节点会按正文段落分布插入文档内部。
                        </span>
                      </>
                    )}
                    {step.type === 'wechat-draft' && (
                      <>
                        <div className={styles.formRow}>
                          <span className={styles.hint}>微信公众号</span>
                          <Select
                            value={step.channelId}
                            onChange={(v) => updateStep(step.id, { channelId: v })}
                            style={{ flex: 1 }}
                            allowClear
                            placeholder="自动选第一个「微信公众号」渠道"
                            options={channels
                              .filter((c) => c.type === 'wechat-official')
                              .map((c) => ({ value: c.id, label: c.name }))}
                          />
                        </div>
                        <Input
                          value={step.path ?? ''}
                          onChange={(e) => updateStep(step.id, { path: e.target.value })}
                          placeholder="{{routine.input}} · {{trigger.time}}"
                          addonBefore="标题"
                        />
                        <Input.TextArea
                          value={step.message ?? ''}
                          onChange={(e) => updateStep(step.id, { message: e.target.value })}
                          placeholder="写入正文(支持 {{…}} 变量,留空 = 上一步输出)"
                          autoSize={{ minRows: 2, maxRows: 6 }}
                        />
                        <span className={styles.hint}>
                          只创建微信公众号草稿，不会自动群发；素材文件夹和生图节点里的图片都会上传微信。名称含“封面”或
                          cover 的图片优先作为封面，其余作为正文插图。
                        </span>
                      </>
                    )}
                  </div>
                ))}
                <Dropdown menu={nodeMenu} trigger={['click']}>
                  <Button size="small" type="dashed" icon={<Plus size={13} />}>
                    添加节点
                  </Button>
                </Dropdown>
                <span className={styles.label}>工作区(agent 的运行目录)</span>
                <div className={styles.formRow}>
                  <Input
                    value={form.workspacePath}
                    onChange={(e) => setForm({ ...form, workspacePath: e.target.value })}
                    placeholder="D:\\Works"
                  />
                  {workspace && (
                    <Button size="small" onClick={() => setForm({ ...form, workspacePath: workspace.path })}>
                      用当前
                    </Button>
                  )}
                </div>
                <span className={styles.label}>触发方式</span>
                <div className={styles.formRow}>
                  <Select
                    value={form.scheduleType}
                    onChange={(v) => setForm({ ...form, scheduleType: v })}
                    style={{ width: 130 }}
                    options={[
                      { value: 'manual', label: '按需（手动）' },
                      { value: 'daily', label: '每天' },
                      { value: 'weekly', label: '每周' },
                      { value: 'hourly', label: '每小时' },
                      { value: 'interval', label: '按间隔' },
                    ]}
                  />
                  {form.scheduleType === 'manual' && (
                    <span className={styles.hint}>不定时触发,准备好后点卡片上的「运行」开始</span>
                  )}
                  {form.scheduleType === 'weekly' && (
                    <Select
                      value={form.day}
                      onChange={(v) => setForm({ ...form, day: v })}
                      style={{ width: 90 }}
                      options={DAYS.map((d, i) => ({ value: i, label: d }))}
                    />
                  )}
                  {(form.scheduleType === 'daily' || form.scheduleType === 'weekly') && (
                    <TimePicker
                      value={dayjs(form.time, 'HH:mm')}
                      format="HH:mm"
                      onChange={(v) => v && setForm({ ...form, time: v.format('HH:mm') })}
                      allowClear={false}
                    />
                  )}
                  {form.scheduleType === 'hourly' && (
                    <Input
                      type="number"
                      style={{ width: 90 }}
                      value={form.minute}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          minute: Number(e.target.value) || 0,
                        })
                      }
                      suffix="分"
                    />
                  )}
                  {form.scheduleType === 'interval' && (
                    <Input
                      type="number"
                      style={{ width: 110 }}
                      value={form.minutes}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          minutes: Number(e.target.value) || 60,
                        })
                      }
                      suffix="分钟"
                    />
                  )}
                </div>
                <span className={styles.label}>兜底通知(跑完汇总一张卡片,与流程里的通知节点独立)</span>
                <div className={styles.formRow}>
                  <Select
                    value={form.notify}
                    onChange={(v) => setForm({ ...form, notify: v })}
                    style={{ width: 140 }}
                    options={[
                      { value: 'error', label: '仅失败时通知' },
                      { value: 'always', label: '每次都通知' },
                      { value: 'never', label: '从不通知' },
                    ]}
                  />
                  {form.notify !== 'never' && (
                    <Select
                      value={form.notifyChannelId}
                      onChange={(v) => setForm({ ...form, notifyChannelId: v })}
                      style={{ flex: 1 }}
                      allowClear
                      placeholder="默认第一个渠道"
                      options={channels.map((c) => ({
                        value: c.id,
                        label: c.name,
                      }))}
                    />
                  )}
                </div>
                <div className={styles.formRow}>
                  <Switch checked={!!form.pushEachStep} onChange={(v) => setForm({ ...form, pushEachStep: v })} />
                  <span className={styles.hint}>
                    每步跑完就把该步产出实时推到上面的渠道(在飞书/手机上跟进进度,替代 App 内小预览)
                  </span>
                </div>
                <div className={styles.formRow} style={{ justifyContent: 'flex-end' }}>
                  <Button size="small" onClick={() => setForm(null)}>
                    取消
                  </Button>
                  <Button size="small" type="primary" onClick={saveForm}>
                    保存
                  </Button>
                </div>
              </div>
            </Drawer>
          )}

          {routines.length === 0 && !form && (
            <Empty description="No workflows yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}

          {routines.map((r) => (
            <div
              key={r.id}
              className={cx(styles.card, styles.cardClickable, selected?.id === r.id && styles.cardSelected)}
              onClick={() => setSelectedId(r.id)}
            >
              <div className={styles.cardHead}>
                <span className="name" title={r.steps.map((step) => step.name).join(', ')}>
                  {r.name}
                </span>
                {routineState.cancellingIds.includes(r.id) ? (
                  <Tag color="warning">正在停止</Tag>
                ) : routineState.waitingIds.includes(r.id) ? (
                  <Tag color="gold">等待审核</Tag>
                ) : routineState.runningIds.includes(r.id) ? (
                  <Tag color="processing">执行中</Tag>
                ) : null}
                {routineState.queuedIds.includes(r.id) && <Tag color="warning">排队中</Tag>}
                <Switch
                  size="small"
                  checked={r.enabled}
                  onChange={async (v) => {
                    setRoutines(await api.routines.toggle(r.id, v))
                    if (!v) {
                      setRoutineState((prev) => ({
                        ...prev,
                        queuedIds: prev.queuedIds.filter((id) => id !== r.id),
                      }))
                    }
                  }}
                />
              </div>
              <div className={styles.cardMeta}>
                <Tag>{scheduleLabel(r.schedule)}</Tag>
                <span>{r.workspacePath}</span>
                {r.lastRunAt && <span>上次: {new Date(r.lastRunAt).toLocaleString()}</span>}
                <div style={{ flex: 1 }} />
                {activeIds.includes(r.id) ? (
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<Square size={13} />}
                    title="停止执行"
                    onClick={() => cancelRun(r)}
                    disabled={routineState.cancellingIds.includes(r.id)}
                  />
                ) : (
                  <Button
                    size="small"
                    type="text"
                    icon={<Play size={13} />}
                    title="立即执行"
                    onClick={() => runNow(r)}
                  />
                )}
                <Button
                  size="small"
                  type="text"
                  icon={<Pencil size={13} />}
                  title="编辑"
                  onClick={() => editRoutine(r)}
                />
                <Popconfirm
                  title="删除这个例行任务?"
                  onConfirm={async () => setRoutines(await api.routines.delete(r.id))}
                >
                  <Button size="small" type="text" danger icon={<Trash2 size={13} />} title="删除" />
                </Popconfirm>
              </div>
            </div>
          ))}
        </section>

        <section className={`${styles.col} ${styles.right}`}>
          <div className={styles.colTitle}>
            <GitBranch size={16} />
            流程图{selected ? ` · ${selected.name}` : ''}
            {selectedRunning && <Tag color="processing">执行中</Tag>}
            {selectedQueued && <Tag color="warning">排队中</Tag>}
          </div>

          {!selected && (
            <Empty description="左侧创建一个例行任务,流程会显示在这里" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}

          {selected && (
            <div className={styles.flow}>
              <div className={styles.node}>
                <div className={styles.nodeHead}>
                  <CalendarClock size={14} />
                  <span className="sname">触发</span>
                  <Tag>{scheduleLabel(selected.schedule)}</Tag>
                </div>
                <div className={styles.nodeSub}>{selected.workspacePath}</div>
              </div>
              {connector('c-start')}

              {selected.steps.map((step, index) => {
                const display = stepDisplay(step)
                const TypeIcon = STEP_TYPE_META[step.type]?.icon ?? Bot
                return (
                  <div key={step.id} style={{ display: 'contents' }}>
                    <div className={nodeClass(display.status)}>
                      <div className={styles.nodeHead}>
                        {stepIcon(display.status)}
                        <TypeIcon size={13} />
                        <span className="sname">
                          {index + 1}. {step.name}
                        </span>
                        <Tag>{STEP_TYPE_META[step.type]?.label ?? step.type}</Tag>
                        {display.durationMs ? (
                          <span className="dur">{Math.max(1, Math.round(display.durationMs / 1000))}s</span>
                        ) : null}
                      </div>
                      {step.type === 'notify' ? (
                        <div className={styles.nodeSub}>
                          → {channelName(step.channelId)}
                          {step.message?.trim() ? ` · ${step.message.slice(0, 60)}` : ' · (上一步输出)'}
                        </div>
                      ) : step.type === 'export' ? (
                        <div className={styles.nodeSub}>
                          → {step.path || '.pi-studio/articles/article-draft'} ·{' '}
                          {step.format === 'markdown' ? 'Markdown' : '公众号 HTML'}
                        </div>
                      ) : step.type === 'review' ? (
                        <div className={styles.nodeSub}>⏸ {step.message || '等待人工审核后继续'}</div>
                      ) : step.type === 'app-icon' ? (
                        <div className={styles.nodeSub}>
                          → {step.path || '.pi-studio/app-icons/{{routine.name}}-{{trigger.stamp}}'} ·{' '}
                          {(step.platforms ?? ['android', 'ios', 'macos', 'windows']).join(' / ')}
                        </div>
                      ) : (
                        <div className={styles.nodePrompt} title={step.prompt}>
                          {step.prompt}
                        </div>
                      )}
                      {display.imageUrl && display.status === 'ok' && (
                        <img className={styles.nodeImage} src={display.imageUrl} alt={step.name} />
                      )}
                      {display.summary && display.status === 'ok' && !display.imageUrl && (
                        <div className={styles.nodeSummary}>{display.summary}</div>
                      )}
                      {display.summary &&
                        (display.status === 'error' ||
                          display.status === 'timeout' ||
                          display.status === 'cancelled') && (
                          <div className={styles.nodeErrText}>{display.summary}</div>
                        )}
                    </div>
                    {connector(`c-${step.id}`)}
                  </div>
                )
              })}

              <div className={styles.node}>
                <div className={styles.nodeHead}>
                  <Bell size={14} />
                  <span className="sname">兜底通知</span>
                  <Tag>{NOTIFY_LABEL[selected.notify]}</Tag>
                  {selected.notify !== 'never' && (
                    <Tag color={channels.length ? 'green' : 'default'}>
                      {channels.length
                        ? ((
                            channels.find((c) => c.id === selected.notifyChannelId) ??
                            channels.find((c) => c.type !== 'local')
                          )?.name ?? '系统通知')
                        : '无渠道'}
                    </Tag>
                  )}
                </div>
                {selected.notify !== 'never' && channels.length === 0 && (
                  <div className={styles.nodeSub}>在 设置 → 通知渠道 里添加飞书/Webhook 渠道</div>
                )}
              </div>

              {latestRun && (
                <div className={styles.lastRun}>
                  {statusIcon(latestRun.status)}
                  <span>最近一次: {new Date(latestRun.startedAt).toLocaleString()}</span>
                  <span>耗时 {Math.max(1, Math.round((latestRun.endedAt - latestRun.startedAt) / 1000))}s</span>
                  {latestRun.error && <Tag color="error">{latestRun.error.slice(0, 80)}</Tag>}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      <Modal
        open={!!reviewRequest}
        title={reviewRequest ? `人工审核 · ${reviewRequest.stepName}` : '人工审核'}
        closable={false}
        mask={{ closable: false }}
        onCancel={() => respondToReview('reject')}
        okText="通过并继续"
        cancelText="拒绝并停止"
        onOk={() => respondToReview('approve')}
      >
        {reviewRequest && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div>{reviewRequest.message}</div>
            {reviewRequest.artifactPath && <code>{reviewRequest.artifactPath}</code>}
            {reviewRequest.imageUrl && (
              <img
                src={reviewRequest.imageUrl}
                alt={reviewRequest.stepName}
                style={{
                  width: 'min(100%, 360px)',
                  aspectRatio: '1',
                  objectFit: 'contain',
                  borderRadius: 12,
                  background: 'var(--ant-color-fill-quaternary)',
                  justifySelf: 'center',
                }}
              />
            )}
            <Input.TextArea
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              placeholder="审核意见（拒绝时建议填写原因）"
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
            <div
              style={{
                maxHeight: 360,
                overflow: 'auto',
                padding: 10,
                whiteSpace: 'pre-wrap',
                border: '1px solid var(--ant-color-border-secondary)',
                borderRadius: 8,
              }}
            >
              {reviewRequest.preview || '(上一步没有文本预览)'}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
