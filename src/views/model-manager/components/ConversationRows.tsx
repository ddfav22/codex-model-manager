import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

import type { CodexProject, CodexSession } from '@/types/codex-manager'

import { formatBytes, formatDate, sessionPlace } from '../modelManagerCore'
import { rowSurfaceSx } from './ManagerLayout'
import { PathDisclosure } from './PathDisclosure'

export const SessionRow = ({
  session,
  busy,
  onOpen,
  onDelete
}: {
  session: CodexSession
  busy: boolean
  onOpen: (targetPath: string) => void
  onDelete: (session: CodexSession) => void
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
      <Stack direction='row' spacing={1.5} alignItems='center' flexWrap='wrap'>
        <i className='ri-folder-5-line text-[20px] text-primary' />
        <Typography variant='subtitle1'>{session.title}</Typography>
        <Chip size='small' variant='outlined' label={sessionPlace(session)} />
      </Stack>
      <Typography variant='body2' color='text.secondary'>
        {formatDate(session.updatedAt)} · {formatBytes(session.size)}
      </Typography>
      {session.cwd && <PathDisclosure path={session.cwd} label='关联项目' />}
    </Stack>
    <Stack direction='row' spacing={1} justifyContent='flex-end'>
      <Tooltip title='打开位置'>
        <IconButton disabled={busy} onClick={() => onOpen(session.path)}>
          <i className='ri-folder-open-line' />
        </IconButton>
      </Tooltip>
      <Tooltip title='删除'>
        <IconButton color='error' disabled={busy} onClick={() => onDelete(session)}>
          <i className='ri-delete-bin-6-line' />
        </IconButton>
      </Tooltip>
    </Stack>
  </Box>
)

export const ProjectRow = ({
  project,
  busy,
  onOpen,
  onDelete
}: {
  project: CodexProject
  busy: boolean
  onOpen: (targetPath: string) => void
  onDelete: (project: CodexProject) => void
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
      <Stack direction='row' spacing={1.5} alignItems='center' flexWrap='wrap'>
        <i className='ri-folder-3-line text-[20px] text-primary' />
        <Typography variant='subtitle1'>{project.name}</Typography>
        <Chip
          color={project.exists ? 'success' : 'warning'}
          size='small'
          variant='tonal'
          label={project.exists ? '可用' : '失效'}
        />
      </Stack>
      <Typography variant='body2' color='text.secondary'>
        {project.trustLevel || '未设置信任级别'}
      </Typography>
      <PathDisclosure path={project.path} label='项目位置' summary='本地项目文件夹' />
    </Stack>
    <Stack direction='row' spacing={1} justifyContent='flex-end'>
      <Tooltip title='打开项目'>
        <span>
          <IconButton disabled={busy || !project.exists} onClick={() => onOpen(project.path)}>
            <i className='ri-folder-open-line' />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title='从列表删除'>
        <IconButton color='error' disabled={busy} onClick={() => onDelete(project)}>
          <i className='ri-delete-bin-6-line' />
        </IconButton>
      </Tooltip>
    </Stack>
  </Box>
)
