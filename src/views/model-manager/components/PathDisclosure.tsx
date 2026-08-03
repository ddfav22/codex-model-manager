'use client'

import { useState } from 'react'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

const shortLocationName = (targetPath: string) => {
  const normalized = String(targetPath || '').replace(/[\\/]+$/, '')

  return normalized.split(/[\\/]/).filter(Boolean).pop() || '本地位置'
}

export const PathDisclosure = ({
  path,
  label = '所在位置',
  summary
}: {
  path: string
  label?: string
  summary?: string
}) => {
  const [expanded, setExpanded] = useState(false)

  if (!path) return null

  return (
    <Stack spacing={0.5} alignItems='flex-start'>
      <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
        <Typography variant='caption' color='text.secondary'>
          {label}：{summary || shortLocationName(path)}
        </Typography>
        <Button
          size='small'
          variant='text'
          color='secondary'
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          sx={{ minInlineSize: 0, px: 0.75, py: 0.25, fontSize: '0.8rem' }}
        >
          {expanded ? '隐藏路径' : '查看路径'}
        </Button>
      </Stack>
      <Collapse in={expanded} timeout='auto' unmountOnExit sx={{ inlineSize: '100%' }}>
        <Box
          aria-label={`${label}完整路径`}
          sx={{
            mt: 0.5,
            px: 1.5,
            py: 1,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
            color: 'text.secondary',
            fontFamily: 'Consolas, "Microsoft YaHei UI", monospace',
            fontSize: '0.78rem',
            lineHeight: 1.65,
            overflowWrap: 'anywhere',
            userSelect: 'text'
          }}
        >
          {path}
        </Box>
      </Collapse>
    </Stack>
  )
}
