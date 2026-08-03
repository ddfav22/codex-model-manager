const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const EXECUTABLE_MARKER_VERSION = 1
const MANAGER_EXECUTABLE_NAME = 'ChatGPT Model Manager.exe'

function normalizeExecutablePath(executablePath, platform = process.platform) {
  const value = String(executablePath || '').trim()

  if (!value) return ''

  const normalized = platform === 'win32' ? path.win32.normalize(value) : path.resolve(value)

  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPackagedManagerExecutable(executablePath, platform = process.platform) {
  if (platform !== 'win32') return false

  return path.win32.basename(String(executablePath || '')).toLowerCase() === MANAGER_EXECUTABLE_NAME.toLowerCase()
}

function readExecutableMarker(markerPath, fsModule = fs) {
  try {
    const marker = JSON.parse(fsModule.readFileSync(markerPath, 'utf8'))

    if (marker?.version !== EXECUTABLE_MARKER_VERSION || typeof marker.executablePath !== 'string') return ''

    return marker.executablePath
  } catch {
    return ''
  }
}

function legacyScanDecision({ executablePath, markerPath, platform = process.platform, fsModule = fs }) {
  if (!isPackagedManagerExecutable(executablePath, platform)) {
    return { scan: false, reason: 'not-packaged-windows-manager' }
  }

  const current = normalizeExecutablePath(executablePath, platform)
  const previous = normalizeExecutablePath(readExecutableMarker(markerPath, fsModule), platform)

  if (current && previous === current) return { scan: false, reason: 'same-executable' }

  return { scan: true, reason: previous ? 'executable-changed' : 'marker-missing-or-invalid' }
}

function legacyCleanupCommand(executablePath, processId) {
  const currentPath = String(executablePath || '').replace(/'/g, "''")

  return [
    `$currentPath = '${currentPath}'`,
    `$currentPid = ${Number(processId) || 0}`,
    '$stopped = 0',
    `Get-CimInstance Win32_Process -Filter "Name = '${MANAGER_EXECUTABLE_NAME}'" -ErrorAction SilentlyContinue | Where-Object {`,
    '  $_.ProcessId -ne $currentPid -and',
    '  $_.ExecutablePath -and',
    '  $_.ExecutablePath -ine $currentPath',
    '} | ForEach-Object {',
    '  try {',
    '    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop',
    '    $stopped += 1',
    '  } catch {}',
    '}',
    '[Console]::Out.Write($stopped)'
  ].join('\n')
}

function stopLegacyManagerInstances({
  executablePath = process.execPath,
  processId = process.pid,
  markerPath,
  platform = process.platform,
  fsModule = fs,
  execFileSyncFn = execFileSync,
  now = Date.now,
  force = false
}) {
  const defaultDecision = legacyScanDecision({ executablePath, markerPath, platform, fsModule })
  const decision =
    force && isPackagedManagerExecutable(executablePath, platform)
      ? { scan: true, reason: 'single-instance-lock-conflict' }
      : defaultDecision

  if (!decision.scan) return { ...decision, ok: true, durationMs: 0, stoppedCount: 0 }

  const startedAt = now()

  try {
    const output = execFileSyncFn(
      'powershell.exe',
      ['-NoProfile', '-Command', legacyCleanupCommand(executablePath, processId)],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      }
    )
    const stoppedCount = Math.max(0, Number.parseInt(String(output || '0').trim(), 10) || 0)

    return { ...decision, ok: true, durationMs: Math.max(0, now() - startedAt), stoppedCount }
  } catch (error) {
    return {
      ...decision,
      ok: false,
      durationMs: Math.max(0, now() - startedAt),
      stoppedCount: 0,
      errorCode: String(error?.code || error?.name || 'legacy_cleanup_failed')
    }
  }
}

function rememberManagerExecutable({
  executablePath = process.execPath,
  markerPath,
  platform = process.platform,
  fsModule = fs
}) {
  if (!isPackagedManagerExecutable(executablePath, platform)) {
    return { updated: false, reason: 'not-packaged-windows-manager' }
  }

  const current = normalizeExecutablePath(executablePath, platform)
  const previous = normalizeExecutablePath(readExecutableMarker(markerPath, fsModule), platform)

  if (current && previous === current) return { updated: false, reason: 'already-current' }

  try {
    fsModule.mkdirSync(path.dirname(markerPath), { recursive: true })
    fsModule.writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: EXECUTABLE_MARKER_VERSION,
        executablePath: String(executablePath)
      })}\n`,
      'utf8'
    )

    return { updated: true, reason: 'stored' }
  } catch (error) {
    return {
      updated: false,
      reason: 'write-failed',
      errorCode: String(error?.code || error?.name || 'marker_write_failed')
    }
  }
}

function rememberManagerExecutableAfterScan({ scanResult, ...options }) {
  if (scanResult?.ok !== true) {
    return { updated: false, reason: 'legacy-scan-failed' }
  }

  return rememberManagerExecutable(options)
}

module.exports = {
  EXECUTABLE_MARKER_VERSION,
  MANAGER_EXECUTABLE_NAME,
  isPackagedManagerExecutable,
  legacyCleanupCommand,
  legacyScanDecision,
  normalizeExecutablePath,
  readExecutableMarker,
  rememberManagerExecutable,
  rememberManagerExecutableAfterScan,
  stopLegacyManagerInstances
}
