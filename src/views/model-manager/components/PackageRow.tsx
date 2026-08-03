import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import type { ToolPackage } from '@/types/codex-manager'

import { cleanErrorMessage, formatBytes, formatDate } from '../modelManagerCore'
import { rowSurfaceSx } from './ManagerLayout'

export const PackageRow = ({
  item,
  busy,
  onOpen,
  onExport
}: {
  item: ToolPackage
  busy: boolean
  onOpen: (targetPath: string) => void
  onExport: (identifier: string) => void
}) => (
  <Box
    sx={{
      ...rowSurfaceSx,
      display: 'grid',
      gridTemplateColumns: { xs: '1fr', md: '1fr auto' },
      gap: 3,
      alignItems: 'center',
      px: 3,
      py: 2.5
    }}
  >
    <Stack spacing={1}>
      <Stack direction='row' spacing={1.5} alignItems='center'>
        <i
          className={
            item.kind === 'file'
              ? 'ri-file-text-line text-[20px] text-primary'
              : 'ri-folder-5-line text-[20px] text-primary'
          }
        />
        <Typography variant='subtitle1'>{item.displayName || item.name}</Typography>
      </Stack>
      {item.displayName && item.displayName !== item.name && (
        <Typography variant='caption' color='text.secondary'>
          文件：{item.name}
        </Typography>
      )}
      {item.description && (
        <Typography variant='body2' color='text.secondary'>
          {item.description}
        </Typography>
      )}
      <Typography variant='body2' color='text.secondary'>
        {formatBytes(item.size)} · {formatDate(item.updatedAt)}
        {item.source === 'legacy' ? ' · 旧 Skill 目录' : ''}
      </Typography>
      {item.valid === false && (
        <Typography variant='body2' color='error.main'>
          {item.message ? cleanErrorMessage(item.message) : '格式无效，Codex 不会加载'}
        </Typography>
      )}
    </Stack>
    <Stack direction='row' spacing={1} justifyContent='flex-end'>
      <Tooltip title='打开位置'>
        <IconButton disabled={busy} onClick={() => onOpen(item.path)}>
          <i className='ri-folder-open-line' />
        </IconButton>
      </Tooltip>
      <Button size='small' variant='outlined' disabled={busy} onClick={() => onExport(item.path)}>
        导出
      </Button>
    </Stack>
  </Box>
)
