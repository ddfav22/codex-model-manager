const fs = require('fs')
const path = require('path')

const DEFAULT_FILENAME = 'manager.log'
const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_DETAIL_LENGTH = 12000
const SECRET_KEY_PATTERN = /(^|_)(api_?key|authorization|password|secret|token|access_?token|refresh_?token)($|_)/i
let configuredRoots = []
let activeLogPath = ''

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess|paidgrok)[-_][A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
    .slice(0, MAX_DETAIL_LENGTH)
}

function sanitize(value, key = '', depth = 0) {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (depth > 6) return '[TRUNCATED]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ''),
      code: value.code || '',
      stack: redactString(value.stack || '')
    }
  }
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey, depth + 1)])
    )
  }

  return redactString(value)
}

function rotateLog(logPath) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < MAX_LOG_BYTES) return

    const previousPath = `${logPath}.1`

    fs.rmSync(previousPath, { force: true })
    fs.renameSync(logPath, previousPath)
  } catch {
    // Logging must never interrupt the application.
  }
}

function selectLogPath() {
  for (const root of configuredRoots) {
    try {
      fs.mkdirSync(root, { recursive: true })
      const logPath = path.join(root, DEFAULT_FILENAME)

      rotateLog(logPath)
      fs.appendFileSync(logPath, '', 'utf8')
      activeLogPath = logPath
      return activeLogPath
    } catch {
      // Try the next writable location.
    }
  }

  return ''
}

function configureRuntimeLogger(options = {}) {
  configuredRoots = Array.isArray(options.roots) ? options.roots.filter(Boolean) : []
  activeLogPath = ''

  return selectLogPath()
}

function getRuntimeLogPath() {
  return activeLogPath || selectLogPath()
}

function logEvent(level, event, details = {}) {
  const logPath = getRuntimeLogPath()

  if (!logPath) return false

  try {
    rotateLog(logPath)
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: String(level || 'info'),
        event: String(event || 'runtime'),
        pid: process.pid,
        details: sanitize(details)
      })}\n`,
      'utf8'
    )
    return true
  } catch {
    activeLogPath = ''
    return false
  }
}

function logError(event, error, details = {}) {
  return logEvent('error', event, { ...details, error })
}

module.exports = {
  configureRuntimeLogger,
  getRuntimeLogPath,
  logError,
  logEvent,
  _internal: { redactString, sanitize }
}
