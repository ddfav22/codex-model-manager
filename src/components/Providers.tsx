// Type Imports
import type { ChildrenType, Direction } from '@core/types'

// Context Imports
import { VerticalNavProvider } from '@menu/contexts/verticalNavContext'
import { SettingsProvider } from '@core/contexts/settingsContext'
import ThemeProvider from '@components/theme'

// Config Imports
import themeConfig from '@configs/themeConfig'

type Props = ChildrenType & {
  direction: Direction
}

const Providers = (props: Props) => {
  // Props
  const { children, direction } = props

  return (
    <VerticalNavProvider>
      <SettingsProvider settingsCookie={{}} mode={themeConfig.mode}>
        <ThemeProvider direction={direction}>{children}</ThemeProvider>
      </SettingsProvider>
    </VerticalNavProvider>
  )
}

export default Providers
