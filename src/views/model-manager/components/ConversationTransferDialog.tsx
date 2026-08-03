'use client'

import { useEffect, useMemo, useState } from 'react'

import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'

import type { CodexProject, CodexSession, ConversationTransferKind } from '@/types/codex-manager'

type ConversationTransferDialogProps = {
  mode?: 'import' | 'export'
  busy: boolean
  sessions: CodexSession[]
  projects: CodexProject[]
  onClose: () => void
  onImport: (kind: ConversationTransferKind) => void
  onExport: (kind: ConversationTransferKind, sourcePath: string) => void
}

const sessionLocation = (session: CodexSession) =>
  session.location === 'archived' ? '已归档' : session.location === 'imported' ? '已导入' : '未归档'

export const ConversationTransferDialog = ({
  mode,
  busy,
  sessions,
  projects,
  onClose,
  onImport,
  onExport
}: ConversationTransferDialogProps) => {
  const availableProjects = useMemo(() => projects.filter(project => project.exists), [projects])
  const [kind, setKind] = useState<ConversationTransferKind>('session')
  const [sourcePath, setSourcePath] = useState('')
  const options = kind === 'session' ? sessions : availableProjects

  useEffect(() => {
    if (!mode) return
    const nextKind = sessions.length || !availableProjects.length ? 'session' : 'project'

    setKind(nextKind)
    setSourcePath(nextKind === 'session' ? sessions[0]?.path || '' : availableProjects[0]?.path || '')
  }, [availableProjects, mode, sessions])

  const selectKind = (nextKind: ConversationTransferKind) => {
    setKind(nextKind)
    setSourcePath(nextKind === 'session' ? sessions[0]?.path || '' : availableProjects[0]?.path || '')
  }

  return (
    <Dialog open={Boolean(mode)} onClose={() => !busy && onClose()} fullWidth maxWidth='sm'>
      <DialogTitle>{mode === 'import' ? '导入会话或项目' : '导出会话或项目'}</DialogTitle>
      <DialogContent>
        {mode === 'import' ? (
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Typography color='text.secondary'>
              选择要导入的内容。对话使用 Codex JSONL 文件；项目会选择一个现有文件夹并加入项目列表。
            </Typography>
            <Button
              variant='outlined'
              size='large'
              disabled={busy}
              startIcon={<i className='ri-chat-upload-line' />}
              onClick={() => onImport('session')}
              sx={{ justifyContent: 'flex-start', py: 2 }}
            >
              导入会话文件（.jsonl）
            </Button>
            <Button
              variant='outlined'
              size='large'
              disabled={busy}
              startIcon={<i className='ri-folder-add-line' />}
              onClick={() => onImport('project')}
              sx={{ justifyContent: 'flex-start', py: 2 }}
            >
              导入项目文件夹
            </Button>
          </Stack>
        ) : (
          <Stack spacing={3} sx={{ mt: 1 }}>
            <Typography color='text.secondary'>
              对话将导出为 JSONL 文件；项目将完整压缩为 ZIP，可在另一台 Windows 电脑上解压后重新导入。
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              value={kind}
              onChange={(_event, value: ConversationTransferKind | null) => value && selectKind(value)}
              aria-label='导出内容类型'
            >
              <ToggleButton value='session' disabled={!sessions.length}>
                会话
              </ToggleButton>
              <ToggleButton value='project' disabled={!availableProjects.length}>
                项目
              </ToggleButton>
            </ToggleButtonGroup>
            <TextField
              select
              fullWidth
              label={kind === 'session' ? '选择会话' : '选择项目'}
              value={sourcePath}
              disabled={busy || !options.length}
              onChange={event => setSourcePath(event.target.value)}
            >
              {kind === 'session'
                ? sessions.map(session => (
                    <MenuItem key={session.path} value={session.path}>
                      {session.title} · {sessionLocation(session)}
                    </MenuItem>
                  ))
                : availableProjects.map(project => (
                    <MenuItem key={project.path} value={project.path}>
                      {project.name} · 本地项目
                    </MenuItem>
                  ))}
            </TextField>
            {!options.length && (
              <Alert severity='info'>
                {kind === 'session' ? '当前没有可导出的会话。' : '当前没有路径有效的项目。'}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 6, pb: 5 }}>
        <Button variant='outlined' color='secondary' disabled={busy} onClick={onClose}>
          取消
        </Button>
        {mode === 'export' && (
          <Button
            variant='contained'
            disabled={busy || !sourcePath}
            startIcon={<i className='ri-download-2-line' />}
            onClick={() => onExport(kind, sourcePath)}
          >
            导出
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
