import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Tooltip from '@mui/material/Tooltip'

import type { AppUpdateState } from '@/types/codex-manager'

export const UpdateButton = ({
  state,
  onCheck,
  onInstall
}: {
  state: AppUpdateState
  onCheck: () => void
  onInstall: () => void
}) => {
  const working = ['checking', 'downloading', 'installing'].includes(state.stage)
  const ready = state.stage === 'ready'
  const unsupported = state.stage === 'unsupported'
  const deliveryLabel = state.deliveryType === 'patch' ? '轻量补丁' : '完整更新'

  const label =
    state.stage === 'checking'
      ? '检查更新中'
      : state.stage === 'downloading'
        ? `${deliveryLabel} ${state.downloadPercent}%`
        : state.stage === 'ready'
          ? `${deliveryLabel}已就绪 ${state.latestVersion}`
          : state.stage === 'installing'
            ? '正在启动更新'
            : state.stage === 'error'
              ? '重新检查更新'
              : state.stage === 'up-to-date'
                ? '检查更新'
                : '在线更新'

  return (
    <Tooltip
      title={unsupported ? state.message : ready ? `${deliveryLabel}已经安全下载，重启程序即可完成安装` : state.message}
    >
      <span>
        <Button
          variant={ready ? 'contained' : 'outlined'}
          color={ready ? 'success' : 'secondary'}
          disabled={working || unsupported}
          startIcon={
            working ? (
              <CircularProgress size={15} color='inherit' />
            ) : (
              <i className={ready ? 'ri-restart-line' : 'ri-refresh-line'} />
            )
          }
          onClick={ready ? onInstall : onCheck}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  )
}
