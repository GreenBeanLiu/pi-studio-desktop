import { createStyles } from 'antd-style'
import { ActionIcon } from '@lobehub/ui'
import { Tooltip } from 'antd'
import { FolderOpen, MessageSquare, Settings, Sun, Moon, CalendarClock, Image, Box, Clapperboard } from 'lucide-react'
import type { Workspace } from '../lib/api'

const useStyles = createStyles(({ token, css }) => ({
  rail: css`
    width: 56px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: ${token.colorBgLayout};
    border-right: 1px solid ${token.colorBorderSecondary};
    padding: 8px 0 10px;
    gap: 0;
  `,

  iconBtn: css`
    flex-shrink: 0;
    margin-bottom: 4px;
    color: ${token.colorTextTertiary};

    &:hover {
      color: ${token.colorText};
    }
  `,

  // 选中态用中性填充,蓝色留给运行状态/当前会话/主要动作
  iconBtnActive: css`
    color: ${token.colorText};
    background: ${token.colorFillSecondary};
  `,

  spacer: css`
    flex: 1;
  `,

  // 工作区按钮与功能入口之间的短分隔线
  railDivider: css`
    width: 24px;
    height: 1px;
    flex-shrink: 0;
    background: ${token.colorBorderSecondary};
    margin: 0 0 10px;
  `,

  wsBtnWrap: css`
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,

  wsBtn: css`
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    outline: none;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
    color: ${token.colorText};
    font-size: 14px;
    font-weight: 600;
    transition: background ${token.motionDurationFast} ${token.motionEaseOut};

    &:hover {
      background: ${token.colorFillSecondary};
    }
  `,
}))

type Props = {
  workspace: Workspace | null
  activeView: 'chat' | 'routines' | 'imagegen' | 'model3d' | 'video'
  appearance: 'dark' | 'light'
  onSwitchWorkspace: () => void
  onChat: () => void
  onRoutines: () => void
  onImageGen: () => void
  onModel3D: () => void
  onVideo: () => void
  onSettings: () => void
  onToggleTheme: () => void
}

export default function NavRail({
  workspace,
  activeView,
  appearance,
  onSwitchWorkspace,
  onChat,
  onRoutines,
  onImageGen,
  onModel3D,
  onVideo,
  onSettings,
  onToggleTheme,
}: Props) {
  const { styles, cx } = useStyles()

  const initial = workspace?.name.slice(0, 1).toUpperCase() ?? ''

  return (
    <nav className={styles.rail}>
      <Tooltip title={workspace ? `切换工作区 · ${workspace.name}` : '打开工作区'} placement="right">
        <div className={styles.wsBtnWrap}>
          <button className={styles.wsBtn} onClick={onSwitchWorkspace}>
            {workspace ? initial : <FolderOpen size={16} />}
          </button>
        </div>
      </Tooltip>

      <div className={styles.railDivider} />

      <ActionIcon
        className={cx(styles.iconBtn, activeView === 'chat' && styles.iconBtnActive)}
        icon={<MessageSquare size={15} />}
        title="聊天"
        onClick={onChat}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={cx(styles.iconBtn, activeView === 'routines' && styles.iconBtnActive)}
        icon={<CalendarClock size={15} />}
        title="例程"
        onClick={onRoutines}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={cx(styles.iconBtn, activeView === 'imagegen' && styles.iconBtnActive)}
        icon={<Image size={15} />}
        title="图像生成"
        onClick={onImageGen}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={cx(styles.iconBtn, activeView === 'model3d' && styles.iconBtnActive)}
        icon={<Box size={15} />}
        title="3D 生成"
        onClick={onModel3D}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={cx(styles.iconBtn, activeView === 'video' && styles.iconBtnActive)}
        icon={<Clapperboard size={15} />}
        title="视频生成"
        onClick={onVideo}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <div className={styles.spacer} />

      <ActionIcon
        className={styles.iconBtn}
        icon={appearance === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        title={appearance === 'dark' ? '切换亮色' : '切换暗色'}
        onClick={onToggleTheme}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={styles.iconBtn}
        icon={<Settings size={15} />}
        title="设置"
        onClick={onSettings}
        size={{ blockSize: 36, borderRadius: 8 }}
      />
    </nav>
  )
}
