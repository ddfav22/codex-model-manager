const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const RCEDIT_SHA256 = '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A'

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

function assertIco(iconPath) {
  const icon = fs.readFileSync(iconPath)

  if (icon.length < 6 || !icon.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) {
    throw new Error(`Windows application icon is not a valid ICO: ${iconPath}`)
  }
  if (icon.readUInt16LE(4) < 6) {
    throw new Error(`Windows application icon does not contain enough sizes: ${iconPath}`)
  }
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return

  const projectRoot = path.resolve(__dirname, '..')
  const editorPath = path.join(__dirname, 'vendor', 'rcedit-x64.exe')
  const iconPath = path.join(projectRoot, 'electron', 'assets', 'app-icon.ico')
  const executableName = `${context.packager.appInfo.productFilename}.exe`
  const executablePath = path.join(context.appOutDir, executableName)

  if (!fs.existsSync(executablePath)) throw new Error(`Packaged Windows executable is missing: ${executablePath}`)
  if (sha256(editorPath) !== RCEDIT_SHA256) throw new Error('Vendored rcedit SHA-256 verification failed')
  assertIco(iconPath)

  await execFileAsync(editorPath, [executablePath, '--set-icon', iconPath], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
}
