import type { ReactNode } from 'react'

import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

export const SectionHeader = ({
  title,
  count,
  onHelp,
  action
}: {
  title: string
  count?: number
  onHelp: () => void
  action?: ReactNode
}) => (
  <Stack
    direction={{ xs: 'column', sm: 'row' }}
    spacing={3}
    justifyContent='space-between'
    alignItems={{ xs: 'stretch', sm: 'center' }}
  >
    <Stack direction='row' spacing={2} alignItems='center'>
      <Typography variant='h5'>{title}</Typography>
      {typeof count === 'number' && <Chip size='small' variant='tonal' label={count} />}
      <Tooltip title='查看说明'>
        <IconButton size='small' onClick={onHelp}>
          <i className='ri-question-line' />
        </IconButton>
      </Tooltip>
    </Stack>
    {action}
  </Stack>
)

export const EmptyState = ({ icon, text }: { icon: string; text: string }) => (
  <Box sx={{ py: 12, textAlign: 'center' }}>
    <i className={`${icon} text-[44px] text-textDisabled`} />
    <Typography sx={{ mt: 2 }} color='text.secondary'>
      {text}
    </Typography>
  </Box>
)

export const listSurfaceSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2.5,
  overflow: 'hidden',
  bgcolor: 'background.paper',
  boxShadow: '0 6px 24px rgba(47, 43, 61, 0.045)'
} as const

export const rowSurfaceSx = {
  transition: 'background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
  '&:hover': {
    bgcolor: 'action.hover'
  }
} as const

export const channelGridColumns =
  'minmax(110px, .85fr) minmax(120px, 1fr) minmax(145px, 1.15fr) minmax(100px, .8fr) minmax(120px, .85fr) minmax(280px, auto)'

export const channelGridMinWidth = 940
