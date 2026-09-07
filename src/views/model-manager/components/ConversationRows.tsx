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
  recovering,
  onOpen,
  onRecover,
  onEdit,
  onDelete
}: {
  session: CodexSession
  busy: boolean
  recovering: boolean
  onOpen: (targetPath: string) => void
  onRecover: (session: CodexSession) => void
  onEdit: (session: CodexSession) => void
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
      <Stack direction='row' spacing={1.5} alignItems='center' flexWrap='wrap' minWidth={0}>
        <i className='ri-chat-history-line text-[20px] text-primary' aria-hidden='true' />
        <Typography
          variant='subtitle1'
          title={session.title}
          sx={{ minWidth: 0, maxInlineSize: 'min(100%, 720px)', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {session.title || '未命名对话'}
        </Typography>
        <Chip size='small' variant='outlined' label={sessionPlace(session)} />
        <Chip
          size='small'
          variant='outlined'
          color='default'
          label={`ID ${String(session.id || '').slice(0, 8) || '未知'}`}
          title={session.id}
        />
        {recovering && <Chip size='small' color='info' variant='tonal' label='恢复中' />}
      </Stack>
      <Typography variant='body2' color='text.secondary'>
        {formatDate(session.updatedAt)} · {formatBytes(session.size)}
      </Typography>
      {session.cwd && <PathDisclosure path={session.cwd} label='关联项目' />}
    </Stack>
    <Stack direction='row' spacing={1} justifyContent='flex-end'>
      <Tooltip title={session.location === 'active' ? '恢复未完成任务' : '只有未归档的原始任务可以恢复'}>
        <span>
          <IconButton
            size='small'
            aria-label='恢复未完成任务'
            title={session.title || session.id}
            color='primary'
            disabled={busy || recovering || session.location !== 'active'}
            onClick={() => onRecover(session)}
          >
            <i className='ri-restart-line' />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title='打开对话文件位置'>
        <IconButton
          size='small'
          aria-label='打开对话文件位置'
          title={session.title || session.id}
          disabled={busy}
          onClick={() => onOpen(session.path)}
        >
          <i className='ri-folder-open-line' />
        </IconButton>
      </Tooltip>
      <Tooltip title='修改对话名称'>
        <IconButton
          size='small'
          aria-label='修改对话名称'
          title={session.title || session.id}
          disabled={busy}
          onClick={() => onEdit(session)}
        >
          <i className='ri-edit-2-line' />
        </IconButton>
      </Tooltip>
      <Tooltip title='永久删除本条对话（不可恢复）'>
        <IconButton
          size='small'
          aria-label='永久删除对话'
          title={session.title || session.id}
          color='error'
          disabled={busy}
          onClick={() => onDelete(session)}
        >
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
      <Stack direction='row' spacing={1.5} alignItems='center' flexWrap='wrap' minWidth={0}>
        <i className='ri-folder-3-line text-[20px] text-primary' aria-hidden='true' />
        <Typography
          variant='subtitle1'
          title={project.name}
          sx={{ minWidth: 0, maxInlineSize: 'min(100%, 720px)', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {project.name || '未命名项目'}
        </Typography>
        <Chip
          color={project.exists ? 'success' : 'warning'}
          size='small'
          variant='tonal'
          label={project.exists ? '可用' : '失效'}
        />
        <Chip size='small' variant='outlined' label='仅移除记录' title='单独删除项目不会删除磁盘文件夹' />
      </Stack>
      <Typography variant='body2' color='text.secondary'>
        {project.trustLevel || '未设置信任级别'}
      </Typography>
      <PathDisclosure path={project.path} label='项目位置' summary='本地项目文件夹' />
    </Stack>
    <Stack direction='row' spacing={1} justifyContent='flex-end'>
      <Tooltip title={project.exists ? '打开项目文件夹' : '项目文件夹不存在'}>
        <span>
          <IconButton
            size='small'
            aria-label='打开项目文件夹'
            title={project.name || project.path}
            disabled={busy || !project.exists}
            onClick={() => onOpen(project.path)}
          >
            <i className='ri-folder-open-line' />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title='从 Codex 列表移除（不删除磁盘文件夹）'>
        <IconButton
          size='small'
          aria-label='移除项目记录'
          title={project.name || project.path}
          color='error'
          disabled={busy}
          onClick={() => onDelete(project)}
        >
          <i className='ri-delete-bin-6-line' />
        </IconButton>
      </Tooltip>
    </Stack>
  </Box>
)
