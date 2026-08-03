// MUI Imports
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'

// Third-party Imports
import classnames from 'classnames'

// Component Imports
import NavToggle from './NavToggle'
import ModeDropdown from '@components/layout/shared/ModeDropdown'

// Util Imports
import { verticalLayoutClasses } from '@layouts/utils/layoutClasses'

const NavbarContent = () => {
  return (
    <div className={classnames(verticalLayoutClasses.navbarContent, 'flex items-center justify-between gap-4 is-full')}>
      <div className='flex items-center gap-2 sm:gap-4'>
        <NavToggle />
        <Typography variant='body2' color='text.secondary'>
          Windows Codex 渠道控制台
        </Typography>
      </div>
      <div className='flex items-center gap-2'>
        <Chip size='small' color='primary' variant='tonal' label='本机配置' />
        <ModeDropdown />
      </div>
    </div>
  )
}

export default NavbarContent
