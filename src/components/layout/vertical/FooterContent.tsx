// Third-party Imports
import classnames from 'classnames'

// Util Imports
import { verticalLayoutClasses } from '@layouts/utils/layoutClasses'

const FooterContent = () => {
  return (
    <div
      className={classnames(verticalLayoutClasses.footerContent, 'flex items-center justify-between flex-wrap gap-4')}
    >
      <p>ChatGPT Model Manager</p>
      <p className='text-textSecondary'>本机配置会在切换前自动备份</p>
    </div>
  )
}

export default FooterContent
