const path = require('path')
const { spawnSync } = require('child_process')

const WINDOWS_DRIVE_TYPE_NETWORK = 4

function windowsDriveType(targetPath, options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return null

  const root = path.win32.parse(String(targetPath || '')).root
  if (!root) return null

  const runner = options.runner || spawnSync
  const escapedRoot = root.replace(/'/g, "''")
  const result = runner(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `[int]([System.IO.DriveInfo]::new('${escapedRoot}').DriveType)`],
    {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    }
  )
  const driveType = Number(String(result?.stdout || '').trim())
  return result?.status === 0 && Number.isInteger(driveType) ? driveType : null
}

function startupCompatibility(targetPath, options = {}) {
  const driveType = windowsDriveType(targetPath, options)
  const networkDrive = driveType === WINDOWS_DRIVE_TYPE_NETWORK

  return {
    driveType,
    networkDrive,
    disableHardwareAcceleration: true,
    disableChromiumSandbox: networkDrive
  }
}

module.exports = {
  WINDOWS_DRIVE_TYPE_NETWORK,
  startupCompatibility,
  windowsDriveType
}
