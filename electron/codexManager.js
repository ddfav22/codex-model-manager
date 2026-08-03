const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { execFile, execFileSync, spawn } = require('child_process')
const toml = require('smol-toml')
const { DEFAULT_PROTOCOL_PROXY_PORT } = require('./protocol/constants')
const { modelIdentityInstruction, modelIdentityLabel } = require('./protocol/modelRouting')
const { parseResponsesProbePayload } = require('./protocol/probeParsing')
const {
  RESPONSES_PROBE_MAX_ATTEMPTS,
  isTransientResponsesProbeFailure,
  responsesProbeRuntimeOptions
} = require('./protocol/probeRequests')
const {
  compressDirectoryZip,
  compressZip,
  downloadFile,
  installZipPackage: installValidatedZipPackage,
  installTomlFilesFromZip,
  safePackageName
} = require('./features/packageArchive')
const { GLOBAL_STATE_FILENAME, syncDesktopProjectsFromSessions } = require('./features/codexDesktopProjects')
const {
  REASONING_DESCRIPTIONS,
  aggregateModelTests,
  modelAdapterProfile,
  modelCapabilityMap,
  modelListFromProvider,
  modelWireApiMap,
  preferredSupportedModel,
  relayTestReady,
  supportedModelsForProvider,
  testForModel,
  uniqueModelList
} = require('./features/modelAdapters')
const { version: APP_VERSION } = require('../package.json')

const APP_STATE_DIRNAME = 'codex-model-manager'
const CHANNELS_FILENAME = 'channels.json'
const NEWAPI_FILENAME = 'newapi.json'
const NEWAPI_CHANNEL_DISPLAY_NAME = 'NewAPI 渠道'
const DEFAULT_NEWAPI_BASE_URL = 'https://ainiubi.org'
const INITIAL_BACKUP_FILENAME = 'initial-backup.json'
const MODELS_CACHE_FILENAME = 'models_cache.json'
const NATIVE_MODELS_FILENAME = 'native-models.json'
const MODEL_ALIASES_FILENAME = 'model-aliases.json'
const IMPORTED_SESSIONS_DIRNAME = 'imported'
const AGENTS_DIRNAME = 'agents'
const CODEX_TARGETS_CACHE_MS = 5 * 60 * 1000
const CODEX_CLIENT_EXECUTABLE_NAMES = ['Codex.exe', 'ChatGPT.exe']
const CODEX_THREAD_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown'
]
const MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_NEWAPI_TOKENS = 2000
const MAX_NEWAPI_MODELS = 20000
const MAX_SESSION_PREVIEW_BYTES = 512 * 1024
const CODEX_AGENT_BASE_INSTRUCTIONS = [
  'You are the selected upstream reasoning model operating inside the Codex local agent runtime.',
  'Keep your actual model identity distinct from the Codex host runtime and state the actual model when the user asks.',
  'Use the tools supplied in the current request to complete tasks instead of only describing what a user could do.',
  'When the user asks you to operate the computer and a relevant shell, file, browser, MCP, or Computer Use tool is available, call that tool.',
  'Do not claim that you cannot access the computer before checking the tools actually supplied to the current turn.',
  'Never end a turn by merely promising to inspect, check, run, or continue. Emit the required tool call in that same turn, then use the returned tool result and continue until you provide a completed answer or another necessary tool call.',
  'Respect the active sandbox, approval policy, and tool results. Never invent successful actions.'
].join(' ')
let codexTargetsCache = { expiresAt: 0, targets: [], appLaunchers: [] }
let codexInstallationEvidenceCache = { expiresAt: 0, evidence: null }
const sessionMetaCache = new Map()

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeout || 30000,
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
        cwd: options.cwd,
        env: options.env || process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout
          error.stderr = stderr
          reject(error)
          return
        }

        resolve(String(stdout || ''))
      }
    )
  })
}

function getPaths(overrides = {}) {
  const home = overrides.homeDir || os.homedir()
  const codexHome = overrides.codexHome || process.env.CODEX_HOME || path.join(home, '.codex')
  const stateDir = overrides.stateDir || process.env.CODEX_MANAGER_STATE_DIR || path.join(codexHome, APP_STATE_DIRNAME)
  const skillsPath =
    overrides.skillsPath ||
    process.env.CODEX_MM_USER_SKILLS_DIR ||
    (overrides.codexHome ? path.join(codexHome, 'skills') : path.join(home, '.agents', 'skills'))

  return {
    codexHome,
    stateDir,
    configPath: overrides.configPath || path.join(codexHome, 'config.toml'),
    authPath: overrides.authPath || path.join(codexHome, 'auth.json'),
    modelsCachePath: overrides.modelsCachePath || path.join(codexHome, MODELS_CACHE_FILENAME),
    nativeModelsPath: overrides.nativeModelsPath || path.join(stateDir, NATIVE_MODELS_FILENAME),
    modelAliasesPath: overrides.modelAliasesPath || path.join(stateDir, MODEL_ALIASES_FILENAME),
    channelsPath: overrides.channelsPath || path.join(stateDir, CHANNELS_FILENAME),
    newApiPath: overrides.newApiPath || path.join(stateDir, NEWAPI_FILENAME),
    initialBackupMetaPath: overrides.initialBackupMetaPath || path.join(stateDir, INITIAL_BACKUP_FILENAME),
    globalStatePath: overrides.globalStatePath || path.join(codexHome, GLOBAL_STATE_FILENAME),
    sessionsPath: overrides.sessionsPath || path.join(codexHome, 'sessions'),
    archivedSessionsPath: overrides.archivedSessionsPath || path.join(codexHome, 'archived_sessions'),
    importedSessionsPath: overrides.importedSessionsPath || path.join(codexHome, 'sessions', IMPORTED_SESSIONS_DIRNAME),
    trashPath: overrides.trashPath || path.join(stateDir, 'trash'),
    skillsPath,
    legacySkillsPath:
      overrides.legacySkillsPath || process.env.CODEX_MM_LEGACY_SKILLS_DIR || path.join(codexHome, 'skills'),
    agentsPath: overrides.agentsPath || process.env.CODEX_MM_AGENTS_DIR || path.join(codexHome, AGENTS_DIRNAME),
    downloadsPath: overrides.downloadsPath || path.join(stateDir, 'downloads')
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, 'utf8')
}

function parseConfig(text) {
  if (!text.trim()) return {}
  return toml.parse(text)
}

function parseJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function getSafeStorage() {
  try {
    const electron = require('electron')

    return electron.safeStorage || null
  } catch {
    return null
  }
}

function encryptRememberedSecret(value) {
  const secret = String(value || '')
  const safeStorage = getSafeStorage()

  if (!secret || !safeStorage?.isEncryptionAvailable?.()) {
    return { value: '', encrypted: false }
  }

  return {
    value: safeStorage.encryptString(secret).toString('base64'),
    encrypted: true
  }
}

function decryptRememberedSecret(state) {
  if (!state?.rememberedPassword || !state?.rememberedPasswordEncrypted) return ''

  const safeStorage = getSafeStorage()

  if (!safeStorage?.isEncryptionAvailable?.()) return ''

  try {
    return safeStorage.decryptString(Buffer.from(state.rememberedPassword, 'base64'))
  } catch {
    return ''
  }
}

function publicNewApiState(state) {
  return {
    baseUrl: state?.baseUrl || DEFAULT_NEWAPI_BASE_URL,
    relayBaseUrl: state?.relayBaseUrl || '',
    username: state?.username || '',
    lastSyncedAt: state?.lastSyncedAt || '',
    rememberPassword: state?.rememberPassword !== false,
    hasRememberedPassword: Boolean(state?.rememberedPassword && state?.rememberedPasswordEncrypted)
  }
}

function readJsonLines(filePath, maxLines = 8, maxBytes = MAX_SESSION_PREVIEW_BYTES) {
  const stat = fs.statSync(filePath)
  const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes))
  const buffer = Buffer.allocUnsafe(bytesToRead)
  const handle = fs.openSync(filePath, 'r')
  let bytesRead = 0

  try {
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(handle, buffer, bytesRead, bytesToRead - bytesRead, bytesRead)

      if (!count) break
      bytesRead += count
    }
  } finally {
    fs.closeSync(handle)
  }

  let text = buffer.subarray(0, bytesRead).toString('utf8')

  // If only a prefix was read, discard its final partial JSONL record.
  if (bytesRead < stat.size) {
    const lastNewline = text.lastIndexOf('\n')

    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : ''
  }

  const rows = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // Ignore malformed preview lines; the original file is still listed.
    }
    if (rows.length >= maxLines) break
  }

  return rows
}

function walkFiles(rootPath, predicate) {
  const files = []

  if (!fs.existsSync(rootPath)) return files

  let entries

  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true })
  } catch {
    // One unreadable cache/session directory must not hide every healthy task.
    return files
  }

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name)

    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate))
    } else if (!predicate || predicate(fullPath)) {
      files.push(fullPath)
    }
  }

  return files
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  })
}

function directorySummary(targetPath, maxEntries = 500) {
  if (!fs.existsSync(targetPath)) return { size: 0, updatedAt: new Date(0).toISOString() }

  let size = 0
  let scanned = 0
  let latestMtime = fs.statSync(targetPath).mtimeMs
  const stack = [targetPath]

  while (stack.length && scanned < maxEntries) {
    const current = stack.pop()
    if (!current) continue

    let stat
    try {
      stat = fs.statSync(current)
    } catch {
      continue
    }

    scanned += 1
    latestMtime = Math.max(latestMtime, stat.mtimeMs)

    if (stat.isFile()) {
      size += stat.size
      continue
    }

    if (!stat.isDirectory()) continue

    try {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry))
      }
    } catch {
      // Ignore unreadable package subfolders.
    }
  }

  return { size, updatedAt: new Date(latestMtime).toISOString() }
}

function diskPathSummary(targetPath) {
  if (!fs.existsSync(targetPath)) return { bytes: 0, files: 0, directories: 0 }

  let bytes = 0
  let files = 0
  let directories = 0
  const stack = [targetPath]

  while (stack.length) {
    const current = stack.pop()
    if (!current) continue

    let stat

    try {
      stat = fs.lstatSync(current)
    } catch {
      continue
    }

    if (stat.isSymbolicLink()) {
      files += 1
      bytes += stat.size
      continue
    }

    if (stat.isFile()) {
      files += 1
      bytes += stat.size
      continue
    }

    if (!stat.isDirectory()) continue

    directories += 1

    try {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry))
    } catch {
      // Unreadable cache entries are reported as zero bytes and skipped.
    }
  }

  return { bytes, files, directories }
}

function existingCodexLogTargets(paths) {
  const targets = []
  const seen = new Set()
  const add = targetPath => {
    const resolved = path.resolve(targetPath)
    const key = resolved.toLowerCase()

    if (!fs.existsSync(resolved) || seen.has(key)) return
    seen.add(key)
    targets.push(resolved)
  }

  for (const root of [paths.codexHome, path.join(paths.codexHome, 'sqlite')]) {
    if (!fs.existsSync(root)) continue

    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (/^logs_\d+\.sqlite(?:-(?:wal|shm))?$/i.test(entry.name) || /^codex-login\.log$/i.test(entry.name)) {
          add(path.join(root, entry.name))
        }
      }
    } catch {
      // The scan result will simply omit unreadable legacy log folders.
    }
  }

  for (const directoryName of ['log', 'logs']) add(path.join(paths.codexHome, directoryName))

  return targets
}

function diskMaintenanceTargets(paths) {
  return [
    {
      id: 'logs',
      label: 'Codex 日志数据库',
      paths: existingCodexLogTargets(paths)
    },
    {
      id: 'temp',
      label: '临时下载与插件暂存',
      paths: [path.join(paths.codexHome, '.tmp')].filter(target => fs.existsSync(target))
    },
    {
      id: 'cache',
      label: '可重新下载的普通缓存',
      paths: [path.join(paths.codexHome, 'cache')].filter(target => fs.existsSync(target))
    }
  ]
}

function inspectCodexDiskUsage(options = {}) {
  const paths = getPaths(options)
  const categories = diskMaintenanceTargets(paths).map(category => {
    const summary = category.paths.reduce(
      (total, targetPath) => {
        const item = diskPathSummary(targetPath)

        total.bytes += item.bytes
        total.files += item.files
        total.directories += item.directories
        return total
      },
      { bytes: 0, files: 0, directories: 0 }
    )

    return { ...category, ...summary }
  })
  const topLevel = fs.existsSync(paths.codexHome)
    ? fs.readdirSync(paths.codexHome).map(name => path.join(paths.codexHome, name))
    : []
  const totalCodexBytes = topLevel.reduce((total, targetPath) => total + diskPathSummary(targetPath).bytes, 0)
  const sessionBytes = diskPathSummary(paths.sessionsPath).bytes
  const archivedSessionBytes = diskPathSummary(paths.archivedSessionsPath).bytes
  const reclaimableBytes = categories.reduce((total, category) => total + category.bytes, 0)

  return {
    scannedAt: new Date().toISOString(),
    codexHome: paths.codexHome,
    totalCodexBytes,
    reclaimableBytes,
    sessionBytes,
    archivedSessionBytes,
    categories
  }
}

function assertSafeMaintenanceTarget(targetPath, paths) {
  const resolved = path.resolve(targetPath)
  const codexHome = path.resolve(paths.codexHome)
  const allowed = new Set(
    diskMaintenanceTargets(paths)
      .flatMap(category => category.paths)
      .map(item => path.resolve(item).toLowerCase())
  )

  if (resolved === codexHome || !resolved.toLowerCase().startsWith(`${codexHome.toLowerCase()}${path.sep}`)) {
    throw new Error(`拒绝维护 Codex 数据目录以外的路径：${resolved}`)
  }
  if (!allowed.has(resolved.toLowerCase())) throw new Error(`拒绝维护未列入安全清单的路径：${resolved}`)

  return resolved
}

function maintainCodexDisk(options = {}) {
  if (options.confirmed !== true) throw new Error('磁盘维护需要用户确认。')

  const paths = getPaths(options)
  const before = inspectCodexDiskUsage(options)
  const stopClients = options.stopClients || stopRunningCodexClients
  const stopResult =
    process.platform === 'win32' || options.forceWindowsMaintenance
      ? stopClients(options.stopOptions)
      : { ok: true, stopped: 0, remaining: [] }

  if (!stopResult?.ok) {
    const remaining =
      Array.isArray(stopResult?.remaining) && stopResult.remaining.length
        ? `仍在运行：${stopResult.remaining.join('、')}`
        : stopResult?.error || 'Windows 拒绝结束旧实例'

    throw new Error(`Codex 尚未完全关闭，磁盘维护已取消，未删除任何文件。${remaining}`)
  }

  const removed = []
  const errors = []

  for (const category of diskMaintenanceTargets(paths)) {
    for (const targetPath of category.paths) {
      let resolved = ''

      try {
        resolved = assertSafeMaintenanceTarget(targetPath, paths)
        const summary = diskPathSummary(resolved)

        fs.rmSync(resolved, {
          recursive: fs.lstatSync(resolved).isDirectory(),
          force: true,
          maxRetries: 5,
          retryDelay: 300
        })
        removed.push({ category: category.id, path: resolved, bytes: summary.bytes })
      } catch (error) {
        errors.push({
          category: category.id,
          path: resolved || String(targetPath),
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  const restartClient = options.restartClient || restartCodex
  const restart =
    options.restart === false
      ? { ok: true, skipped: true, target: null, targets: [] }
      : restartClient({
          dryRun: options.dryRunRestart,
          stopClients: () => ({ ok: true, stopped: 0, remaining: [] })
        })
  const after = inspectCodexDiskUsage(options)

  return {
    ok: errors.length === 0,
    before,
    after,
    stoppedProcessCount: Number(stopResult.stopped) || 0,
    removed,
    removedBytes: removed.reduce((total, item) => total + item.bytes, 0),
    errors,
    restart
  }
}

function skillFrontmatter(skillPath) {
  const markerPath = path.join(skillPath, 'SKILL.md')

  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    throw new Error('缺少 SKILL.md')
  }
  if (fs.statSync(markerPath).size > 2 * 1024 * 1024) throw new Error('SKILL.md 超过 2 MB')
  const text = fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '')
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)

  if (!match) throw new Error('SKILL.md 缺少 YAML front matter')
  const name = match[1].match(/^\s*name\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  const description = match[1].match(/^\s*description\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')

  if (!name) throw new Error('SKILL.md front matter 缺少 name')
  if (!description) throw new Error('SKILL.md front matter 缺少 description')

  return { name, description }
}

function agentDefinition(agentPath) {
  if (!fs.existsSync(agentPath) || !fs.statSync(agentPath).isFile()) throw new Error('Agent 配置不是文件')
  if (path.extname(agentPath).toLowerCase() !== '.toml') throw new Error('Agent 配置必须是 .toml 文件')
  if (fs.statSync(agentPath).size > 2 * 1024 * 1024) throw new Error('Agent 配置超过 2 MB')
  const parsed = parseConfig(fs.readFileSync(agentPath, 'utf8').replace(/^\uFEFF/, ''))
  const required = ['name', 'description', 'developer_instructions']

  for (const field of required) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`Agent 配置缺少 ${field}`)
    }
  }

  return {
    name: parsed.name.trim(),
    description: parsed.description.trim()
  }
}

function listSkillRoot(rootPath, source) {
  if (!fs.existsSync(rootPath)) return []

  return fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter(entry => entry.name !== '.system')
    .map(entry => {
      const fullPath = path.join(rootPath, entry.name)
      let stat

      try {
        stat = fs.statSync(fullPath)
      } catch {
        return null
      }
      if (!stat.isDirectory()) return null
      const summary = directorySummary(fullPath)

      try {
        const metadata = skillFrontmatter(fullPath)

        return {
          name: entry.name,
          displayName: metadata.name,
          description: metadata.description,
          path: fullPath,
          kind: 'directory',
          size: summary.size,
          updatedAt: summary.updatedAt,
          source,
          valid: true
        }
      } catch (error) {
        return {
          name: entry.name,
          path: fullPath,
          kind: 'directory',
          size: summary.size,
          updatedAt: summary.updatedAt,
          source,
          valid: false,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    })
    .filter(Boolean)
}

function listSkills(options = {}) {
  const paths = getPaths(options)
  const roots = [
    { path: paths.skillsPath, source: 'user' },
    { path: paths.legacySkillsPath, source: 'legacy' }
  ].filter(
    (item, index, items) =>
      items.findIndex(other => path.resolve(other.path).toLowerCase() === path.resolve(item.path).toLowerCase()) ===
      index
  )

  return roots
    .flatMap(item => listSkillRoot(item.path, item.source))
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
}

function listAgents(options = {}) {
  const paths = getPaths(options)

  if (!fs.existsSync(paths.agentsPath)) return []

  return fs
    .readdirSync(paths.agentsPath, { withFileTypes: true })
    .map(entry => {
      const fullPath = path.join(paths.agentsPath, entry.name)
      let stat

      try {
        stat = fs.statSync(fullPath)
      } catch {
        return null
      }
      if (stat.isFile() && path.extname(entry.name).toLowerCase() === '.toml') {
        try {
          const metadata = agentDefinition(fullPath)

          return {
            name: path.basename(entry.name, '.toml'),
            displayName: metadata.name,
            description: metadata.description,
            path: fullPath,
            kind: 'file',
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            source: 'custom-agent',
            valid: true
          }
        } catch (error) {
          return {
            name: path.basename(entry.name, '.toml'),
            path: fullPath,
            kind: 'file',
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            source: 'custom-agent',
            valid: false,
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
      if (!stat.isDirectory()) return null
      const summary = directorySummary(fullPath)

      return {
        name: entry.name,
        path: fullPath,
        kind: 'directory',
        size: summary.size,
        updatedAt: summary.updatedAt,
        source: 'legacy-agent-directory',
        valid: false,
        message: '旧目录格式不会被当前 Codex 作为自定义 Agent 加载；请导入包含必填字段的 .toml 配置'
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function resolveListedPackage(items, identifier, label) {
  const requested = String(identifier || '').trim()

  if (!requested) throw new Error(`未指定 ${label}`)
  const exactPath = items.find(item => path.resolve(item.path).toLowerCase() === path.resolve(requested).toLowerCase())

  if (exactPath) return exactPath.path
  const byName = items.filter(item => item.name === requested)

  if (byName.length === 1) return byName[0].path
  if (byName.length > 1) throw new Error(`${label} 名称重复，请按完整路径导出`)
  throw new Error(`未找到 ${label}`)
}

function saveChannels(channelsPath, channels) {
  ensureDir(path.dirname(channelsPath))
  fs.writeFileSync(channelsPath, `${JSON.stringify(channels, null, 2)}\n`, 'utf8')
}

function formatTomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return JSON.stringify(String(value))
}

function getFirstTableIndex(lines) {
  const tableIndex = lines.findIndex(line => /^\s*\[/.test(line))
  return tableIndex === -1 ? lines.length : tableIndex
}

function setRootKey(text, key, value) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : []
  const rootEnd = getFirstTableIndex(lines)
  const nextLine = `${key} = ${formatTomlValue(value)}`

  for (let index = 0; index < rootEnd; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = nextLine
      return `${lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd()}\n`
    }
  }

  lines.splice(rootEnd, 0, nextLine)
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function setTableKey(text, tableName, key, value) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : []
  const header = `[${tableName}]`
  const tableStart = lines.findIndex(line => line.trim() === header)
  const nextLine = `${key} = ${formatTomlValue(value)}`

  if (tableStart === -1) {
    const prefix = lines.join('\n').trimEnd()

    return `${prefix ? `${prefix}\n\n` : ''}${header}\n${nextLine}\n`
  }

  let tableEnd = lines.length

  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      tableEnd = index
      break
    }
  }

  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = nextLine
      return `${lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd()}\n`
    }
  }

  lines.splice(tableEnd, 0, nextLine)
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function removeRootKey(text, key) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const rootEnd = getFirstTableIndex(lines)
  const filtered = lines.filter((line, index) => index >= rootEnd || !new RegExp(`^\\s*${key}\\s*=`).test(line))

  return `${filtered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function removeTableBlock(text, tableName) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const result = []
  let skipping = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === `[${tableName}]`) {
      skipping = true
      continue
    }

    if (skipping && /^\[/.test(trimmed)) {
      skipping = false
    }

    if (!skipping) result.push(line)
  }

  return `${result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function protocolProxyBaseUrl(options = {}) {
  return String(
    options.proxyBaseUrl || process.env.CODEX_MM_PROXY_BASE_URL || `http://127.0.0.1:${DEFAULT_PROTOCOL_PROXY_PORT}`
  ).replace(/\/+$/, '')
}

function managedChannelFromConfig(parsed, channels) {
  const managedChannels = channels.filter(channel => channel?.managed)
  const currentProvider = String(parsed?.model_provider || 'openai')
  const directMatch = managedChannels.find(channel => channel.id === currentProvider)

  if (directMatch) return directMatch
  if (currentProvider !== 'openai') return null

  const openaiBaseUrl = String(parsed?.openai_base_url || '').trim()

  if (!openaiBaseUrl) return null

  try {
    const url = new URL(openaiBaseUrl)
    const pathParts = url.pathname.split('/').filter(Boolean)
    const channelId = decodeURIComponent(pathParts.at(-1) || '')
    const proxyMatch = managedChannels.find(channel => channel.id === channelId)

    if (proxyMatch && pathParts.at(-2)?.toLowerCase() === 'v1') return proxyMatch
  } catch {
    // A malformed URL is handled by the normal config validation path.
  }

  const normalizedBaseUrl = normalizeBaseUrl(openaiBaseUrl)

  return managedChannels.find(channel => normalizeBaseUrl(channel.baseUrl) === normalizedBaseUrl) || null
}

function removeManagedProviderBlocks(text, channels) {
  let next = text

  for (const channel of channels.filter(item => item?.managed)) {
    next = removeTableBlock(next, `model_providers.${channel.id}`)
  }

  return next
}

function manualCodexRestartResult() {
  return {
    ok: true,
    skipped: true,
    manual: true,
    target: null,
    targets: [],
    message: '配置已写入。请手动关闭并重新打开 Codex 使配置生效。'
  }
}

function refreshManagedProviderProxyBaseUrl(options = {}) {
  const paths = getPaths(options)
  const current = readText(paths.configPath)
  const parsed = parseConfig(current || '')
  const currentProvider = String(parsed.model_provider || '')
  const channels = parseJsonFile(paths.channelsPath, [])
  const activeChannel = managedChannelFromConfig(parsed, channels)

  if (!activeChannel) {
    return { updated: false, reason: 'not-managed-provider', providerId: currentProvider }
  }

  const localBaseUrl = `${protocolProxyBaseUrl(options)}/v1/${encodeURIComponent(activeChannel.id)}`
  const configuredBaseUrl =
    currentProvider === 'openai'
      ? parsed.openai_base_url || ''
      : parsed.model_providers?.[activeChannel.id]?.base_url || ''
  const usesStableOpenaiIdentity = currentProvider === 'openai'

  if (usesStableOpenaiIdentity && normalizeBaseUrl(configuredBaseUrl) === normalizeBaseUrl(localBaseUrl)) {
    return { updated: false, reason: 'already-current', providerId: activeChannel.id, baseUrl: localBaseUrl }
  }

  const before = protectedStateSnapshot(paths, current)

  backupConfig(paths.configPath, current, 'proxy-runtime-refresh')

  try {
    let next = removeManagedProviderBlocks(current, channels)

    next = setRootKey(next, 'model_provider', 'openai')
    next = setRootKey(next, 'openai_base_url', localBaseUrl)
    next = removeRootKey(next, 'preferred_auth_method')
    next = preserveProjectBlocks(current, next)
    parseConfig(next)
    writeText(paths.configPath, next)
    assertNoProtectedStateLoss(before, protectedStateSnapshot(paths, next))
  } catch (error) {
    writeText(paths.configPath, current)
    throw error
  }

  return {
    updated: true,
    reason: usesStableOpenaiIdentity ? 'proxy-port-changed' : 'migrated-to-stable-openai-provider',
    providerId: activeChannel.id,
    codexProviderId: 'openai',
    baseUrl: localBaseUrl
  }
}

function removeProjectBlock(text, projectPath) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const result = []
  let skipping = false

  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed.match(/^\[projects\.(.+)\]$/)

    if (match) {
      let parsedPath = ''
      try {
        const parsed = toml.parse(`[projects.${match[1]}]\ntrust_level = "trusted"\n`)
        parsedPath = Object.keys(parsed.projects || {})[0] || ''
      } catch {
        parsedPath = ''
      }

      skipping = parsedPath.toLowerCase() === projectPath.toLowerCase()
    } else if (skipping && /^\[/.test(trimmed)) {
      skipping = false
    }

    if (!skipping) result.push(line)
  }

  return `${result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function projectTableName(projectPath) {
  return `projects.'${String(projectPath).replace(/'/g, "''")}'`
}

function projectBlocksFromText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = new Map()

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    const match = trimmed.match(/^\[projects\.(.+)\]$/)

    if (!match) continue

    const block = [lines[index]]
    let cursor = index + 1

    while (cursor < lines.length && !/^\s*\[/.test(lines[cursor])) {
      block.push(lines[cursor])
      cursor += 1
    }

    try {
      const parsed = toml.parse(`${block.join('\n')}\n`)
      const projectPath = Object.keys(parsed.projects || {})[0]

      if (projectPath) blocks.set(projectPath, `${block.join('\n').trimEnd()}\n`)
    } catch {
      // Ignore malformed project blocks; parseConfig will catch invalid final config.
    }
  }

  return blocks
}

function preserveProjectBlocks(originalText, candidateText) {
  const originalBlocks = projectBlocksFromText(originalText)
  if (!originalBlocks.size) return candidateText

  const candidateBlocks = projectBlocksFromText(candidateText)
  let next = candidateText.trimEnd()

  for (const [projectPath, block] of originalBlocks.entries()) {
    if (!candidateBlocks.has(projectPath)) {
      next = `${next}\n\n${block.trimEnd()}`
    }
  }

  return `${next.trimEnd()}\n`
}

function protectedStateSnapshot(paths, configText) {
  const parsed = parseConfig(configText || '')

  return {
    projects: listProjects(parsed).map(project => ({
      path: project.path,
      trustLevel: project.trustLevel
    })),
    sessions: listSessions(paths).map(session => ({
      path: session.path,
      id: session.id,
      location: session.location
    }))
  }
}

function assertNoProtectedStateLoss(before, after) {
  const projectKey = project => `${project.path}\u0000${project.trustLevel}`
  const sessionKey = session => `${session.path}\u0000${session.id}\u0000${session.location}`
  const afterProjects = new Set(after.projects.map(projectKey))
  const afterSessions = new Set(after.sessions.map(sessionKey))
  const missingProjects = before.projects.filter(project => !afterProjects.has(projectKey(project)))
  const missingSessions = before.sessions.filter(session => !afterSessions.has(sessionKey(session)))

  if (missingProjects.length || missingSessions.length) {
    throw new Error('渠道切换被取消：检测到项目或对话快照会丢失，已保留原配置。')
  }
}

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
}

function normalizeUrlRoot(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

function newApiRootFromInput(value) {
  const root = normalizeUrlRoot(value)

  if (!root) throw new Error('请填写 NewAPI 地址')

  let parsed
  try {
    parsed = new URL(root)
  } catch {
    throw new Error('NewAPI 地址必须是有效的 http:// 或 https:// 地址')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('NewAPI 地址只支持 http:// 或 https://')
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  if (/\/v1$/i.test(parsed.pathname)) parsed.pathname = parsed.pathname.slice(0, -3) || '/'
  if (/\/api$/i.test(parsed.pathname)) parsed.pathname = parsed.pathname.slice(0, -4) || '/'

  parsed.search = ''
  parsed.hash = ''

  return parsed.toString().replace(/\/+$/, '')
}

function newApiRelayBaseUrl(root) {
  return `${newApiRootFromInput(root)}/v1`
}

function newApiRelayBaseFromInput(value, root) {
  const relayBase = normalizeUrlRoot(value || newApiRelayBaseUrl(root))

  if (!relayBase) throw new Error('请填写 API 接口地址')

  let parsed
  try {
    parsed = new URL(relayBase)
  } catch {
    throw new Error('API 接口地址必须是有效的 http:// 或 https:// 地址')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('API 接口地址只支持 http:// 或 https://')
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.search = ''
  parsed.hash = ''

  return parsed.toString().replace(/\/+$/, '')
}

function slugifyProviderName(name) {
  const value = String(name || 'relay')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)

  return value || 'relay'
}

function envKeyForProvider(id) {
  return `CODEX_MM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function envKeyForNewApiToken(providerId, tokenId) {
  return `CODEX_MM_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN_${String(tokenId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function maskKey(value) {
  if (!value) return ''
  if (value.length <= 10) return '********'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

async function mapWithConcurrency(values, limit, mapper) {
  const items = Array.isArray(values) ? values : []
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor

      cursor += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })

  await Promise.all(workers)

  return results
}

function normalizeRelayInput(input) {
  const name = String(input.name || '').trim()
  const baseUrl = String(input.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  const apiKey = String(input.apiKey || '').trim()
  const models = uniqueModelList(input)
  const model = String(input.model || models[0] || 'gpt-5.6').trim()
  const wireApi = input.wireApi === 'responses' ? 'responses' : 'chat'
  const keySource = input.keySource === 'newapi' ? 'newapi' : 'manual'
  const newApi =
    keySource === 'newapi' && input.newApi && typeof input.newApi === 'object'
      ? {
          baseUrl: newApiRootFromInput(input.newApi.baseUrl || baseUrl),
          tokenId: input.newApi.tokenId ?? '',
          tokenName: String(input.newApi.tokenName || '').trim(),
          tokenKeyMask: String(input.newApi.tokenKeyMask || '').trim()
        }
      : null

  if (!name) throw new Error('请填写中转站名称')
  if (!model || !models.length) throw new Error('请至少填写一个模型名称')

  let parsedUrl
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('URL 必须是有效的 http:// 或 https:// 地址')
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('URL 只支持 http:// 或 https://')
  }

  return {
    name,
    baseUrl,
    apiKey,
    model: models.includes(model) ? model : models[0],
    models,
    wireApi,
    keySource,
    newApi
  }
}

async function testRelay(input, options = {}) {
  const normalized = normalizeRelayInput(input)
  const startedAt = Date.now()
  const initialProfile = modelAdapterProfile(normalized.model)

  if (!initialProfile.available) {
    return {
      ok: false,
      chatOk: false,
      streamOk: false,
      agentToolOk: false,
      toolTransport: '',
      wireApi: '',
      status: 0,
      latencyMs: 0,
      chatLatencyMs: 0,
      streamLatencyMs: 0,
      agentToolLatencyMs: 0,
      actualModel: '',
      adapter: '',
      interfaceStatus: 'unsupported',
      agentToolMessage: initialProfile.reason,
      message: initialProfile.reason
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 90000)

  try {
    const chatStartedAt = Date.now()
    let chat

    const tryEndpoint = async endpointTest => {
      try {
        return await endpointTest(normalized, controller.signal)
      } catch (error) {
        return {
          ok: false,
          status: 0,
          actualModel: '',
          message: error instanceof Error ? error.message : '请求失败'
        }
      }
    }

    const firstTest = initialProfile.wireApi === 'responses' ? testResponsesEndpoint : testChatCompletionEndpoint
    const secondTest = initialProfile.wireApi === 'responses' ? testChatCompletionEndpoint : testResponsesEndpoint
    const first = await tryEndpoint(firstTest)

    if (first.ok) {
      chat = first
    } else {
      const second = await tryEndpoint(secondTest)

      chat = second.ok
        ? second
        : {
            ...first,
            message:
              initialProfile.wireApi === 'responses'
                ? `Responses：${first.message || '失败'}；Chat Completions：${second.message || '失败'}`
                : `Chat Completions：${first.message || '失败'}；Responses：${second.message || '失败'}`
          }
    }

    const chatLatencyMs = Date.now() - chatStartedAt
    if (!chat.ok) {
      return {
        ok: false,
        chatOk: false,
        streamOk: false,
        agentToolOk: false,
        toolTransport: '',
        wireApi: chat.wireApi || '',
        status: chat.status,
        latencyMs: Date.now() - startedAt,
        chatLatencyMs,
        streamLatencyMs: 0,
        agentToolLatencyMs: 0,
        actualModel: chat.actualModel || '',
        adapter: '',
        interfaceStatus: 'failed',
        agentToolMessage: '',
        message: `聊天测试失败：${chat.message || '没有返回有效助手消息'}`
      }
    }

    const resolvedProfile = modelAdapterProfile(normalized.model, { wireApi: chat.wireApi })
    const streamStartedAt = Date.now()
    const stream =
      chat.wireApi === 'responses'
        ? { ok: true, status: chat.status, actualModel: chat.actualModel || '', message: '' }
        : await tryEndpoint(testChatStreamingEndpoint)
    const streamLatencyMs = Date.now() - streamStartedAt
    const agentToolStartedAt = Date.now()
    let agentTool =
      chat.wireApi === 'responses'
        ? await tryEndpoint(testResponsesAgentToolEndpoint)
        : await tryEndpoint(testAgentToolEndpoint)
    let toolTransport = 'native'

    if (!agentTool.ok && chat.wireApi === 'chat') {
      const emulated = await tryEndpoint(testPromptEmulatedToolEndpoint)

      if (emulated.ok) {
        agentTool = emulated
        toolTransport = 'prompt-emulated'
      }
    }

    const agentToolLatencyMs = Date.now() - agentToolStartedAt
    const ok = chat.ok && stream.ok && agentTool.ok
    const failureMessage = !stream.ok
      ? `流式响应测试失败：${stream.message || '响应流不完整'}`
      : !agentTool.ok
        ? `工具调用与续答测试失败：${agentTool.message || '模型没有完成工具回环'}`
        : ''

    return {
      ok,
      chatOk: true,
      streamOk: stream.ok,
      agentToolOk: agentTool.ok,
      toolTransport: agentTool.ok ? toolTransport : '',
      wireApi: chat.wireApi || '',
      status: chat.status,
      latencyMs: Date.now() - startedAt,
      chatLatencyMs,
      streamLatencyMs,
      agentToolLatencyMs,
      actualModel: chat.actualModel || stream.actualModel || agentTool.actualModel || '',
      adapter: resolvedProfile.adapter,
      interfaceStatus: ok ? 'supported' : 'failed',
      reasoningEfforts: resolvedProfile.reasoningEfforts,
      speedModes: resolvedProfile.speedModes,
      agentToolMessage: agentTool.message || '',
      message: ok
        ? `聊天、流式响应和工具续答测试通过（${toolTransport === 'native' ? '原生工具调用' : '兼容工具调用'}）`
        : failureMessage
    }
  } catch (error) {
    return {
      ok: false,
      chatOk: false,
      streamOk: false,
      agentToolOk: false,
      toolTransport: '',
      status: 0,
      latencyMs: Date.now() - startedAt,
      chatLatencyMs: 0,
      streamLatencyMs: 0,
      agentToolLatencyMs: 0,
      interfaceStatus: 'failed',
      message: error instanceof Error ? error.message : '测试失败'
    }
  } finally {
    clearTimeout(timer)
  }
}

function relayHeaders(apiKey, extra = {}) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...extra
  }
}

function joinEndpoint(baseUrl, endpoint) {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const lower = normalizedBase.toLowerCase()

  if (endpoint === 'models') {
    if (lower.endsWith('/chat/completions')) return `${normalizedBase.slice(0, -'/chat/completions'.length)}/models`
    if (lower.endsWith('/responses')) return `${normalizedBase.slice(0, -'/responses'.length)}/models`
    if (lower.endsWith('/models')) return normalizedBase
  }

  if (lower.endsWith(`/${endpoint.toLowerCase()}`)) return normalizedBase

  return `${normalizedBase}/${endpoint.replace(/^\/+/, '')}`
}

function summarizeRelayError(text, status) {
  if (!text) return `HTTP ${status}`

  let summary = ''

  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message || parsed?.message || parsed?.error

    if (message) summary = String(message)
  } catch {
    // Plain text error body.
  }

  summary ||= text.replace(/\s+/g, ' ').trim()

  if (/no available channel for model/i.test(summary)) {
    return `NewAPI 上游无可用渠道（不是本地 Agent Loop 故障）：${summary.slice(0, 180)}`
  }

  return summary.slice(0, 220) || `HTTP ${status}`
}

async function readResponseTextLimited(response, maxBytes = MAX_JSON_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0)

  if (contentLength > maxBytes) {
    throw new Error(`接口响应过大（${Math.ceil(contentLength / 1024 / 1024)} MB），已停止读取`)
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()

    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('接口响应超过 32 MB，已停止读取')

    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break
      totalBytes += value.byteLength

      if (totalBytes > maxBytes) {
        await reader.cancel('response-too-large')
        throw new Error('接口响应超过 32 MB，已停止读取')
      }

      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

async function readJsonResponse(response) {
  const text = await readResponseTextLimited(response)

  if (!text.trim()) return { text, data: null }

  try {
    return { text, data: JSON.parse(text) }
  } catch {
    return { text, data: null }
  }
}

async function readJsonEnvelope(response) {
  const { text, data } = await readJsonResponse(response)

  if (!response.ok) {
    throw new Error(summarizeRelayError(text, response.status))
  }

  return { text, parsed: data, data: envelopeData(data), response }
}

function envelopeData(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed
  if (parsed.success === false) throw new Error(parsed.message || 'NewAPI 请求失败')

  return Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed
}

async function fetchJson(endpoint, options = {}) {
  const response = await fetch(endpoint, options)
  const result = await readJsonEnvelope(response)

  return result.data
}

function bearerHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra
  }
}

function withNewApiUserHeader(headers, userHeader) {
  const value = String(userHeader || '').trim()
  const next = { ...headers }

  if (!value) return next

  const hasHeader = Object.keys(next).some(key => key.toLowerCase() === 'new-api-user')

  if (!hasHeader) next['New-Api-User'] = value

  return next
}

function authHeaders(auth, extra = {}) {
  const headers = withNewApiUserHeader(extra, auth?.userHeader)

  if (typeof auth === 'string') return bearerHeaders(auth, headers)
  if (auth?.type === 'cookie') return { cookie: auth.cookie, ...headers }

  return bearerHeaders(auth?.accessToken || auth?.token || '', headers)
}

function setCookieHeaders(headers) {
  const values = []

  if (typeof headers?.getSetCookie === 'function') values.push(...headers.getSetCookie())

  const single = headers?.get?.('set-cookie')
  if (single) values.push(single)

  return values.filter(Boolean)
}

function cookieHeaderFromSetCookie(headers) {
  return setCookieHeaders(headers)
    .flatMap(value => String(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/))
    .map(value => value.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

function findAuthToken(value) {
  if (!value || typeof value !== 'object') return ''

  const directKeys = ['access_token', 'accessToken', 'token', 'auth_token', 'authToken', 'jwt']

  for (const key of directKeys) {
    const token = value[key]

    if (typeof token === 'string' && token.trim()) return token.trim()
  }

  for (const key of ['session', 'auth', 'user', 'data']) {
    const nested = value[key]
    const token = findAuthToken(nested)

    if (token) return token
  }

  return ''
}

function findNewApiUserHeader(username, data, raw) {
  const candidates = [
    data?.user?.id,
    data?.user?.Id,
    data?.user?.user_id,
    data?.user?.userId,
    raw?.data?.user?.id,
    raw?.data?.user?.Id,
    raw?.data?.user?.user_id,
    raw?.data?.user?.userId,
    raw?.user?.id,
    raw?.user?.Id,
    raw?.user?.user_id,
    raw?.user?.userId,
    data?.id,
    data?.Id,
    data?.user_id,
    data?.userId,
    raw?.data?.id,
    raw?.data?.Id,
    raw?.data?.user_id,
    raw?.data?.userId,
    data?.user?.username,
    raw?.data?.user?.username,
    raw?.user?.username,
    data?.username,
    raw?.data?.username,
    raw?.username,
    username
  ]

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()

    if (value) return value
  }

  return ''
}

function pageItems(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.items)) return payload.items
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.list)) return payload.list
  if (Array.isArray(payload.rows)) return payload.rows

  return []
}

function splitModelLimits(value) {
  if (Array.isArray(value)) return uniqueModelList({ models: value })

  return uniqueModelList({
    models: String(value || '')
      .split(/[\n,]+/)
      .map(item => item.trim())
  })
}

function collectModelIds(payload) {
  const models = []
  const push = value => {
    const model = String(value || '').trim()

    if (model) models.push(model.replace(/^models\//, ''))
  }

  const visitArray = value => {
    for (const item of value) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object')
        push(item.id || item.name || item.model || item.display_name || item.displayName)
    }
  }

  if (Array.isArray(payload)) {
    visitArray(payload)
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) visitArray(payload.data)
    if (Array.isArray(payload.models)) visitArray(payload.models)
    if (Array.isArray(payload.items)) visitArray(payload.items)
  }

  return uniqueModelList({ models }).slice(0, MAX_NEWAPI_MODELS)
}

function tokenIdValue(token) {
  return token?.id ?? token?.Id ?? token?.token_id ?? token?.tokenId
}

function tokenNameValue(token) {
  return String(
    token?.name || token?.Name || token?.display_name || token?.displayName || `Token ${tokenIdValue(token) || ''}`
  ).trim()
}

function tokenGroupValue(token) {
  return String(token?.group || token?.Group || '').trim()
}

function tokenStatusValue(token) {
  return Number(token?.status ?? token?.Status ?? 1)
}

function tokenLimitEnabled(token) {
  return Boolean(token?.model_limits_enabled ?? token?.ModelLimitsEnabled)
}

function tokenLimitModels(token) {
  return splitModelLimits(token?.model_limits ?? token?.ModelLimits)
}

function tokenKeyMaskValue(token) {
  return String(token?.key || token?.Key || '').trim()
}

function isProbablyMaskedKey(value) {
  return !value || /\*/.test(value)
}

function normalizeNewApiKey(value) {
  const key = String(value || '').trim()

  if (!key || isProbablyMaskedKey(key) || /^sk-/i.test(key)) return key

  return `sk-${key}`
}

function maskMaybeKey(value) {
  return maskKey(String(value || ''))
}

async function newApiLogin(input, options = {}) {
  const baseUrl = newApiRootFromInput(input.baseUrl)
  const username = String(input.username || '').trim()
  const password = String(input.password || '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000)

  if (!username) throw new Error('请填写 NewAPI 用户名')
  if (!password) throw new Error('请填写 NewAPI 密码')

  try {
    const result = await readJsonEnvelope(
      await fetch(`${baseUrl}/api/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: controller.signal
      })
    )
    const data = result.data
    const raw = result.parsed

    if (data?.require_2fa || raw?.data?.require_2fa)
      throw new Error('该 NewAPI 账号启用了 2FA，本工具暂不支持自动登录 2FA。')

    const accessToken = findAuthToken(data) || findAuthToken(raw)
    const cookie = cookieHeaderFromSetCookie(result.response.headers)
    const user = data?.user || raw?.data?.user || raw?.user || null
    const userHeader = findNewApiUserHeader(username, data, raw)

    if (!accessToken && !cookie) {
      throw new Error('NewAPI 登录成功，但没有返回访问令牌或会话 Cookie。请确认站点版本支持 API 登录。')
    }

    return {
      baseUrl,
      username,
      auth: accessToken ? { type: 'bearer', accessToken, userHeader } : { type: 'cookie', cookie, userHeader },
      accessToken,
      cookie,
      user,
      tokenType: data?.token_type || raw?.data?.token_type || 'Bearer'
    }
  } finally {
    clearTimeout(timer)
  }
}

async function newApiRequest(baseUrl, auth, pathName, options = {}) {
  try {
    return await fetchJson(`${baseUrl}${pathName}`, {
      ...options,
      headers: authHeaders(auth, {
        'content-type': 'application/json',
        ...(options.headers || {})
      })
    })
  } catch (error) {
    throw new Error(`${pathName}：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function listNewApiTokens(baseUrl, auth) {
  const attempts = ['/api/token/?p=0&page_size=1000', '/api/token/?page=1&page_size=1000', '/api/token/']
  let lastError = null

  for (const endpoint of attempts) {
    try {
      const data = await newApiRequest(baseUrl, auth, endpoint, { method: 'GET' })
      const items = pageItems(data)

      if (items.length || data) return items.slice(0, MAX_NEWAPI_TOKENS)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('没有读取到 NewAPI Token 列表')
}

async function getNewApiTokenKeys(baseUrl, auth, tokens) {
  const ids = tokens.map(tokenIdValue).filter(value => value !== undefined && value !== null)
  const keys = {}

  if (ids.length) {
    try {
      const data = await newApiRequest(baseUrl, auth, '/api/token/batch/keys', {
        method: 'POST',
        body: JSON.stringify({ ids })
      })
      const map = data?.keys || data || {}

      for (const [id, key] of Object.entries(map)) {
        if (key) keys[String(id)] = normalizeNewApiKey(key)
      }
    } catch {
      // Some NewAPI deployments disable batch key export; fall back below.
    }
  }

  for (const token of tokens) {
    const id = tokenIdValue(token)
    if (id === undefined || id === null || keys[String(id)]) continue

    try {
      const data = await newApiRequest(baseUrl, auth, `/api/token/${encodeURIComponent(id)}/key`, { method: 'POST' })
      const key = data?.key || data

      if (key) keys[String(id)] = normalizeNewApiKey(key)
    } catch {
      const fallback = tokenKeyMaskValue(token)

      if (!isProbablyMaskedKey(fallback)) keys[String(id)] = normalizeNewApiKey(fallback)
    }
  }

  return keys
}

async function listNewApiKeyModels(relayBaseUrl, apiKey, userHeader) {
  if (!apiKey) return []

  try {
    const data = await fetchJson(`${relayBaseUrl}/models`, {
      method: 'GET',
      headers: relayHeaders(apiKey, withNewApiUserHeader({}, userHeader))
    })

    return collectModelIds(data)
  } catch {
    return []
  }
}

async function syncNewApi(input, options = {}) {
  const paths = getPaths(options)
  const existingState = parseJsonFile(paths.newApiPath, {})
  const requestedBaseUrl = newApiRootFromInput(input.baseUrl || existingState.baseUrl || DEFAULT_NEWAPI_BASE_URL)
  const platformStates = { ...(existingState.platforms || {}) }
  const legacyPlatformKey = existingState.baseUrl ? normalizeBaseUrl(newApiRootFromInput(existingState.baseUrl)) : ''

  if (legacyPlatformKey && !platformStates[legacyPlatformKey] && existingState.username) {
    platformStates[legacyPlatformKey] = {
      baseUrl: existingState.baseUrl,
      relayBaseUrl: existingState.relayBaseUrl,
      username: existingState.username,
      rememberPassword: existingState.rememberPassword,
      rememberedPassword: existingState.rememberedPassword,
      rememberedPasswordEncrypted: existingState.rememberedPasswordEncrypted,
      lastSyncedAt: existingState.lastSyncedAt
    }
  }

  const requestedState =
    platformStates[normalizeBaseUrl(requestedBaseUrl)] ||
    (normalizeBaseUrl(existingState.baseUrl) === normalizeBaseUrl(requestedBaseUrl) ? existingState : {})
  const rememberedPassword = decryptRememberedSecret(requestedState)
  const loginInput = {
    baseUrl: requestedBaseUrl,
    username: input.username || requestedState.username || '',
    password: input.password || rememberedPassword || ''
  }
  const login = await newApiLogin(loginInput, options)
  const relayBaseUrl = newApiRelayBaseFromInput(input.relayBaseUrl || requestedState.relayBaseUrl, login.baseUrl)
  const tokens = await listNewApiTokens(login.baseUrl, login.auth)

  if (!tokens.length) throw new Error('该 NewAPI 账号没有可用 Token')

  const keys = await getNewApiTokenKeys(login.baseUrl, login.auth, tokens)
  const normalizedTokens = await mapWithConcurrency(tokens, 6, async token => {
    const id = tokenIdValue(token)
    const idKey = String(id ?? '')
    const apiKey = keys[idKey] || ''
    const limitModels = tokenLimitModels(token)
    const keyModels = await listNewApiKeyModels(relayBaseUrl, apiKey, login.auth?.userHeader)
    const models = uniqueModelList({ models: keyModels })

    return {
      id,
      name: tokenNameValue(token),
      apiKey,
      keyMask: maskMaybeKey(apiKey) || tokenKeyMaskValue(token),
      status: tokenStatusValue(token),
      group: tokenGroupValue(token),
      remainQuota: token?.remain_quota ?? token?.RemainQuota ?? 0,
      unlimitedQuota: Boolean(token?.unlimited_quota ?? token?.UnlimitedQuota),
      modelLimitsEnabled: tokenLimitEnabled(token),
      modelLimits: limitModels,
      models
    }
  })

  const rememberPassword = input.rememberPassword !== false
  const encryptedPassword = rememberPassword
    ? encryptRememberedSecret(loginInput.password)
    : { value: '', encrypted: false }
  const platformState = {
    baseUrl: login.baseUrl,
    relayBaseUrl,
    username: login.username,
    rememberPassword,
    rememberedPassword: encryptedPassword.value,
    rememberedPasswordEncrypted: encryptedPassword.encrypted,
    lastSyncedAt: new Date().toISOString()
  }
  const state = {
    ...platformState,
    platforms: {
      ...platformStates,
      [normalizeBaseUrl(login.baseUrl)]: platformState
    }
  }

  if (!options.skipNewApiWrite) writeText(paths.newApiPath, `${JSON.stringify(state, null, 2)}\n`)

  const hostLabel = new URL(login.baseUrl).hostname
  const usableTokens = normalizedTokens.filter(token => token.status === 1 && token.apiKey)

  if (!usableTokens.length) throw new Error('该 NewAPI 账号没有可用的完整 Key')
  const modelReadyTokens = usableTokens.filter(token => token.models.length)

  if (!modelReadyTokens.length) {
    throw new Error('没有任何可用 Key 的 /v1/models 接口返回模型；不会使用 Token 限制或用户组模型代替实际结果。')
  }

  const channels = parseJsonFile(paths.channelsPath, [])
  const matchingChannels = channels.filter(
    channel =>
      channel.keySource === 'newapi' && normalizeBaseUrl(channel.newApi?.baseUrl) === normalizeBaseUrl(login.baseUrl)
  )
  const currentProvider = parseConfig(readText(paths.configPath)).model_provider
  const existing =
    matchingChannels.find(channel => channel.id === currentProvider) ||
    matchingChannels.find(channel => channel.newApi?.keys?.length) ||
    matchingChannels[0]
  const id = existing?.id || `online-${slugifyProviderName(hostLabel)}`
  const selectedToken =
    modelReadyTokens.find(
      token => String(token.id) === String(existing?.newApi?.selectedTokenId ?? existing?.newApi?.tokenId ?? '')
    ) || modelReadyTokens[0]
  const envKey = existing?.envKey || envKeyForProvider(id)
  const keyOptions = usableTokens.map(token => {
    const tokenEnvKey = envKeyForNewApiToken(id, token.id ?? token.name)

    setUserEnvVar(tokenEnvKey, token.apiKey, options)

    return {
      id: token.id,
      name: token.name,
      keyMask: token.keyMask,
      status: token.status,
      group: token.group,
      remainQuota: token.remainQuota,
      unlimitedQuota: token.unlimitedQuota,
      models: token.models,
      envKey: tokenEnvKey
    }
  })

  setUserEnvVar(envKey, selectedToken.apiKey, options)

  const channel = {
    id,
    name: NEWAPI_CHANNEL_DISPLAY_NAME,
    baseUrl: relayBaseUrl,
    model: preferredSupportedModel(selectedToken.models, existing?.model),
    models: selectedToken.models,
    wireApi: 'chat',
    envKey,
    managed: true,
    keySource: 'newapi',
    newApi: {
      baseUrl: login.baseUrl,
      selectedTokenId: selectedToken.id,
      tokenId: selectedToken.id,
      tokenName: selectedToken.name,
      tokenKeyMask: selectedToken.keyMask,
      userHeader: login.auth?.userHeader || '',
      keys: keyOptions
    },
    modelTests: {},
    testStatus: null,
    updatedAt: new Date().toISOString()
  }
  const matchingIds = new Set(matchingChannels.map(item => item.id))
  const nextChannels = channels.filter(item => !matchingIds.has(item.id))

  nextChannels.push(channel)
  saveChannels(paths.channelsPath, nextChannels)

  return {
    ...publicNewApiState(state),
    user: login.user,
    tokens: normalizedTokens,
    channelId: channel.id,
    selectedTokenId: selectedToken.id
  }
}

async function refreshNewApiChannel(id, options = {}) {
  const paths = getPaths(options)
  const channels = parseJsonFile(paths.channelsPath, [])
  const channel = channels.find(item => item.id === id)

  if (!channel || !channel.managed) throw new Error('没有找到可刷新的在线渠道')

  if (channel.keySource !== 'newapi') {
    const apiKey = readUserEnvVar(channel.envKey)

    if (!apiKey) throw new Error('没有找到该渠道保存的完整 API Key，请先编辑并保存 Key。')

    const models = await listNewApiKeyModels(channel.baseUrl, apiKey)

    if (!models.length) throw new Error('当前 Key 的 /v1/models 接口没有返回可用模型。')

    const updated = {
      ...channel,
      model: preferredSupportedModel(models, channel.model),
      models,
      modelTests: {},
      testStatus: null,
      updatedAt: new Date().toISOString()
    }

    saveChannels(
      paths.channelsPath,
      channels.map(item => (item.id === id ? updated : item))
    )

    return {
      tokens: [],
      channelId: channel.id,
      refreshedKeys: false,
      modelCount: models.length,
      status: readStatus(options)
    }
  }

  const state = parseJsonFile(paths.newApiPath, {})
  const baseUrl = newApiRootFromInput(channel.newApi?.baseUrl)
  const platformState =
    state.platforms?.[normalizeBaseUrl(baseUrl)] ||
    (normalizeBaseUrl(state.baseUrl) === normalizeBaseUrl(baseUrl) ? state : {})
  const password = decryptRememberedSecret(platformState)

  if (!platformState.username || !password) {
    throw new Error('该平台没有保存登录凭据，请点击编辑重新登录后再刷新。')
  }

  const result = await syncNewApi(
    {
      baseUrl,
      relayBaseUrl: channel.baseUrl || platformState.relayBaseUrl,
      username: platformState.username,
      password,
      rememberPassword: true
    },
    options
  )

  const selectedToken = result.tokens.find(token => String(token.id) === String(result.selectedTokenId))

  return {
    ...result,
    refreshedKeys: true,
    modelCount: selectedToken?.models?.length || 0,
    status: readStatus(options)
  }
}

async function selectNewApiKey(id, tokenId, options = {}) {
  const paths = getPaths(options)
  const channels = parseJsonFile(paths.channelsPath, [])
  const channel = channels.find(item => item.id === id)

  if (!channel || channel.keySource !== 'newapi') throw new Error('没有找到该在线平台')

  const keys = Array.isArray(channel.newApi?.keys) ? channel.newApi.keys : []
  const selected = keys.find(item => String(item.id) === String(tokenId))

  if (!selected) throw new Error('没有找到所选 Key，请重新同步该在线平台')

  const apiKey = readUserEnvVar(selected.envKey)

  if (!apiKey) throw new Error('所选 Key 的完整密钥不存在，请重新登录并同步该在线平台')

  const models = await listNewApiKeyModels(channel.baseUrl, apiKey, channel.newApi?.userHeader)

  if (!models.length) throw new Error('该 Key 的 /v1/models 接口没有返回可用模型')

  const updated = {
    ...channel,
    model: preferredSupportedModel(models),
    models,
    newApi: {
      ...channel.newApi,
      selectedTokenId: selected.id,
      tokenId: selected.id,
      tokenName: selected.name,
      tokenKeyMask: selected.keyMask,
      keys: keys.map(item => (String(item.id) === String(selected.id) ? { ...item, models } : item))
    },
    modelTests: {},
    testStatus: null,
    updatedAt: new Date().toISOString()
  }

  saveChannels(
    paths.channelsPath,
    channels.map(item => (item.id === id ? updated : item))
  )

  return { channel: updated, models, status: readStatus(options) }
}

function selectedNewApiKey(channel) {
  if (channel?.keySource !== 'newapi') return ''

  const keys = Array.isArray(channel.newApi?.keys) ? channel.newApi.keys : []
  const selectedTokenId = channel.newApi?.selectedTokenId ?? channel.newApi?.tokenId
  const selected = keys.find(item => String(item.id) === String(selectedTokenId))

  return selected?.envKey ? readUserEnvVar(selected.envKey) : ''
}

async function postChatCompletion(endpoint, apiKey, body, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: relayHeaders(apiKey),
    body: JSON.stringify(body),
    signal
  })
  const text = await readResponseTextLimited(response)
  let actualModel = ''
  let data = null

  if (text.trim()) {
    try {
      data = JSON.parse(text)
      actualModel = String(data?.model || '').trim()
    } catch {
      data = null
    }
  }

  const validChatResponse = Boolean(
    data && Array.isArray(data.choices) && data.choices.length && data.choices[0]?.message
  )

  return {
    ok: response.ok && validChatResponse,
    wireApi: 'chat',
    status: response.status,
    actualModel,
    message: !response.ok
      ? summarizeRelayError(text, response.status)
      : validChatResponse
        ? ''
        : '接口返回成功，但不是有效的 NewAPI Chat Completions 响应'
  }
}

async function testChatCompletionEndpoint(normalized, signal) {
  return postChatCompletion(
    joinEndpoint(normalized.baseUrl, 'chat/completions'),
    normalized.apiKey,
    {
      model: normalized.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 128,
      temperature: 0,
      stream: false
    },
    signal
  )
}

async function testResponsesEndpoint(normalized, signal) {
  const { response, text, parsed, attempts } = await postResponsesProbe(normalized, signal, {
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Reply with OK.' }]
      }
    ],
    ...responsesProbeRuntimeOptions(normalized.model)
  })

  return {
    ok: response.ok && parsed.completed,
    wireApi: 'responses',
    status: response.status,
    actualModel: parsed.actualModel,
    message: !response.ok
      ? summarizeRelayError(text, response.status)
      : parsed.completed
        ? ''
        : responsesProbeFailureMessage(parsed, '接口返回成功，但不是有效的 OpenAI Responses 聊天响应', attempts)
  }
}

function responsesProbeFailureMessage(parsed, fallback, attempts = 1) {
  const failure = parsed?.failure

  if (!failure) return fallback

  const details = [...new Set([failure.code, failure.type, failure.reason, failure.message].filter(Boolean))]
  const terminal = failure.terminalType || 'response.failed'
  const prefix =
    attempts > 1 && isTransientResponsesProbeFailure(parsed)
      ? `上游临时不可用，已自动重试 ${attempts} 次（${terminal}）`
      : `Responses 流返回 ${terminal}`

  return details.length ? `${prefix}：${details.join(' / ')}` : prefix
}

async function waitForResponsesProbeRetry(signal, attempt) {
  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

  await new Promise(resolve => setTimeout(resolve, 200 * attempt))

  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

async function postResponsesProbe(normalized, signal, body) {
  let lastResult = null

  for (let attempt = 1; attempt <= RESPONSES_PROBE_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(joinEndpoint(normalized.baseUrl, 'responses'), {
      method: 'POST',
      headers: relayHeaders(normalized.apiKey),
      body: JSON.stringify({ model: normalized.model, store: false, ...body }),
      signal
    })
    const text = await readResponseTextLimited(response)
    const parsed = parseResponsesProbePayload(text)

    lastResult = { response, text, parsed, attempts: attempt }

    if (!isTransientResponsesProbeFailure(parsed, response.status) || attempt === RESPONSES_PROBE_MAX_ATTEMPTS) {
      return lastResult
    }

    await waitForResponsesProbeRetry(signal, attempt)
  }

  return lastResult
}

async function requestAgentToolProbe(normalized, signal, toolChoice) {
  const toolName = 'codex_local_tool_probe'
  const response = await fetch(joinEndpoint(normalized.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: relayHeaders(normalized.apiKey),
    body: JSON.stringify({
      model: normalized.model,
      messages: [
        {
          role: 'system',
          content:
            'You are running inside Codex. Use the provided tool for this request. Return a tool call and do not answer with normal text.'
        },
        { role: 'user', content: 'Call codex_local_tool_probe now with ack set to OK.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: toolName,
            description: 'Probe whether the model can emit a Codex-compatible function tool call.',
            parameters: {
              type: 'object',
              properties: { ack: { type: 'string', description: 'Set this to OK.' } },
              required: ['ack'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: toolChoice,
      parallel_tool_calls: false,
      max_tokens: 128,
      temperature: 0,
      stream: false
    }),
    signal
  })
  const text = await readResponseTextLimited(response)
  let data = null

  try {
    data = text.trim() ? JSON.parse(text) : null
  } catch {
    data = null
  }

  const actualModel = String(data?.model || '').trim()
  const toolCalls = data?.choices?.[0]?.message?.tool_calls
  const matchingCall = Array.isArray(toolCalls)
    ? toolCalls.find(call => call?.type === 'function' && call?.function?.name === toolName)
    : null

  return {
    ok: response.ok && Boolean(matchingCall),
    status: response.status,
    actualModel,
    toolCall: matchingCall || null,
    message: !response.ok
      ? summarizeRelayError(text, response.status)
      : matchingCall
        ? ''
        : '接口能够聊天，但模型没有返回 OpenAI 兼容的 tool_calls'
  }
}

async function requestAgentToolResultProbe(normalized, signal, toolCall) {
  const completionMarker = 'CODEX_TOOL_LOOP_OK'
  const response = await fetch(joinEndpoint(normalized.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: relayHeaders(normalized.apiKey),
    body: JSON.stringify({
      model: normalized.model,
      messages: [
        {
          role: 'system',
          content:
            `You are running inside Codex. The local runtime has executed your tool call. ` +
            `After reading the tool result, reply with exactly ${completionMarker}.`
        },
        { role: 'user', content: 'Use the local probe and then confirm its result.' },
        { role: 'assistant', content: null, tool_calls: [toolCall] },
        {
          role: 'tool',
          tool_call_id: String(toolCall.id || 'call_codex_local_tool_probe'),
          content: JSON.stringify({ ok: true, result: completionMarker })
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'codex_local_tool_probe',
            description: 'Probe whether the model can complete a Codex tool-call round trip.',
            parameters: {
              type: 'object',
              properties: { ack: { type: 'string' } },
              required: ['ack'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: 'none',
      max_tokens: 64,
      temperature: 0,
      stream: false
    }),
    signal
  })
  const text = await readResponseTextLimited(response)
  let data = null

  try {
    data = text.trim() ? JSON.parse(text) : null
  } catch {
    data = null
  }

  const actualModel = String(data?.model || '').trim()
  const message = data?.choices?.[0]?.message
  const content = message?.content
  const completed =
    Boolean(message) &&
    !(Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) &&
    ((typeof content === 'string' && content.trim().length > 0) || (Array.isArray(content) && content.length > 0))

  return {
    ok: response.ok && completed,
    status: response.status,
    actualModel,
    message: !response.ok
      ? summarizeRelayError(text, response.status)
      : completed
        ? ''
        : '模型能够发起工具调用，但没有正确接收本地工具结果并继续回答'
  }
}

async function testAgentToolEndpoint(normalized, signal) {
  const automatic = await requestAgentToolProbe(normalized, signal, 'auto')

  if (!automatic.ok || !automatic.toolCall) {
    const forced = await requestAgentToolProbe(normalized, signal, {
      type: 'function',
      function: { name: 'codex_local_tool_probe' }
    })

    return {
      ...automatic,
      ok: false,
      actualModel: automatic.actualModel || forced.actualModel,
      message: forced.ok
        ? '接口只在强制 tool_choice 时调用工具；Codex 正常 auto 模式下模型不会主动使用本机工具'
        : automatic.message || forced.message
    }
  }

  const resultProbe = await requestAgentToolResultProbe(normalized, signal, automatic.toolCall)

  return {
    ...resultProbe,
    actualModel: resultProbe.actualModel || automatic.actualModel
  }
}

async function testResponsesAgentToolEndpoint(normalized, signal) {
  const toolName = 'codex_local_tool_probe'
  const first = await postResponsesProbe(normalized, signal, {
    instructions:
      'You are running inside Codex. Use the provided function tool now. Do not merely promise to inspect or answer with normal text.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Call codex_local_tool_probe with ack set to OK.' }] }
    ],
    tools: [
      {
        type: 'function',
        name: toolName,
        description: 'Probe a Codex-compatible function tool call.',
        parameters: {
          type: 'object',
          properties: { ack: { type: 'string' } },
          required: ['ack'],
          additionalProperties: false
        },
        strict: false
      }
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    ...responsesProbeRuntimeOptions(normalized.model)
  })
  const toolCall = first.parsed.items.find(item => item?.type === 'function_call' && item?.name === toolName)

  if (!first.response.ok || !toolCall) {
    return {
      ok: false,
      status: first.response.status,
      actualModel: first.parsed.actualModel,
      message: !first.response.ok
        ? summarizeRelayError(first.text, first.response.status)
        : responsesProbeFailureMessage(
            first.parsed,
            'Responses 接口没有返回 Codex 可执行的 function_call',
            first.attempts
          )
    }
  }

  const completionMarker = 'CODEX_TOOL_LOOP_OK'
  const callId = String(toolCall.call_id || toolCall.id || 'call_codex_local_tool_probe')
  const second = await postResponsesProbe(normalized, signal, {
    instructions: `The local Codex runtime executed the function call. Read its function_call_output and reply with exactly ${completionMarker}.`,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Use the local probe and then confirm its result.' }] },
      {
        type: 'function_call',
        call_id: callId,
        name: toolName,
        arguments:
          typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments || {})
      },
      {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: true, result: completionMarker })
      }
    ],
    tools: [
      {
        type: 'function',
        name: toolName,
        description: 'Probe a Codex-compatible function tool call.',
        parameters: {
          type: 'object',
          properties: { ack: { type: 'string' } },
          required: ['ack'],
          additionalProperties: false
        },
        strict: false
      }
    ],
    tool_choice: 'none',
    ...responsesProbeRuntimeOptions(normalized.model)
  })
  const completed = second.response.ok && second.parsed.outputText.includes(completionMarker)

  return {
    ok: completed,
    status: second.response.status,
    actualModel: second.parsed.actualModel || first.parsed.actualModel,
    message: !second.response.ok
      ? summarizeRelayError(second.text, second.response.status)
      : completed
        ? ''
        : responsesProbeFailureMessage(
            second.parsed,
            'Responses 模型发起了工具调用，但读取 function_call_output 后没有继续给出最终答案',
            second.attempts
          )
  }
}

function emulatedToolCallFromText(value, toolName) {
  const text = String(value || '')
  const marker = text.match(/<codex_tool_call>\s*([\s\S]+?)\s*<\/codex_tool_call>/i)
  const candidate = marker?.[1] || text.match(/\{[\s\S]*\}/)?.[0] || ''

  try {
    const parsed = JSON.parse(candidate)

    return parsed?.name === toolName && parsed?.arguments && typeof parsed.arguments === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function testPromptEmulatedToolEndpoint(normalized, signal) {
  const toolName = 'codex_local_tool_probe'
  const firstResponse = await fetch(joinEndpoint(normalized.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: relayHeaders(normalized.apiKey),
    body: JSON.stringify({
      model: normalized.model,
      messages: [
        {
          role: 'system',
          content: `Output only <codex_tool_call>{"name":"${toolName}","arguments":{"ack":"OK"}}</codex_tool_call>.`
        },
        { role: 'user', content: `Call ${toolName} now.` }
      ],
      max_tokens: 128,
      temperature: 0,
      stream: false
    }),
    signal
  })
  const firstText = await readResponseTextLimited(firstResponse)
  let firstData = null

  try {
    firstData = JSON.parse(firstText)
  } catch {
    firstData = null
  }
  const assistantText =
    typeof firstData?.choices?.[0]?.message?.content === 'string' ? firstData.choices[0].message.content : ''
  const toolCall = emulatedToolCallFromText(assistantText, toolName)

  if (!firstResponse.ok || !toolCall) {
    return {
      ok: false,
      status: firstResponse.status,
      actualModel: String(firstData?.model || ''),
      message: !firstResponse.ok
        ? summarizeRelayError(firstText, firstResponse.status)
        : '模型既不支持原生工具调用，也没有按兼容协议生成工具调用'
    }
  }

  const completionMarker = 'CODEX_TOOL_LOOP_OK'
  const secondResponse = await fetch(joinEndpoint(normalized.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: relayHeaders(normalized.apiKey),
    body: JSON.stringify({
      model: normalized.model,
      messages: [
        {
          role: 'system',
          content:
            'You are inside Codex. Never stop after promising to inspect. After a local tool result, continue to a completed answer.'
        },
        { role: 'user', content: `Call ${toolName} and confirm the result.` },
        { role: 'assistant', content: assistantText },
        {
          role: 'user',
          content: `[Codex local tool result]\n${JSON.stringify({ ok: true, result: completionMarker })}\nReply with exactly ${completionMarker}.`
        }
      ],
      max_tokens: 64,
      temperature: 0,
      stream: false
    }),
    signal
  })
  const secondText = await readResponseTextLimited(secondResponse)
  let secondData = null

  try {
    secondData = JSON.parse(secondText)
  } catch {
    secondData = null
  }
  const completedText =
    typeof secondData?.choices?.[0]?.message?.content === 'string' ? secondData.choices[0].message.content : ''
  const completed = secondResponse.ok && completedText.includes(completionMarker)

  return {
    ok: completed,
    status: secondResponse.status,
    actualModel: String(secondData?.model || firstData?.model || ''),
    message: !secondResponse.ok
      ? summarizeRelayError(secondText, secondResponse.status)
      : completed
        ? ''
        : '兼容工具调用后模型没有读取结果并继续回答'
  }
}

async function testChatStreamingEndpoint(normalized, signal) {
  const response = await fetch(joinEndpoint(normalized.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: relayHeaders(normalized.apiKey),
    body: JSON.stringify({
      model: normalized.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 8,
      temperature: 0,
      stream: true
    }),
    signal
  })
  const text = await readResponseTextLimited(response)
  let actualModel = ''
  let sawData = false
  let sawDone = false

  if (response.ok) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()

      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()

      if (payload === '[DONE]') {
        sawDone = true
        continue
      }

      try {
        const event = JSON.parse(payload)

        if (Array.isArray(event?.choices) && event.choices.length) {
          sawData = true
          if (!actualModel) actualModel = String(event.model || '').trim()
        }
      } catch {
        // Ignore comments or provider-specific SSE metadata; a valid choices event is still required.
      }
    }
  }

  const validStream = sawData && sawDone

  return {
    ok: response.ok && validStream,
    status: response.status,
    actualModel,
    message: !response.ok
      ? summarizeRelayError(text, response.status)
      : validStream
        ? ''
        : '接口未返回完整的 data: JSON 事件和 data: [DONE]'
  }
}

function setUserEnvVar(name, value, options = {}) {
  process.env[name] = value

  if (options.skipEnvWrite) return { skipped: true }

  if (process.platform !== 'win32') {
    return { skipped: true, reason: '非 Windows 环境仅写入当前进程变量' }
  }

  execFileSync('setx.exe', [name, value], { windowsHide: true, stdio: 'pipe' })

  return { skipped: false }
}

function readUserEnvVar(name) {
  if (!name) return ''
  if (process.env[name]) return process.env[name]

  if (process.platform !== 'win32') return ''

  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable(${JSON.stringify(name)}, 'User')`],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
  } catch {
    return ''
  }
}

function backupConfig(configPath, text, suffix = 'change') {
  if (!text.trim()) return null

  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const backupPath = `${configPath}.bak-codex-manager-${suffix}-${stamp}`

  fs.writeFileSync(backupPath, text, 'utf8')

  return backupPath
}

function backupAuth(authPath, suffix = 'auth-change') {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const backupPath = `${authPath}.bak-codex-manager-${suffix}-${stamp}`

  if (!fs.existsSync(authPath)) return { existed: false, backupPath: '' }

  fs.copyFileSync(authPath, backupPath)

  return { existed: true, backupPath }
}

function restoreAuthSnapshot(snapshot, authPath) {
  if (!snapshot) return

  if (snapshot.existed && snapshot.backupPath && fs.existsSync(snapshot.backupPath)) {
    ensureDir(path.dirname(authPath))
    fs.copyFileSync(snapshot.backupPath, authPath)
    return
  }

  if (!snapshot.existed && fs.existsSync(authPath)) fs.rmSync(authPath, { force: true })
}

function restoreAuthFromBackup(backupPath, authPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return false

  ensureDir(path.dirname(authPath))
  fs.copyFileSync(backupPath, authPath)

  return true
}

function backupFile(filePath, suffix) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const backupPath = `${filePath}.bak-codex-manager-${suffix}-${stamp}`

  if (!fs.existsSync(filePath)) return { existed: false, backupPath: '' }

  fs.copyFileSync(filePath, backupPath)

  return { existed: true, backupPath }
}

function restoreFileSnapshot(snapshot, filePath) {
  if (!snapshot) return

  if (snapshot.existed && snapshot.backupPath && fs.existsSync(snapshot.backupPath)) {
    ensureDir(path.dirname(filePath))
    fs.copyFileSync(snapshot.backupPath, filePath)
    return
  }

  if (!snapshot.existed && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
}

const reasoningLevel = (effort, description) => ({ effort, description })

function modelDisplayName(model) {
  return String(model || '').trim()
}

function modelReasoningProfile(model, test = null) {
  const profile = modelAdapterProfile(model, test)

  if (!profile.available) return null

  return {
    default_reasoning_level: profile.defaultReasoningEffort,
    supported_reasoning_levels: profile.reasoningEfforts.map(effort =>
      reasoningLevel(effort, REASONING_DESCRIPTIONS[effort] || effort)
    ),
    supports_reasoning_summaries: profile.supportsReasoningSummaries,
    default_reasoning_summary: profile.supportsReasoningSummaries ? 'auto' : 'none',
    support_verbosity: profile.supportsVerbosity,
    default_verbosity: profile.supportsVerbosity ? 'medium' : null,
    additional_speed_tiers: profile.speedModes.includes('fast') ? ['fast'] : [],
    service_tiers: profile.serviceTiers
  }
}

function fallbackModelCatalogEntry(model, priority) {
  return {
    slug: model,
    display_name: modelDisplayName(model),
    description: '',
    minimal_client_version: '0.0.1',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      reasoningLevel('low', 'Low'),
      reasoningLevel('medium', 'Medium'),
      reasoningLevel('high', 'High')
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: `${CODEX_AGENT_BASE_INSTRUCTIONS}\n\n${modelIdentityInstruction(model)}`,
    model_messages: {
      instructions_template: modelIdentityInstruction(model),
      instructions_variables: null,
      approvals: null,
      auto_review: null,
      permissions: null
    },
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 200000,
    max_context_window: 200000,
    comp_hash: '',
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
    use_responses_lite: true,
    tool_mode: 'code_mode',
    multi_agent_version: 'v2'
  }
}

function rewriteCodexModelIdentity(instructions, model) {
  const text = String(instructions || '')

  if (!text) return text
  const identityName = modelIdentityLabel(model)
  const identityInstruction = modelIdentityInstruction(model)
  const withoutManagedIdentity = text
    .replace(/\[(?:Managed model identity|Runtime routing metadata)\][^\r\n]*/g, '')
    .trim()

  const rewritten = withoutManagedIdentity
    .replace(/^You are Codex, (a coding agent|an agent) .*?\.(?=\s|$)/, `You are Codex, $1 based on ${identityName}.`)
    .replace(
      /\b(?:a coding agent|an agent) powered by the currently selected model\b/g,
      `a coding agent based on ${identityName}`
    )
    .replace(/\bbased on GPT-5\b(?=[.,;]|$)/g, `based on ${identityName}`)

  return `${rewritten}\n\n${identityInstruction}`
}

function isManagerFallbackInstructions(instructions) {
  return String(instructions || '').trim() === CODEX_AGENT_BASE_INSTRUCTIONS
}

function readCatalogModels(catalogPath) {
  if (!catalogPath || !fs.existsSync(catalogPath)) return []

  const catalog = parseJsonFile(catalogPath, {})
  return Array.isArray(catalog.models) ? catalog.models : []
}

function selectCodexCapabilityTemplate(modelGroups, selectedSlugs) {
  const candidates = modelGroups
    .flat()
    .filter(item => {
      const slug = String(item?.slug || '').toLowerCase()
      const baseLength = String(item?.base_instructions || '').trim().length
      const templateLength = String(item?.model_messages?.instructions_template || '').trim().length

      return (
        item &&
        !selectedSlugs.has(slug) &&
        !isManagerFallbackInstructions(item.base_instructions) &&
        (baseLength >= 1000 || templateLength >= 1000)
      )
    })
    .sort((left, right) => {
      const score = item =>
        (String(item?.tool_mode || '').startsWith('code_mode') ? 1000 : 0) +
        (item?.shell_type === 'shell_command' ? 500 : 0) +
        (item?.supported_in_api === true ? 100 : 0) +
        (item?.visibility === 'list' ? 50 : 0) -
        Number(item?.priority || 0)

      return score(right) - score(left)
    })

  return candidates[0] || null
}

function captureBundledModelCatalog(paths, options = {}) {
  if (options.skipBundledModelCapture) return ''

  const cachedModels = readCatalogModels(paths.nativeModelsPath)

  if (
    cachedModels.some(
      item =>
        String(item?.base_instructions || '').trim().length >= 1000 &&
        item?.shell_type === 'shell_command' &&
        String(item?.tool_mode || '').startsWith('code_mode')
    )
  ) {
    return paths.nativeModelsPath
  }

  const codexPath = findCodexCli(options)

  if (!codexPath) return ''

  try {
    const output = execFileSync(codexPath, ['debug', 'models', '--bundled'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024
    })
    const catalog = JSON.parse(String(output || '').replace(/^\uFEFF/, ''))
    const models = Array.isArray(catalog?.models) ? catalog.models : []
    const capabilityTemplate = selectCodexCapabilityTemplate([models], new Set())

    if (!capabilityTemplate) return ''

    ensureDir(path.dirname(paths.nativeModelsPath))
    writeText(
      paths.nativeModelsPath,
      `${JSON.stringify({ ...catalog, captured_at: new Date().toISOString(), models }, null, 2)}\n`
    )

    return paths.nativeModelsPath
  } catch {
    return ''
  }
}

function doctorIssue(check) {
  return {
    id: String(check?.id || ''),
    status: String(check?.status || 'unknown'),
    summary: String(check?.summary || 'Codex Doctor 检测异常').slice(0, 300),
    remediation: String(check?.remediation || check?.issues?.[0]?.remedy || '').slice(0, 500)
  }
}

function isProviderDoctorIssue(check) {
  const id = String(check?.id || '').toLowerCase()

  return (
    id === 'network.provider_reachability' ||
    id === 'network.websocket_reachability' ||
    id.startsWith('provider.') ||
    id.startsWith('auth.')
  )
}

function buildModelAliasAssignments(nativeModels, externalModels) {
  const slots = (Array.isArray(nativeModels) ? nativeModels : [])
    .filter(item => item?.visibility === 'list' && typeof item?.slug === 'string' && item.slug.trim())
    .sort((left, right) => {
      const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999)

      return priority || String(left.slug).localeCompare(String(right.slug))
    })
  const freeSlots = new Map(slots.map(slot => [slot.slug.toLowerCase(), slot]))
  const assignments = new Map()

  for (const model of externalModels) {
    const exact = freeSlots.get(model.toLowerCase())

    if (!exact) continue
    assignments.set(model, exact)
    freeSlots.delete(exact.slug.toLowerCase())
  }

  const remainingSlots = [...freeSlots.values()]

  for (const model of externalModels) {
    if (assignments.has(model) || !remainingSlots.length) continue
    assignments.set(model, remainingSlots.shift())
  }

  return externalModels
    .filter(model => assignments.has(model))
    .map(model => ({ model, nativeModel: assignments.get(model) }))
}

function readModelAliases(filePath) {
  const parsed = parseJsonFile(filePath, {})

  if (parsed?.version !== 1 || !parsed.aliases || typeof parsed.aliases !== 'object' || Array.isArray(parsed.aliases)) {
    return { version: 1, channelId: '', aliases: {}, reverse: {} }
  }

  const aliases = Object.fromEntries(
    Object.entries(parsed.aliases)
      .map(([alias, model]) => [String(alias || '').trim(), String(model || '').trim()])
      .filter(([alias, model]) => alias && model)
  )

  return {
    version: 1,
    channelId: String(parsed.channelId || ''),
    aliases,
    reverse: Object.fromEntries(Object.entries(aliases).map(([alias, model]) => [model, alias]))
  }
}

function writeModelAliases(filePath, channelId, aliases) {
  if (!filePath) return

  const normalized = Object.fromEntries(
    Object.entries(aliases || {})
      .map(([alias, model]) => [String(alias || '').trim(), String(model || '').trim()])
      .filter(([alias, model]) => alias && model)
  )

  writeText(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        channelId: String(channelId || ''),
        updatedAt: new Date().toISOString(),
        aliases: normalized
      },
      null,
      2
    )}\n`
  )
}

function writeChannelModelCatalog(modelsCachePath, models, templateCatalogPaths = [], options = {}) {
  const availableModels = uniqueModelList({ models })

  if (!availableModels.length) throw new Error('该渠道没有可写入 ChatGPT 的模型')

  const current = parseJsonFile(modelsCachePath, {})
  const currentModels = Array.isArray(current.models) ? current.models : []
  const bySlug = new Map(currentModels.map(item => [String(item?.slug || '').toLowerCase(), item]))
  const templateModels = templateCatalogPaths.flatMap(readCatalogModels)
  const aliasSlotModels = templateModels.some(item => item?.visibility === 'list')
    ? templateModels
    : currentModels.map(item =>
        item?.manager_managed !== true && /^(?:gpt|o[1-9])(?:-|$)/i.test(String(item?.slug || ''))
          ? { ...item, visibility: 'list' }
          : item
      )
  const modelTests = options.modelTests && typeof options.modelTests === 'object' ? options.modelTests : {}
  const supportedModels = availableModels.filter(model => modelAdapterProfile(model, modelTests[model]).available)
  const unsupportedModels = availableModels.filter(model => !supportedModels.includes(model))
  const assignments = buildModelAliasAssignments(aliasSlotModels, supportedModels)
  const assignedModels = new Set(assignments.map(item => item.model))
  const slotLimitedModels = supportedModels.filter(model => !assignedModels.has(model))

  if (!assignments.length) {
    if (!supportedModels.length) throw new Error('该 Key 的模型均显示“适配未完成，暂不可用”')
    throw new Error('没有读取到 Codex 可见的原生模型槽位，无法把模型加入 Codex 内部下拉框')
  }

  const aliases = Object.fromEntries(assignments.map(({ nativeModel, model }) => [nativeModel.slug, model]))
  const selectedSlugs = new Set(
    assignments.flatMap(({ nativeModel, model }) => [nativeModel.slug.toLowerCase(), model.toLowerCase()])
  )
  const capabilityTemplate = selectCodexCapabilityTemplate([templateModels, currentModels], selectedSlugs)
  const visibleModels = assignments.map(({ model, nativeModel }, priority) => {
    const existing = bySlug.get(String(nativeModel.slug).toLowerCase()) || bySlug.get(model.toLowerCase())
    const fallback = fallbackModelCatalogEntry(model, priority)
    const entry = existing || {}
    const reasoning = modelReasoningProfile(model, modelTests[model]) || {}
    const profile = modelAdapterProfile(model, modelTests[model])
    const existingBase = String(existing?.base_instructions || '').trim()
    const templateBase = rewriteCodexModelIdentity(
      nativeModel?.base_instructions || capabilityTemplate?.base_instructions,
      model
    )
    const baseInstructions =
      existingBase.length >= 1000 && !isManagerFallbackInstructions(existingBase)
        ? rewriteCodexModelIdentity(existingBase, model)
        : templateBase || fallback.base_instructions
    const existingMessageTemplate = String(existing?.model_messages?.instructions_template || '').trim()
    const capabilityMessages =
      (nativeModel?.model_messages && typeof nativeModel.model_messages === 'object'
        ? nativeModel.model_messages
        : capabilityTemplate?.model_messages && typeof capabilityTemplate.model_messages === 'object'
          ? capabilityTemplate.model_messages
          : null) ||
      (fallback.model_messages && typeof fallback.model_messages === 'object'
        ? fallback.model_messages
        : fallback.model_messages)
    const modelMessages =
      existingMessageTemplate.length >= 1000
        ? {
            ...existing.model_messages,
            instructions_template: rewriteCodexModelIdentity(existingMessageTemplate, model)
          }
        : {
            ...capabilityMessages,
            instructions_template: rewriteCodexModelIdentity(capabilityMessages.instructions_template, model)
          }

    return {
      ...fallback,
      ...(capabilityTemplate || {}),
      ...nativeModel,
      ...entry,
      ...reasoning,
      slug: nativeModel.slug,
      display_name: modelDisplayName(model),
      description: `${model} · ${profile.adapter} · Codex 工具链适配`,
      base_instructions: baseInstructions,
      model_messages: modelMessages,
      visibility: 'list',
      supported_in_api: true,
      priority,
      availability_nux: null,
      upgrade: null,
      shell_type: capabilityTemplate?.shell_type || entry.shell_type || fallback.shell_type,
      tool_mode: capabilityTemplate?.tool_mode || entry.tool_mode || fallback.tool_mode,
      apply_patch_tool_type:
        capabilityTemplate?.apply_patch_tool_type || entry.apply_patch_tool_type || fallback.apply_patch_tool_type,
      supports_parallel_tool_calls:
        capabilityTemplate?.supports_parallel_tool_calls ??
        entry.supports_parallel_tool_calls ??
        fallback.supports_parallel_tool_calls,
      experimental_supported_tools:
        capabilityTemplate?.experimental_supported_tools ||
        entry.experimental_supported_tools ||
        fallback.experimental_supported_tools,
      use_responses_lite: false,
      multi_agent_version: 'v1',
      supports_search_tool: false,
      supports_image_detail_original: false,
      manager_managed: true,
      manager_actual_model: model,
      manager_adapter: profile.adapter
    }
  })
  const visibleByActualModel = new Map(visibleModels.map(item => [String(item.manager_actual_model), item]))
  const hiddenCanonicalModels = assignments
    .filter(({ model, nativeModel }) => model.toLowerCase() !== String(nativeModel.slug).toLowerCase())
    .map(({ model }, index) => {
      const visible = visibleByActualModel.get(model) || fallbackModelCatalogEntry(model, 1000 + index)

      return {
        ...visible,
        slug: model,
        visibility: 'hide',
        priority: 1000 + index,
        manager_actual_model: model
      }
    })
  const hiddenModels = currentModels
    .filter(item => item?.manager_managed !== true && !selectedSlugs.has(String(item?.slug || '').toLowerCase()))
    .map(item => ({ ...item, visibility: 'hide' }))
  const next = {
    ...current,
    fetched_at: new Date().toISOString(),
    models: [...visibleModels, ...hiddenCanonicalModels, ...hiddenModels]
  }

  ensureDir(path.dirname(modelsCachePath))
  writeText(modelsCachePath, `${JSON.stringify(next, null, 2)}\n`)
  writeModelAliases(options.modelAliasesPath, options.channelId, aliases)

  const writtenCatalog = parseJsonFile(modelsCachePath, {})
  const writtenVisibleModels = Array.isArray(writtenCatalog.models)
    ? writtenCatalog.models.filter(item => item?.visibility === 'list').map(item => String(item.slug || ''))
    : []
  const expectedAliases = assignments.map(({ nativeModel }) => String(nativeModel.slug))

  if (
    writtenVisibleModels.length !== expectedAliases.length ||
    writtenVisibleModels.some((model, index) => model.toLowerCase() !== expectedAliases[index].toLowerCase())
  ) {
    throw new Error(
      `Codex 模型目录校验失败：期望 ${expectedAliases.join(', ')}，实际 ${writtenVisibleModels.join(', ') || '空'}`
    )
  }

  return {
    models: assignments.map(item => item.model),
    aliases,
    reverse: Object.fromEntries(Object.entries(aliases).map(([alias, model]) => [model, alias])),
    unavailable: [
      ...unsupportedModels.map(model => ({ model, reason: '适配未完成，暂不可用' })),
      ...slotLimitedModels.map(model => ({ model, reason: 'Codex 原生可见模型槽位不足，暂不可用' }))
    ]
  }
}

function writeApiKeyAuth(authPath, apiKey, options = {}) {
  if (!apiKey) throw new Error('没有找到该渠道的 API Key，请编辑渠道后重新保存。')

  ensureDir(path.dirname(authPath))
  const current = parseJsonFile(authPath, {})
  const hasChatGptSession = Boolean(current?.tokens?.access_token || current?.tokens?.refresh_token)

  // Keep the ChatGPT login tokens and account identity. Replacing auth.json with
  // only OPENAI_API_KEY makes the desktop app look signed out and hides the
  // account's existing conversations. A fresh client without ChatGPT tokens
  // must explicitly enter API-key mode so the desktop app can start signed in.
  writeText(
    authPath,
    `${JSON.stringify(
      {
        ...current,
        auth_mode:
          options.forceApiKeyMode === true ? 'apikey' : hasChatGptSession ? current.auth_mode || 'chatgpt' : 'apikey',
        OPENAI_API_KEY: apiKey
      },
      null,
      2
    )}\n`
  )
}

function loginFreshClientWithApiKey(paths, apiKey, options = {}) {
  const current = parseJsonFile(paths.authPath, {})
  const hasChatGptSession = Boolean(current?.tokens?.access_token || current?.tokens?.refresh_token)

  if (hasChatGptSession && options.forceApiKeyMode !== true) {
    return { skipped: true, reason: 'chatgpt-session-preserved' }
  }

  // Microsoft Store 包内的 codex.exe 不允许无关桌面进程直接执行，
  // Windows 会返回 EACCES。Codex 的 API Key 登录实际使用下面的
  // auth.json 结构，因此直接写入并回读校验，避免错误中断渠道启用。
  writeApiKeyAuth(paths.authPath, apiKey, { forceApiKeyMode: options.forceApiKeyMode === true })

  const saved = parseJsonFile(paths.authPath, {})

  if (saved.auth_mode !== 'apikey' || saved.OPENAI_API_KEY !== apiKey) {
    throw new Error('API Key 登录信息写入后校验失败，请检查 .codex\\auth.json 的文件权限。')
  }

  return {
    skipped: false,
    reason: options.dryRunRestart ? 'auth-file-written-dry-run' : 'auth-file-written',
    preservedChatGptTokens: hasChatGptSession
  }
}

function recoverPrimaryAuthForCustomProvider(paths) {
  const current = parseJsonFile(paths.authPath, {})

  if (current?.tokens || current?.auth_mode) return false

  const initialBackup = readInitialBackup(paths)

  if (!initialBackup.authExists) return false

  const initial = parseJsonFile(initialBackup.authPath, {})

  if (!initial?.tokens && !initial?.auth_mode) return false

  writeText(paths.authPath, `${JSON.stringify(initial, null, 2)}\n`)

  return true
}

function reconcileAuthForCustomProvider(paths, managerApiKeys = []) {
  const current = parseJsonFile(paths.authPath, {})
  const hasChatGptSession = Boolean(current?.tokens?.access_token || current?.tokens?.refresh_token)

  // A custom provider with requires_openai_auth=false is authenticated by the
  // local protocol proxy. Its upstream key must never become the desktop
  // client's ChatGPT identity, otherwise the Recents/task surface can appear
  // signed out even though the local session files and index are intact.
  if (hasChatGptSession) return { action: 'preserved-chatgpt-session' }

  const initialBackup = readInitialBackup(paths)
  const knownKeys = new Set(managerApiKeys.map(value => String(value || '')).filter(Boolean))
  const currentApiKey = String(current?.OPENAI_API_KEY || '')
  const managerOwnedApiKeyAuth =
    current?.auth_mode === 'apikey' && Boolean(currentApiKey) && knownKeys.has(currentApiKey)

  if (managerOwnedApiKeyAuth) {
    if (initialBackup.authExists && initialBackup.authPath && fs.existsSync(initialBackup.authPath)) {
      fs.copyFileSync(initialBackup.authPath, paths.authPath)
      return { action: 'restored-initial-auth' }
    }

    if (fs.existsSync(paths.authPath)) fs.unlinkSync(paths.authPath)
    return { action: 'removed-manager-api-key-auth' }
  }

  if (!fs.existsSync(paths.authPath) && initialBackup.authExists) {
    recoverPrimaryAuthForCustomProvider(paths)
    return { action: 'restored-missing-initial-auth' }
  }

  return { action: 'preserved-existing-auth' }
}

function readInitialBackup(paths) {
  const meta = parseJsonFile(paths.initialBackupMetaPath, null)

  if (!meta) return { exists: false, path: '', createdAt: '' }

  return {
    exists: fs.existsSync(meta.path),
    path: meta.path,
    configExists: meta.configExists !== false,
    authCaptured: meta.authCaptured !== false,
    authExists: Boolean(meta.authExists ?? (meta.authPath && fs.existsSync(meta.authPath))),
    authPath: meta.authPath || '',
    modelsCacheCaptured: meta.modelsCacheCaptured !== false,
    modelsCacheExists: Boolean(meta.modelsCacheExists ?? (meta.modelsCachePath && fs.existsSync(meta.modelsCachePath))),
    modelsCachePath: meta.modelsCachePath || '',
    createdAt: meta.createdAt || ''
  }
}

function ensureInitialBackup(paths, configText) {
  const existing = readInitialBackup(paths)

  if (existing.exists && existing.authCaptured && existing.modelsCacheCaptured) return existing

  ensureDir(paths.stateDir)

  const createdAt = new Date().toISOString()
  const backupPath = path.join(paths.stateDir, `initial-config-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}.toml`)
  const configExists = fs.existsSync(paths.configPath)
  const authExists = fs.existsSync(paths.authPath)
  const modelsCacheExists = fs.existsSync(paths.modelsCachePath)
  const authBackupPath = authExists
    ? path.join(paths.stateDir, `initial-auth-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}.json`)
    : ''
  const modelsCacheBackupPath = modelsCacheExists
    ? path.join(paths.stateDir, `initial-models-cache-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}.json`)
    : ''
  const meta = {
    path: existing.path || backupPath,
    configExists: existing.exists ? existing.configExists : configExists,
    authCaptured: true,
    authExists: existing.exists ? existing.authExists : authExists,
    authPath: existing.authPath || authBackupPath,
    modelsCacheCaptured: true,
    modelsCacheExists: existing.exists ? existing.modelsCacheExists : modelsCacheExists,
    modelsCachePath: existing.modelsCachePath || modelsCacheBackupPath,
    createdAt: existing.createdAt || createdAt
  }

  if (!existing.path) fs.writeFileSync(backupPath, configText, 'utf8')
  if ((!existing.path || !existing.authCaptured) && authBackupPath) fs.copyFileSync(paths.authPath, authBackupPath)
  if ((!existing.path || !existing.modelsCacheCaptured) && modelsCacheBackupPath) {
    fs.copyFileSync(paths.modelsCachePath, modelsCacheBackupPath)
  }
  fs.writeFileSync(paths.initialBackupMetaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  return {
    exists: true,
    path: meta.path,
    configExists: meta.configExists,
    authCaptured: true,
    authExists: meta.authExists,
    authPath: meta.authPath,
    modelsCacheCaptured: true,
    modelsCacheExists: meta.modelsCacheExists,
    modelsCachePath: meta.modelsCachePath,
    createdAt: meta.createdAt
  }
}

function configProvidersFromParsed(parsed, currentProvider, currentModel) {
  const providers = parsed.model_providers && typeof parsed.model_providers === 'object' ? parsed.model_providers : {}

  return Object.entries(providers).map(([id, provider]) => {
    const sourceModel = provider.model || (id === currentProvider ? currentModel : '')
    const models = sourceModel ? [sourceModel] : []

    return {
      id,
      name: provider.name || id,
      baseUrl: provider.base_url || provider.baseURL || '',
      model: sourceModel || '',
      models,
      wireApi: provider.wire_api === 'responses' ? 'responses' : 'chat',
      envKey: provider.env_key || '',
      updatedAt: '',
      active: id === currentProvider,
      apiKeyMask: maskKey(process.env[provider.env_key] || ''),
      source: 'codex-config',
      managed: false
    }
  })
}

function mergeProviders(managedChannels, configProviders, currentProvider, currentModel, openaiBaseUrl) {
  const byId = new Map()
  const activeOpenaiBaseUrl = normalizeBaseUrl(openaiBaseUrl)
  const activeManagedChannel =
    currentProvider === 'openai'
      ? managedChannelFromConfig({ model_provider: currentProvider, openai_base_url: openaiBaseUrl }, managedChannels)
      : null

  for (const provider of configProviders) {
    byId.set(provider.id, provider)
  }

  for (const channel of managedChannels) {
    const existing = byId.get(channel.id)
    const models = modelListFromProvider(channel).length
      ? modelListFromProvider(channel)
      : modelListFromProvider(existing)
    const matchesOpenaiBaseUrl =
      currentProvider === 'openai' &&
      activeOpenaiBaseUrl &&
      (activeManagedChannel?.id === channel.id || normalizeBaseUrl(channel.baseUrl) === activeOpenaiBaseUrl)
    const activeModel =
      matchesOpenaiBaseUrl && currentModel && models.includes(currentModel)
        ? currentModel
        : channel.model || models[0] || existing?.model || ''
    const modelTests =
      channel.modelTests && typeof channel.modelTests === 'object'
        ? channel.modelTests
        : channel.testStatus && activeModel
          ? { [activeModel]: { ...channel.testStatus, model: activeModel, testedAt: channel.updatedAt || '' } }
          : {}
    const capabilityProvider = { ...channel, models, modelTests }
    const modelCapabilities = modelCapabilityMap(capabilityProvider)

    byId.set(channel.id, {
      ...existing,
      ...channel,
      baseUrl: channel.baseUrl || existing?.baseUrl || '',
      model: activeModel,
      models,
      wireApi: channel.wireApi || existing?.wireApi || 'chat',
      envKey: channel.envKey || existing?.envKey || '',
      active: channel.id === currentProvider || matchesOpenaiBaseUrl,
      apiKeyMask: maskKey(process.env[channel.envKey] || ''),
      modelTests,
      modelCapabilities,
      supportedModelCount: Object.values(modelCapabilities).filter(capability => capability.available).length,
      testStatus: aggregateModelTests(models, modelTests) || channel.testStatus || null,
      source: existing ? 'managed+codex-config' : 'managed',
      managed: true
    })
  }

  return Array.from(byId.values()).sort((left, right) => {
    if (left.active) return -1
    if (right.active) return 1
    return left.name.localeCompare(right.name)
  })
}

function sessionTitleFromRows(rows, fallback) {
  for (const row of rows) {
    const payload = row.payload || {}
    const meta = payload.type === 'session_meta' ? payload : row.type === 'session_meta' ? row.payload : null

    if (meta?.thread_name) return meta.thread_name
  }

  for (const row of rows) {
    const payload = row.payload || {}
    const role = payload.role || payload.message?.role

    if (role !== 'user') continue

    const content = payload.message?.content || payload.content || []
    const firstText = Array.isArray(content)
      ? content.find(item => item?.text || item?.type === 'input_text')?.text
      : typeof content === 'string'
        ? content
        : ''

    if (
      firstText &&
      !firstText.includes('<environment_context>') &&
      !firstText.includes('<permissions instructions>') &&
      !firstText.includes('<turn_aborted>')
    ) {
      return firstText.replace(/\s+/g, ' ').slice(0, 48)
    }
  }

  return fallback
}

function sessionMetaFromFile(filePath, location) {
  const stat = fs.statSync(filePath)
  const cacheKey = path.resolve(filePath).toLowerCase()
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${location}`
  const cached = sessionMetaCache.get(cacheKey)

  if (cached?.signature === signature) {
    cached.lastSeenAt = Date.now()
    return cached.value
  }

  const rows = readJsonLines(filePath, 60)
  const first = rows.find(row => row.type === 'session_meta' || row.payload?.type === 'session_meta')
  const payload = first?.payload || {}
  const id = payload.session_id || payload.id || path.basename(filePath, '.jsonl')
  const cwd = payload.cwd || ''
  const value = {
    id,
    title: sessionTitleFromRows(rows, path.basename(filePath)),
    path: filePath,
    cwd,
    location,
    size: stat.size,
    updatedAt: stat.mtime.toISOString()
  }

  sessionMetaCache.set(cacheKey, { signature, value, lastSeenAt: Date.now() })

  return value
}

function listSessions(paths) {
  const activeFiles = walkFiles(paths.sessionsPath, filePath => filePath.endsWith('.jsonl')).filter(
    filePath => !filePath.toLowerCase().startsWith(paths.importedSessionsPath.toLowerCase())
  )
  const importedFiles = walkFiles(paths.importedSessionsPath, filePath => filePath.endsWith('.jsonl'))
  const archivedFiles = walkFiles(paths.archivedSessionsPath, filePath => filePath.endsWith('.jsonl'))
  const readableSessionMeta = (filePath, location) => {
    try {
      return sessionMetaFromFile(filePath, location)
    } catch {
      // Files can be locked, revoked or disappear while Codex is writing/updating them.
      // Keep the remaining conversation list usable and retry this file on the next refresh.
      sessionMetaCache.delete(path.resolve(filePath).toLowerCase())
      return null
    }
  }
  const active = activeFiles.map(filePath => readableSessionMeta(filePath, 'active')).filter(Boolean)
  const imported = importedFiles.map(filePath => readableSessionMeta(filePath, 'imported')).filter(Boolean)
  const archived = archivedFiles.map(filePath => readableSessionMeta(filePath, 'archived')).filter(Boolean)
  const observed = new Set(
    [...activeFiles, ...importedFiles, ...archivedFiles].map(filePath => path.resolve(filePath).toLowerCase())
  )
  const roots = [paths.sessionsPath, paths.archivedSessionsPath].map(
    root => `${path.resolve(root).toLowerCase()}${path.sep}`
  )

  for (const cacheKey of sessionMetaCache.keys()) {
    if (roots.some(root => cacheKey.startsWith(root)) && !observed.has(cacheKey)) sessionMetaCache.delete(cacheKey)
  }
  if (sessionMetaCache.size > 2000) {
    const oldest = [...sessionMetaCache.entries()]
      .sort((left, right) => Number(left[1]?.lastSeenAt || 0) - Number(right[1]?.lastSeenAt || 0))
      .slice(0, sessionMetaCache.size - 2000)

    for (const [cacheKey] of oldest) sessionMetaCache.delete(cacheKey)
  }

  return [...active, ...imported, ...archived].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function sessionMetaDetails(filePath) {
  const rows = readJsonLines(filePath, 16)
  const row = rows.find(item => item.type === 'session_meta' || item.payload?.type === 'session_meta')
  const payload = row?.payload || {}

  return {
    payload,
    source: payload.source || '',
    threadSource: payload.thread_source || payload.threadSource || '',
    parentThreadId: payload.parent_thread_id || payload.parentThreadId || ''
  }
}

function shouldNormalizeSessionForDesktop(filePath) {
  const meta = sessionMetaDetails(filePath)
  const source = typeof meta.source === 'string' ? meta.source.toLowerCase() : JSON.stringify(meta.source).toLowerCase()
  const threadSource =
    typeof meta.threadSource === 'string'
      ? meta.threadSource.toLowerCase()
      : JSON.stringify(meta.threadSource).toLowerCase()

  if (!meta.payload || !Object.keys(meta.payload).length) return false
  if (meta.parentThreadId) return false
  if (threadSource === 'ambient_suggestions' || source.includes('subagent') || source.includes('sub_agent'))
    return false
  if (source === 'vscode' && threadSource === 'user') return false

  return true
}

function normalizeSessionForDesktop(filePath) {
  if (!shouldNormalizeSessionForDesktop(filePath)) return null

  const handle = fs.openSync(filePath, 'r')
  const stat = fs.fstatSync(handle)
  const prefixLimit = Math.min(stat.size, 4 * 1024 * 1024)
  const prefix = Buffer.allocUnsafe(prefixLimit)
  let bytesRead = 0

  try {
    while (bytesRead < prefixLimit) {
      const count = fs.readSync(handle, prefix, bytesRead, prefixLimit - bytesRead, bytesRead)

      if (!count) break
      bytesRead += count
    }
  } finally {
    fs.closeSync(handle)
  }

  const available = prefix.subarray(0, bytesRead)
  let lineStart = 0
  let replacement = null

  while (lineStart < available.length) {
    const newlineIndex = available.indexOf(0x0a, lineStart)
    const lineEnd = newlineIndex >= 0 ? newlineIndex : available.length
    const rawLine = available.subarray(lineStart, lineEnd)
    const text = rawLine.toString('utf8').replace(/\r$/, '')

    if (text.trim()) {
      try {
        const row = JSON.parse(text)

        if (row.type === 'session_meta' || row.payload?.type === 'session_meta') {
          const payload = { ...(row.payload || {}) }

          payload.originator = 'Codex Desktop'
          payload.source = 'vscode'
          payload.thread_source = 'user'
          if (!payload.history_mode) payload.history_mode = 'legacy'

          const updated = { ...row, payload }
          const newline = rawLine.length && rawLine[rawLine.length - 1] === 0x0d ? '\r\n' : '\n'
          replacement = {
            start: lineStart,
            end: newlineIndex >= 0 ? newlineIndex + 1 : lineEnd,
            buffer: Buffer.from(`${JSON.stringify(updated)}${newline}`, 'utf8')
          }
          break
        }
      } catch {
        // Keep scanning the prefix; malformed later records must not block session metadata repair.
      }
    }

    if (newlineIndex < 0) break
    lineStart = newlineIndex + 1
  }

  if (!replacement) return null

  const backup = backupFile(filePath, 'desktop-task-visibility')
  const tempPath = `${filePath}.codex-manager-${process.pid}-${Date.now()}.tmp`
  const sourceHandle = fs.openSync(filePath, 'r')
  const targetHandle = fs.openSync(tempPath, 'w')
  const buffer = Buffer.allocUnsafe(1024 * 1024)

  try {
    if (replacement.start) fs.writeSync(targetHandle, available.subarray(0, replacement.start))
    fs.writeSync(targetHandle, replacement.buffer)

    let position = replacement.end

    while (position < stat.size) {
      const count = fs.readSync(sourceHandle, buffer, 0, Math.min(buffer.length, stat.size - position), position)

      if (!count) break
      fs.writeSync(targetHandle, buffer, 0, count)
      position += count
    }
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Keep the original and its backup if cleanup itself fails.
    }
    throw error
  } finally {
    fs.closeSync(sourceHandle)
    fs.closeSync(targetHandle)
  }

  fs.renameSync(tempPath, filePath)

  return {
    sessionPath: filePath,
    backupPath: backup.backupPath
  }
}

function listProjects(parsed) {
  const projects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {}

  return Object.entries(projects)
    .map(([projectPath, value]) => ({
      path: projectPath,
      name: path.basename(projectPath) || projectPath,
      trustLevel: value?.trust_level || '',
      exists: fs.existsSync(projectPath)
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function sessionProjectPaths(sessions) {
  const values = []
  const seen = new Set()

  for (const session of sessions) {
    const cwd = String(session.cwd || '').trim()

    if (!cwd) continue

    const resolved = path.resolve(cwd).toLowerCase()

    if (seen.has(resolved)) continue
    seen.add(resolved)
    values.push(resolved)
  }

  return values
}

function ensureProjectsFromSessions(paths, options = {}) {
  const sessions = listSessions(paths).filter(session => session.location !== 'archived')
  const projectPaths = sessionProjectPaths(sessions).filter(projectPath => {
    try {
      return fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()
    } catch {
      return false
    }
  })

  if (!projectPaths.length) return { addedProjectCount: 0, addedProjects: [] }

  const current = readText(paths.configPath)
  const parsed = parseConfig(current || '')
  const existing = new Set(listProjects(parsed).map(project => project.path.toLowerCase()))
  const missing = projectPaths.filter(projectPath => !existing.has(projectPath))

  if (!missing.length) return { addedProjectCount: 0, addedProjects: [] }

  if (!options.skipProjectBackup) backupConfig(paths.configPath, current, 'project-index-repair')

  let next = current || ''

  for (const projectPath of missing) {
    next = removeProjectBlock(next, projectPath)
    next = `${next.trimEnd()}\n\n[${projectTableName(projectPath)}]\ntrust_level = "trusted"\n`
  }

  parseConfig(next)
  writeText(paths.configPath, next)

  return { addedProjectCount: missing.length, addedProjects: missing }
}

function syncDesktopProjects(paths, options = {}) {
  const sessions = listSessions(paths).filter(session => session.location !== 'archived')

  return syncDesktopProjectsFromSessions(paths.globalStatePath, sessions, {
    backupDir: path.join(paths.stateDir, 'backups'),
    ...options.desktopProjectOptions
  })
}

function buildDiagnostics(paths, configExists, configError, codexTargets, codexInstallationEvidence) {
  const codexHomeExists = fs.existsSync(paths.codexHome)
  const codexInstalled = codexTargets.length > 0 || codexInstallationEvidence?.found === true
  const issues = []

  if (!codexInstalled) {
    issues.push('没有发现 Codex/ChatGPT Windows 客户端。请点击“重新扫描”，或确认客户端已安装并至少启动过一次。')
  }

  if (!codexHomeExists) {
    issues.push('没有发现 .codex 目录。可能 Codex 尚未启动过，或 CODEX_HOME 指向了其他目录。')
  }

  if (!configExists) {
    issues.push('没有找到 config.toml。可能 Codex 尚未生成配置，或配置文件被移动。')
  }

  if (configError) {
    issues.push(`config.toml 读取或解析失败：${configError}`)
  }

  return {
    codexInstalled,
    codexDetection: codexTargets.length ? 'launch-target' : codexInstallationEvidence?.kind || 'not-found',
    codexDetectedPath: codexTargets[0] || codexInstallationEvidence?.path || '',
    codexHomeExists,
    configExists,
    configReadable: configExists && !configError,
    issues
  }
}

function readStatus(options = {}) {
  const paths = getPaths(options)
  const codexTargets = options.forceCodexTargetScan
    ? findCodexTargets({ ...options, force: true })
    : findCodexQuickTargets(options)
  const codexInstallationEvidence = findCodexQuickInstallationEvidence(codexTargets, {
    ...options,
    force: options.forceCodexTargetScan === true
  })
  const configExists = fs.existsSync(paths.configPath)
  let configText = ''
  let parsed = {}
  let configError = ''

  try {
    configText = readText(paths.configPath)
    parsed = parseConfig(configText)
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error)
  }

  const currentProvider = parsed.model_provider || 'openai'
  const currentCodexModel = parsed.model || ''
  const openaiBaseUrl = parsed.openai_base_url || ''
  const initialBackup = ensureInitialBackup(paths, configText)
  const managedChannels = parseJsonFile(paths.channelsPath, [])
  const activeManagedChannel = managedChannelFromConfig(parsed, managedChannels)
  const aliasState = readModelAliases(paths.modelAliasesPath)
  const currentModel =
    activeManagedChannel && aliasState.channelId === activeManagedChannel.id
      ? aliasState.aliases[currentCodexModel] || currentCodexModel
      : currentCodexModel
  const newApi = publicNewApiState(parseJsonFile(paths.newApiPath, {}))
  const configProviders = configProvidersFromParsed(parsed, currentProvider, currentModel)
  const providers = mergeProviders(managedChannels, configProviders, currentProvider, currentModel, openaiBaseUrl)
  const activeManaged = providers.find(provider => provider.managed && provider.active)
  const effectiveProvider = activeManaged?.id || currentProvider

  return {
    codexHome: paths.codexHome,
    configPath: paths.configPath,
    channelsPath: paths.channelsPath,
    currentProvider: effectiveProvider,
    currentModel,
    currentCodexModel,
    isDefaultProvider: currentProvider === 'openai' && !openaiBaseUrl,
    providers,
    codexTargets,
    sessions: configError ? [] : listSessions(paths),
    projects: configError ? [] : listProjects(parsed),
    skills: listSkills(options),
    agents: listAgents(options),
    newApi,
    initialBackup,
    diagnostics: buildDiagnostics(paths, configExists, configError, codexTargets, codexInstallationEvidence)
  }
}

function readProviderState(options = {}) {
  const paths = getPaths(options)
  const configText = readText(paths.configPath)
  const parsed = parseConfig(configText || '')
  const currentProvider = parsed.model_provider || 'openai'
  const openaiBaseUrl = parsed.openai_base_url || ''
  const managedChannels = parseJsonFile(paths.channelsPath, [])
  const aliasState = readModelAliases(paths.modelAliasesPath)
  const activeManagedChannel = managedChannelFromConfig(parsed, managedChannels)
  const currentModel =
    activeManagedChannel && aliasState.channelId === activeManagedChannel.id
      ? aliasState.aliases[parsed.model] || parsed.model || ''
      : parsed.model || ''
  const configProviders = configProvidersFromParsed(parsed, currentProvider, currentModel)
  const providers = mergeProviders(managedChannels, configProviders, currentProvider, currentModel, openaiBaseUrl)

  ensureInitialBackup(paths, configText)

  return { paths, configText, parsed, providers, currentProvider, currentModel, openaiBaseUrl }
}

function saveRelay(input, options = {}) {
  const normalized = normalizeRelayInput(input)
  const paths = getPaths(options)
  const channels = parseJsonFile(paths.channelsPath, [])
  const existingIds = new Set(readStatus(options).providers.map(provider => provider.id))
  let id = input.id ? slugifyProviderName(input.id) : slugifyProviderName(normalized.name)
  let suffix = 2

  while (existingIds.has(id) && id !== input.id) {
    id = `${slugifyProviderName(normalized.name)}-${suffix}`
    suffix += 1
  }

  const existing = channels.find(channel => channel.id === id)
  const envKey = existing?.envKey || envKeyForProvider(id)

  if (!normalized.apiKey && !existing) {
    throw new Error('新增中转站时必须填写 API Key')
  }

  if (normalized.apiKey) {
    setUserEnvVar(envKey, normalized.apiKey, options)
  }

  const testsInvalidated =
    !existing ||
    normalized.apiKey ||
    normalizeBaseUrl(existing.baseUrl) !== normalizeBaseUrl(normalized.baseUrl) ||
    existing.wireApi !== normalized.wireApi
  const existingModelTests = existing?.modelTests && typeof existing.modelTests === 'object' ? existing.modelTests : {}
  const modelTests = testsInvalidated
    ? {}
    : Object.fromEntries(
        normalized.models.filter(model => existingModelTests[model]).map(model => [model, existingModelTests[model]])
      )
  const testStatus = aggregateModelTests(normalized.models, modelTests)

  const channel = {
    id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    models: normalized.models,
    wireApi: normalized.wireApi,
    envKey,
    managed: true,
    keySource: normalized.keySource,
    newApi: normalized.newApi,
    modelTests,
    testStatus: input.testStatus || testStatus,
    updatedAt: new Date().toISOString()
  }

  const nextChannels = existing ? channels.map(item => (item.id === id ? channel : item)) : [...channels, channel]

  saveChannels(paths.channelsPath, nextChannels)

  return { channel, status: readStatus(options) }
}

async function testAndSaveRelay(input, options = {}) {
  const normalized = normalizeRelayInput(input)
  const modelTests = {}
  let test = null

  for (const model of normalized.models) {
    const result = await testRelay({ ...input, model, models: [model] }, options)

    modelTests[model] = { ...result, model, testedAt: new Date().toISOString() }
  }

  test = aggregateModelTests(normalized.models, modelTests)

  if (!test?.ok) {
    return { test, status: readStatus(options) }
  }

  const saved = saveRelay({ ...input, wireApi: test.wireApi || input.wireApi, testStatus: test }, options)
  const paths = getPaths(options)
  const channels = parseJsonFile(paths.channelsPath, [])

  saveChannels(
    paths.channelsPath,
    channels.map(channel => (channel.id === saved.channel.id ? { ...channel, modelTests, testStatus: test } : channel))
  )

  return { ...saved, test, tests: Object.values(modelTests), status: readStatus(options) }
}

async function testSavedRelay(id, modelOrOptions = {}, maybeOptions = {}) {
  const selectedModel = typeof modelOrOptions === 'string' ? modelOrOptions.trim() : ''
  const options = typeof modelOrOptions === 'object' && modelOrOptions !== null ? modelOrOptions : maybeOptions
  const paths = getPaths(options)
  const status = readStatus(options)
  const channel = status.providers.find(item => item.id === id)

  if (!channel) throw new Error('未找到该渠道')

  const apiKey = selectedNewApiKey(channel) || readUserEnvVar(channel.envKey)

  if (!apiKey) {
    return {
      test: { ok: false, status: 0, latencyMs: 0, message: '没有找到该渠道的 API Key，请编辑渠道后重新保存。' },
      tests: [],
      status
    }
  }

  const availableModels = modelListFromProvider(channel)
  const adaptedModels = availableModels.filter(model => modelAdapterProfile(model).available)
  const models = selectedModel ? [selectedModel] : adaptedModels
  const existingModelTests = channel.modelTests && typeof channel.modelTests === 'object' ? channel.modelTests : {}
  const modelTests = { ...existingModelTests }

  if (selectedModel && !availableModels.includes(selectedModel)) throw new Error('所选模型不属于当前 Key')

  for (const model of models) {
    const test = await testRelay({ ...channel, model, models: [model], apiKey }, options)

    modelTests[model] = { ...test, model, testedAt: new Date().toISOString() }
  }

  const test = aggregateModelTests(models, modelTests) || {
    ok: false,
    status: 0,
    latencyMs: 0,
    message: '没有可测试的模型'
  }

  if (channel.managed) {
    const channels = parseJsonFile(paths.channelsPath, [])
    const nextChannels = channels.map(item =>
      item.id === id
        ? {
            ...item,
            model: selectedModel || item.model,
            wireApi: test.wireApi || item.wireApi,
            modelTests,
            testStatus: aggregateModelTests(adaptedModels, modelTests) || test,
            updatedAt: new Date().toISOString()
          }
        : item
    )

    saveChannels(paths.channelsPath, nextChannels)
  }

  return { test, tests: models.map(model => modelTests[model]).filter(Boolean), status: readStatus(options) }
}

function reportActivationProgress(options, stage, progress, message, status = 'running') {
  if (typeof options?.onProgress !== 'function') return

  try {
    options.onProgress({
      stage,
      progress: Math.max(0, Math.min(100, Number(progress) || 0)),
      message,
      status,
      updatedAt: new Date().toISOString()
    })
  } catch {
    // UI progress reporting must never interrupt configuration or rollback.
  }
}

function applyRelay(id, modelOrOptions = {}, maybeOptions = {}) {
  const applyStartedAt = Date.now()
  const selectedModel = typeof modelOrOptions === 'string' ? modelOrOptions.trim() : ''
  const options = typeof modelOrOptions === 'object' && modelOrOptions !== null ? modelOrOptions : maybeOptions

  reportActivationProgress(options, 'reading-config', 12, '正在读取 Codex 配置和渠道状态')
  const providerState = readProviderState(options)
  const { paths } = providerState
  const channel = providerState.providers.find(item => item.id === id)

  if (!channel) throw new Error('未找到该渠道')
  const models = modelListFromProvider(channel)
  const model = selectedModel || channel.model || models[0] || ''

  if (channel.managed && models.length && !models.includes(model)) {
    throw new Error('请选择该渠道已配置的模型。')
  }

  const selectedProfile = modelAdapterProfile(model, testForModel(channel, model))

  if (channel.managed && !selectedProfile.available) {
    throw new Error(`${model}：${selectedProfile.reason}`)
  }

  if (channel.managed && id !== 'openai' && !options.skipChannelTest && !relayTestReady(testForModel(channel, model))) {
    throw new Error('请先让该模型通过聊天、流式响应和工具续答测试，再启用。')
  }

  const current = readText(paths.configPath)
  const before = protectedStateSnapshot(paths, current)
  const apiKey = channel.managed ? selectedNewApiKey(channel) || readUserEnvVar(channel.envKey) : ''

  if (channel.managed && !apiKey) {
    throw new Error('没有找到该渠道的 API Key，请编辑渠道后重新保存。')
  }

  reportActivationProgress(options, 'backing-up', 22, '正在备份现有配置和登录状态')
  backupConfig(paths.configPath, current)
  const authSnapshot = channel.managed ? backupAuth(paths.authPath) : null
  const modelsCacheSnapshot = channel.managed ? backupFile(paths.modelsCachePath, 'models-change') : null
  const modelAliasesSnapshot = channel.managed ? backupFile(paths.modelAliasesPath, 'model-aliases-change') : null
  let authLogin = null
  let modelCatalogMs = 0
  let modelCatalogResult = null

  try {
    let next = current || ''

    if (channel.managed) {
      if (channel.keySource === 'newapi') process.env[channel.envKey] = apiKey

      next = setRootKey(next, 'model_catalog_json', paths.modelsCachePath)
      const managerApiKeys = providerState.providers
        .filter(provider => provider.managed)
        .flatMap(provider => [selectedNewApiKey(provider), provider.envKey ? readUserEnvVar(provider.envKey) : ''])
      reportActivationProgress(options, 'configuring-login', 32, '正在配置 API Key 登录')
      authLogin =
        options.loginWithApiKey === true
          ? loginFreshClientWithApiKey(paths, apiKey, {
              forceApiKeyMode: true,
              dryRunRestart: options.dryRunRestart
            })
          : reconcileAuthForCustomProvider(paths, [...managerApiKeys, apiKey])
      const localBaseUrl = `${protocolProxyBaseUrl(options)}/v1/${encodeURIComponent(channel.id)}`

      // Keep Codex's built-in provider identity stable. Desktop task history is
      // associated with the provider recorded in each session; changing this to
      // a manager-specific provider makes otherwise valid OpenAI sessions vanish
      // from the left task list. openai_base_url is the supported router hook.
      next = removeManagedProviderBlocks(next, providerState.providers)
      next = setRootKey(next, 'model_provider', 'openai')
      next = setRootKey(next, 'openai_base_url', localBaseUrl)
      next = removeRootKey(next, 'preferred_auth_method')
    } else {
      next = setRootKey(next, 'model_provider', channel.id)
      next = removeRootKey(next, 'openai_base_url')
      next = removeRootKey(next, 'preferred_auth_method')
      next = removeRootKey(next, 'model_catalog_json')
    }

    if (channel.managed) next = setTableKey(next, 'features', 'shell_tool', true)
    if (channel.managed) {
      reportActivationProgress(options, 'building-model-catalog', 43, '正在生成 Codex 内部模型目录')
      const modelCatalogStartedAt = Date.now()
      const initialBackup = readInitialBackup(paths)
      const bundledCatalogPath = captureBundledModelCatalog(paths, options)
      const templateCatalogPaths = [
        bundledCatalogPath,
        initialBackup.modelsCacheExists ? initialBackup.modelsCachePath : ''
      ].filter(Boolean)

      const catalogModels = options.skipChannelTest ? models : supportedModelsForProvider(channel)

      modelCatalogResult = writeChannelModelCatalog(paths.modelsCachePath, catalogModels, templateCatalogPaths, {
        channelId: channel.id,
        modelAliasesPath: paths.modelAliasesPath,
        modelTests: channel.modelTests
      })
      const selectedAlias = modelCatalogResult.reverse[model]

      if (!selectedAlias) throw new Error(`${model} 没有可用的 Codex 内部模型槽位`)
      next = setRootKey(next, 'model', selectedAlias)
      modelCatalogMs = Date.now() - modelCatalogStartedAt
    } else if (model) {
      next = setRootKey(next, 'model', model)
    }
    next = preserveProjectBlocks(current, next)
    parseConfig(next)
    writeText(paths.configPath, next)
    assertNoProtectedStateLoss(before, protectedStateSnapshot(paths, next))
    reportActivationProgress(options, 'configuration-written', 52, '渠道、登录和模型配置已写入')
  } catch (error) {
    writeText(paths.configPath, current)
    restoreAuthSnapshot(authSnapshot, paths.authPath)
    restoreFileSnapshot(modelsCacheSnapshot, paths.modelsCachePath)
    restoreFileSnapshot(modelAliasesSnapshot, paths.modelAliasesPath)
    throw error
  }

  const restart =
    options.restartCodex === true
      ? restartCodex({ dryRun: options.dryRunRestart, ...(options.restartOptions || {}) })
      : manualCodexRestartResult()

  return {
    status: options.includeStatus === false ? null : readStatus(options),
    restart,
    authLogin,
    timings: {
      applyMs: Date.now() - applyStartedAt,
      modelCatalogMs
    },
    modelCatalog: modelCatalogResult
  }
}

async function activateRelay(id, modelOrOptions = {}, maybeOptions = {}) {
  const activationStartedAt = Date.now()
  const selectedModel = typeof modelOrOptions === 'string' ? modelOrOptions.trim() : ''
  const options = typeof modelOrOptions === 'object' && modelOrOptions !== null ? modelOrOptions : maybeOptions
  let conversationIndexRepair = null

  reportActivationProgress(options, 'preparing', 5, '正在准备配置并启动 Codex')
  const applied = applyRelay(id, selectedModel, {
    ...options,
    includeStatus: false,
    restartCodex: false
  })

  reportActivationProgress(options, 'configured', 56, 'Codex 配置完成，正在准备启动客户端')
  if (options.repairConversationIndex === true) {
    reportActivationProgress(options, 'repairing-history', 59, '正在修复历史任务索引')
    try {
      conversationIndexRepair = await repairCodexConversationIndex(options)
    } catch (error) {
      conversationIndexRepair = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const restartStartedAt = Date.now()
  const restartProgress = progress => {
    reportActivationProgress(options, progress.stage, progress.progress, progress.message, progress.status)

    try {
      options.restartOptions?.onProgress?.(progress)
    } catch {
      // Preserve activation when a diagnostic progress callback fails.
    }
  }
  const externalAfterStop = options.restartOptions?.afterStop
  const restart =
    options.restartCodex === true
      ? restartCodex({
          dryRun: options.dryRunRestart,
          ...(options.restartOptions || {}),
          onProgress: restartProgress,
          afterStop: () => {
            const trustedProjects = ensureProjectsFromSessions(getPaths(options), options)
            const desktopProjects = syncDesktopProjects(getPaths(options), options)
            const externalResult = typeof externalAfterStop === 'function' ? externalAfterStop() : null

            return { trustedProjects, desktopProjects, externalResult }
          }
        })
      : manualCodexRestartResult()
  const restartMs = Date.now() - restartStartedAt

  const statusStartedAt = Date.now()
  reportActivationProgress(options, 'refreshing-status', 97, '正在确认 Codex 启动状态和模型配置')
  const status = readStatus(options)
  reportActivationProgress(
    options,
    restart?.ok === true ? 'complete' : 'manual-restart-required',
    100,
    restart?.ok === true ? 'Codex 已启动，可以开始使用' : '配置已完成，但需要手动启动 Codex',
    restart?.ok === true ? 'success' : 'warning'
  )

  return {
    ...applied,
    status,
    restart,
    timings: {
      ...applied.timings,
      restartMs,
      statusMs: Date.now() - statusStartedAt,
      totalMs: Date.now() - activationStartedAt
    },
    conversationIndexRepairBefore: null,
    conversationIndexRepair,
    projectSync: restart?.afterStopResult || null
  }
}

function restoreDefaultProvider(options = {}) {
  const paths = getPaths(options)
  const current = readText(paths.configPath)
  const before = protectedStateSnapshot(paths, current)
  const initialBackup = readInitialBackup(paths)

  backupConfig(paths.configPath, current)
  const authSnapshot = backupAuth(paths.authPath, 'before-default-restore')
  const modelsCacheSnapshot = backupFile(paths.modelsCachePath, 'before-default-restore')

  try {
    let next = current || ''
    next = removeRootKey(next, 'model_provider')
    next = removeRootKey(next, 'openai_base_url')
    next = removeRootKey(next, 'preferred_auth_method')
    next = removeRootKey(next, 'model_catalog_json')
    for (const channel of parseJsonFile(paths.channelsPath, [])) {
      next = removeTableBlock(next, `model_providers.${channel.id}`)
    }
    next = preserveProjectBlocks(current, next)
    parseConfig(next)
    writeText(paths.configPath, next)
    if (initialBackup.authExists) restoreAuthFromBackup(initialBackup.authPath, paths.authPath)
    if (initialBackup.modelsCacheExists) restoreAuthFromBackup(initialBackup.modelsCachePath, paths.modelsCachePath)
    assertNoProtectedStateLoss(before, protectedStateSnapshot(paths, next))
  } catch (error) {
    writeText(paths.configPath, current)
    restoreAuthSnapshot(authSnapshot, paths.authPath)
    restoreFileSnapshot(modelsCacheSnapshot, paths.modelsCachePath)
    throw error
  }

  const restart =
    options.restartCodex === true ? restartCodex({ dryRun: options.dryRunRestart }) : manualCodexRestartResult()

  return { status: readStatus(options), restart }
}

function getRelayRuntime(id, options = {}) {
  const paths = getPaths(options)
  const channel = parseJsonFile(paths.channelsPath, []).find(item => item.id === id)

  if (!channel) throw new Error('没有找到协议代理对应的渠道')

  const apiKey = selectedNewApiKey(channel) || readUserEnvVar(channel.envKey)

  if (!apiKey) throw new Error('没有找到该渠道的 API Key')
  const aliasState = readModelAliases(paths.modelAliasesPath)
  const aliases = aliasState.channelId === channel.id ? aliasState.aliases : {}
  const capabilities = modelCapabilityMap(channel)
  const supportedModels = supportedModelsForProvider(channel)
  const modelCatalogSlugs = new Set(Object.keys(aliases))
  const modelCatalog = readCatalogModels(paths.modelsCachePath).filter(
    entry => modelCatalogSlugs.has(String(entry?.slug || '')) && entry?.visibility !== 'hide'
  )

  return {
    id: channel.id,
    baseUrl: channel.baseUrl,
    apiKey,
    models: supportedModels,
    allModels: modelListFromProvider(channel),
    modelAliases: aliases,
    modelCapabilities: capabilities,
    modelCatalog,
    wireApi: channel.wireApi || 'chat',
    modelWireApis: modelWireApiMap(channel),
    modelTests: channel.modelTests && typeof channel.modelTests === 'object' ? channel.modelTests : {}
  }
}

function migrateManagedProviderAuth(options = {}) {
  const paths = getPaths(options)
  const configText = readText(paths.configPath)

  ensureInitialBackup(paths, configText)
  const parsed = parseConfig(configText)
  const channels = parseJsonFile(paths.channelsPath, [])
  const activeChannel = managedChannelFromConfig(parsed, channels)

  if (!activeChannel) return { action: 'not-managed-provider' }

  const managerApiKeys = channels
    .filter(channel => channel.managed)
    .flatMap(channel => [selectedNewApiKey(channel), channel.envKey ? readUserEnvVar(channel.envKey) : ''])

  return reconcileAuthForCustomProvider(paths, managerApiKeys)
}

function getRelayApiKey(id, options = {}) {
  const paths = getPaths(options)
  const channel = parseJsonFile(paths.channelsPath, []).find(item => item.id === id)

  if (!channel) throw new Error('没有找到该渠道')

  const apiKey = readUserEnvVar(channel.envKey)

  if (!apiKey) throw new Error('没有找到该渠道保存的 API Key')

  return { apiKey, maskedApiKey: maskKey(apiKey) }
}

function restoreInitialBackup(options = {}) {
  const paths = getPaths(options)
  const initialBackup = readInitialBackup(paths)

  if (!initialBackup.exists) {
    throw new Error('没有可用的首次备份')
  }

  const current = readText(paths.configPath)
  backupConfig(paths.configPath, current, 'before-initial-restore')
  const authSnapshot = backupAuth(paths.authPath, 'before-initial-restore')
  const modelsCacheSnapshot = backupFile(paths.modelsCachePath, 'before-initial-restore')

  try {
    const restoredConfig = initialBackup.configExists ? readText(initialBackup.path) : ''
    const nextConfig = preserveProjectBlocks(current, restoredConfig)

    if (nextConfig.trim()) writeText(paths.configPath, nextConfig)
    else fs.rmSync(paths.configPath, { force: true })
    if (initialBackup.authExists) restoreAuthFromBackup(initialBackup.authPath, paths.authPath)
    else fs.rmSync(paths.authPath, { force: true })
    if (initialBackup.modelsCacheExists) restoreAuthFromBackup(initialBackup.modelsCachePath, paths.modelsCachePath)
    else fs.rmSync(paths.modelsCachePath, { force: true })
  } catch (error) {
    writeText(paths.configPath, current)
    restoreAuthSnapshot(authSnapshot, paths.authPath)
    restoreFileSnapshot(modelsCacheSnapshot, paths.modelsCachePath)
    throw error
  }

  const restart =
    options.restartCodex === true ? restartCodex({ dryRun: options.dryRunRestart }) : manualCodexRestartResult()

  return { status: readStatus(options), restart }
}

function removeRelay(id, options = {}) {
  const paths = getPaths(options)
  const channels = parseJsonFile(paths.channelsPath, [])
  const existingManaged = channels.find(channel => channel.id === id)

  if (!existingManaged) {
    throw new Error('该渠道来自 Codex 配置，不能在这里删除；请恢复默认渠道或手动编辑 config.toml。')
  }

  const nextChannels = channels.filter(channel => channel.id !== id)
  saveChannels(paths.channelsPath, nextChannels)

  const current = readText(paths.configPath)
  backupConfig(paths.configPath, current)
  let next = removeTableBlock(current, `model_providers.${id}`)
  const parsed = parseConfig(next)
  const activeManagedChannel = managedChannelFromConfig(parsed, channels)

  if (parsed.model_provider === id || activeManagedChannel?.id === id) {
    next = removeRootKey(next, 'model_provider')
    next = removeRootKey(next, 'openai_base_url')
    next = removeRootKey(next, 'model_catalog_json')
  }

  parseConfig(next)
  writeText(paths.configPath, next)

  return readStatus(options)
}

function findSessionByIdOrPath(paths, idOrPath) {
  const sessions = listSessions(paths)
  const exactPath = sessions.find(item => item.path === idOrPath)

  if (exactPath) return exactPath

  const priority = { active: 0, imported: 1, archived: 2 }

  return sessions
    .filter(item => item.id === idOrPath)
    .sort((a, b) => (priority[a.location] ?? 9) - (priority[b.location] ?? 9))[0]
}

function deleteSession(idOrPath, options = {}) {
  const paths = getPaths(options)
  const session = findSessionByIdOrPath(paths, idOrPath)

  if (!session) throw new Error('未找到该对话')
  if (!session.path.toLowerCase().endsWith('.jsonl')) throw new Error('只允许删除对话 JSONL 文件')
  if (!fs.statSync(session.path).isFile()) throw new Error('对话路径不是文件')

  fs.rmSync(session.path)

  return { status: readStatus(options), deletedPath: session.path }
}

function importSession(sourcePath, options = {}) {
  const paths = getPaths(options)
  const resolved = path.resolve(sourcePath)

  if (!fs.existsSync(resolved)) throw new Error('导入文件不存在')
  if (!resolved.toLowerCase().endsWith('.jsonl')) throw new Error('只支持导入 .jsonl 对话文件')

  if (!readJsonLines(resolved, 1).length) throw new Error('对话文件中没有有效的 JSONL 记录')
  ensureDir(paths.importedSessionsPath)

  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const targetBase = path.join(paths.importedSessionsPath, `${stamp}-${path.basename(resolved)}`)
  let target = targetBase
  let suffix = 1

  while (fs.existsSync(target)) {
    target = path.join(paths.importedSessionsPath, `${path.basename(targetBase, '.jsonl')}-${suffix}.jsonl`)
    suffix += 1
  }

  exportFileAtomically(resolved, target)

  return { status: readStatus(options), target }
}

function exportFileAtomically(sourcePath, destinationPath) {
  const resolvedSource = path.resolve(sourcePath)
  const resolvedDestination = path.resolve(destinationPath)

  if (resolvedSource.toLowerCase() === resolvedDestination.toLowerCase()) {
    throw new Error('导出位置不能覆盖原始文件')
  }
  if (fs.existsSync(resolvedDestination) && !fs.statSync(resolvedDestination).isFile()) {
    throw new Error('导出目标必须是文件')
  }

  ensureDir(path.dirname(resolvedDestination))
  const stagedPath = `${resolvedDestination}.exporting-${process.pid}-${Date.now()}`
  const backupPath = `${resolvedDestination}.backup-${process.pid}-${Date.now()}`
  let backedUp = false

  try {
    fs.copyFileSync(resolvedSource, stagedPath)
    if (fs.existsSync(resolvedDestination)) {
      fs.renameSync(resolvedDestination, backupPath)
      backedUp = true
    }
    fs.renameSync(stagedPath, resolvedDestination)
    if (backedUp) fs.rmSync(backupPath, { force: true })
  } catch (error) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true })
    if (backedUp && fs.existsSync(backupPath)) {
      if (fs.existsSync(resolvedDestination)) fs.rmSync(resolvedDestination, { force: true })
      fs.renameSync(backupPath, resolvedDestination)
    }
    throw error
  }

  return resolvedDestination
}

function exportSession(idOrPath, destinationPath, options = {}) {
  const paths = getPaths(options)
  const session = findSessionByIdOrPath(paths, idOrPath)

  if (!session) throw new Error('未找到要导出的对话')
  if (!session.path.toLowerCase().endsWith('.jsonl')) throw new Error('只允许导出对话 JSONL 文件')
  if (!fs.existsSync(session.path) || !fs.statSync(session.path).isFile()) throw new Error('对话文件不存在')

  if (!readJsonLines(session.path, 1).length) throw new Error('对话文件中没有有效的 JSONL 记录')
  const resolvedDestination = path.resolve(destinationPath)

  if (path.extname(resolvedDestination).toLowerCase() !== '.jsonl') {
    throw new Error('对话必须导出为 .jsonl 文件')
  }

  const target = exportFileAtomically(session.path, resolvedDestination)

  return { kind: 'session', target, source: session.path }
}

function addProject(projectPath, options = {}) {
  const paths = getPaths(options)
  const resolved = path.resolve(projectPath)

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('项目目录不存在')
  }

  const current = readText(paths.configPath)
  backupConfig(paths.configPath, current)

  let next = removeProjectBlock(current, resolved.toLowerCase())
  next = `${next.trimEnd()}\n\n[${projectTableName(resolved.toLowerCase())}]\ntrust_level = "trusted"\n`

  parseConfig(next)
  writeText(paths.configPath, next)

  return readStatus(options)
}

async function exportProject(projectPath, destinationPath, options = {}) {
  const paths = getPaths(options)
  const parsed = parseConfig(readText(paths.configPath))
  const requested = path.resolve(projectPath)
  const project = listProjects(parsed).find(item => path.resolve(item.path).toLowerCase() === requested.toLowerCase())

  if (!project) throw new Error('未找到要导出的项目')
  if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory()) throw new Error('项目目录不存在')

  const target = path.resolve(destinationPath)

  if (path.extname(target).toLowerCase() !== '.zip') throw new Error('项目必须导出为 .zip 压缩包')
  const relativeTarget = path.relative(path.resolve(project.path), target)

  if (!relativeTarget || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))) {
    throw new Error('导出压缩包不能保存在项目目录内部')
  }
  if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error('导出目标必须是文件')

  ensureDir(path.dirname(target))
  const stagedPath = path.join(
    path.dirname(target),
    `${path.basename(target, '.zip')}.exporting-${process.pid}-${Date.now()}.zip`
  )
  const backupPath = `${target}.backup-${process.pid}-${Date.now()}`
  let backedUp = false

  try {
    await compressDirectoryZip(project.path, stagedPath)
    if (fs.existsSync(target)) {
      fs.renameSync(target, backupPath)
      backedUp = true
    }
    fs.renameSync(stagedPath, target)
    if (backedUp) fs.rmSync(backupPath, { force: true })
  } catch (error) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true })
    if (backedUp && fs.existsSync(backupPath)) {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      fs.renameSync(backupPath, target)
    }
    throw error
  }

  return { kind: 'project', target, source: project.path }
}

function deleteProject(projectPath, options = {}) {
  const paths = getPaths(options)
  const current = readText(paths.configPath)
  backupConfig(paths.configPath, current)

  const next = removeProjectBlock(current, projectPath)

  parseConfig(next)
  writeText(paths.configPath, next)

  return readStatus(options)
}

function matchesConversationFilters(item, filters = {}) {
  const query = String(filters.query || '')
    .trim()
    .toLowerCase()
  const projectPath = String(filters.projectPath || '')
    .trim()
    .toLowerCase()

  if (filters.scope) {
    const archived = item.location === 'archived'

    if (filters.scope === 'archived' && !archived) return false
    if (filters.scope === 'active' && archived) return false
  }

  if (projectPath) {
    const cwd = String(item.cwd || item.path || '').toLowerCase()

    if (cwd !== projectPath && !cwd.startsWith(`${projectPath}\\`) && !cwd.startsWith(`${projectPath}/`)) return false
  }

  if (!query) return true

  return [item.title, item.id, item.cwd, item.path, item.name, item.trustLevel]
    .map(value => String(value || '').toLowerCase())
    .some(value => value.includes(query))
}

function rejectUnsafeProjectDeletePath(projectPath, paths) {
  const resolved = path.resolve(projectPath)
  const normalized = resolved.toLowerCase()
  const root = path.parse(resolved).root.toLowerCase().replace(/\\+$/, '')
  const home = os.homedir().toLowerCase()
  const blocked = [
    paths.codexHome,
    paths.stateDir,
    paths.sessionsPath,
    paths.archivedSessionsPath,
    paths.importedSessionsPath,
    paths.trashPath,
    paths.skillsPath,
    paths.legacySkillsPath,
    paths.agentsPath,
    paths.downloadsPath,
    process.env.SystemRoot || 'C:\\Windows',
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  ]
    .filter(Boolean)
    .map(value => path.resolve(value).toLowerCase().replace(/\\+$/, ''))

  if (!fs.existsSync(resolved)) return
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`项目路径不是文件夹：${resolved}`)
  if (normalized.replace(/\\+$/, '') === root) throw new Error(`拒绝删除磁盘根目录：${resolved}`)
  if (normalized === home || normalized.startsWith(`${home}\\.codex`))
    throw new Error(`拒绝删除用户主目录或 Codex 数据目录：${resolved}`)
  if (blocked.some(value => normalized === value || normalized.startsWith(`${value}\\`))) {
    throw new Error(`拒绝删除受保护目录：${resolved}`)
  }
}

function occupiedFileError(error) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(String(error?.code || '').toUpperCase())
}

async function deleteThreadsFromCodexIndex(sessions, paths, options = {}) {
  if (options.refreshConversationIndex !== true) return { ok: true, skipped: true, reason: 'not-requested' }
  const requests = sessions
    .map(session => String(session.id || '').trim())
    .filter(Boolean)
    .map(threadId => ({ method: 'thread/delete', params: { threadId } }))

  if (!requests.length) return { ok: true, skipped: true, reason: 'no-sessions' }
  const codexPath = options.codexCliPath || findCodexCli(options)

  if (!codexPath && !options.runAppServerRequest && !options.runAppServerBatchRequests) {
    return { ok: false, skipped: true, reason: 'codex-runtime-not-found', deletedCount: 0, errors: [] }
  }
  const requestOptions = {
    cwd: options.cwd || os.homedir(),
    env: { ...process.env, CODEX_HOME: paths.codexHome },
    timeoutMs: options.timeoutMs || Math.max(30000, requests.length * 1000)
  }

  try {
    const results = options.runAppServerBatchRequests
      ? await options.runAppServerBatchRequests(codexPath, requests, requestOptions)
      : options.runAppServerRequest
        ? await Promise.all(
            requests.map(async item => {
              try {
                const value = await options.runAppServerRequest(codexPath, item.method, item.params, requestOptions)

                return { ...item, ok: true, result: value?.result || {} }
              } catch (error) {
                return { ...item, ok: false, error: error instanceof Error ? error.message : String(error) }
              }
            })
          )
        : await runCodexAppServerBatchRequests(codexPath, requests, requestOptions)
    const errors = results
      .filter(item => item?.ok !== true)
      .map(item => ({ threadId: String(item?.params?.threadId || ''), error: String(item?.error || '删除失败') }))

    return {
      ok: errors.length === 0,
      skipped: false,
      deletedCount: results.length - errors.length,
      errors
    }
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      deletedCount: 0,
      errors: [{ threadId: '', error: error instanceof Error ? error.message : String(error) }]
    }
  }
}

async function refreshConversationIndexAfterDelete(paths, filters, options = {}) {
  if (options.refreshConversationIndex !== true) return { ok: true, skipped: true, reason: 'not-requested' }
  const request = options.runAppServerRequest || runCodexAppServerRequest
  const codexPath = options.codexCliPath || findCodexCli(options)

  if (!codexPath && !options.runAppServerRequest) {
    return { ok: false, skipped: true, reason: 'codex-runtime-not-found' }
  }

  try {
    await request(
      codexPath,
      'thread/list',
      {
        archived: filters.scope === 'archived',
        cursor: null,
        limit: 100,
        modelProviders: [],
        sourceKinds: CODEX_THREAD_SOURCE_KINDS,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        useStateDbOnly: false
      },
      {
        cwd: options.cwd || os.homedir(),
        env: { ...process.env, CODEX_HOME: paths.codexHome },
        timeoutMs: options.timeoutMs || 30000
      }
    )

    return { ok: true, skipped: false }
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function deleteConversationData(filters = {}, options = {}) {
  const paths = getPaths(options)
  const status = readStatus(options)
  const sessions = status.sessions.filter(session => matchesConversationFilters(session, filters))
  const projects = status.projects.filter(project =>
    matchesConversationFilters({ ...project, path: project.path }, filters)
  )
  const projectPaths = new Set(projects.map(project => project.path.toLowerCase()))

  for (const projectPath of sessionProjectPaths(sessions)) projectPaths.add(projectPath)
  const indexDelete = await deleteThreadsFromCodexIndex(sessions, paths, options)

  const deletedSessions = []
  const skippedSessions = []
  const skippedSessionRecords = []
  const deletedProjects = []
  const skippedProjects = []
  const removeSessionFile =
    options.removeSessionFile || (targetPath => fs.rmSync(targetPath, { force: true, maxRetries: 3, retryDelay: 200 }))
  let stopResult = null

  for (const session of sessions) {
    if (!session.path.toLowerCase().endsWith('.jsonl')) continue
    if (!fs.existsSync(session.path)) {
      deletedSessions.push(session.path)
      continue
    }

    try {
      if (!fs.statSync(session.path).isFile()) throw new Error('对话路径不是文件')
      removeSessionFile(session.path)
      deletedSessions.push(session.path)
    } catch (initialError) {
      let finalError = initialError

      if (occupiedFileError(initialError) && options.stopClientsOnBusy === true) {
        if (!stopResult) {
          const stopClients = options.stopCodexClients || stopRunningCodexClients

          stopResult = stopClients({ timeoutSeconds: 20 })
        }
        if (stopResult?.ok) {
          try {
            removeSessionFile(session.path)
            deletedSessions.push(session.path)
            continue
          } catch (retryError) {
            finalError = retryError
          }
        }
      }

      skippedSessions.push({
        path: session.path,
        error:
          stopResult && !stopResult.ok
            ? `${finalError instanceof Error ? finalError.message : String(finalError)}；${stopResult.error || 'Codex 未完全关闭'}`
            : finalError instanceof Error
              ? finalError.message
              : String(finalError)
      })
      skippedSessionRecords.push(session)
    }
  }

  const current = readText(paths.configPath)
  let next = current
  let changedConfig = false
  let configurationError = ''
  const projectsWithSkippedSessions = new Set(sessionProjectPaths(skippedSessionRecords))

  for (const projectPath of [...projectPaths]) {
    if (projectsWithSkippedSessions.has(projectPath)) {
      skippedProjects.push({
        path: projectPath,
        error: '相关对话仍被占用或无权删除，项目文件夹和配置已保留'
      })
      continue
    }
    next = removeProjectBlock(next, projectPath)
    changedConfig = true

    try {
      rejectUnsafeProjectDeletePath(projectPath, paths)

      if (fs.existsSync(projectPath)) {
        fs.rmSync(projectPath, { recursive: true, force: true })
        deletedProjects.push(projectPath)
      }
    } catch (error) {
      skippedProjects.push({
        path: projectPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (changedConfig) {
    try {
      parseConfig(next)
      backupConfig(paths.configPath, current, 'delete-conversation-data')
      writeText(paths.configPath, next)
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error)
    }
  }
  const indexRefresh = await refreshConversationIndexAfterDelete(paths, filters, options)

  return {
    status: readStatus(options),
    deletedSessionCount: deletedSessions.length,
    skippedSessionCount: skippedSessions.length,
    deletedProjectCount: deletedProjects.length,
    skippedProjectCount: skippedProjects.length,
    deletedSessions,
    skippedSessions,
    deletedProjects,
    skippedProjects,
    stoppedProcessCount: Number(stopResult?.stopped) || 0,
    configurationError,
    indexDelete,
    indexRefresh
  }
}

function importSkillZip(zipPath, options = {}) {
  const paths = getPaths(options)

  installValidatedZipPackage(zipPath, paths.skillsPath, 'SKILL.md', null, paths.downloadsPath, {
    validateSource: skillFrontmatter
  })

  return readStatus(options)
}

function installAgentTomlFile(sourcePath, paths) {
  agentDefinition(sourcePath)
  ensureDir(paths.agentsPath)
  const fileName = `${safePackageName(path.basename(sourcePath, '.toml'))}.toml`
  const targetPath = path.join(paths.agentsPath, fileName)
  const stagedPath = `${targetPath}.installing-${Date.now()}`
  const backupPath = `${targetPath}.backup-${Date.now()}`
  let backedUp = false

  try {
    fs.copyFileSync(sourcePath, stagedPath)
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath)
      backedUp = true
    }
    fs.renameSync(stagedPath, targetPath)
    if (backedUp) fs.rmSync(backupPath, { force: true })

    return [targetPath]
  } catch (error) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true })
    if (backedUp && fs.existsSync(backupPath)) {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true })
      fs.renameSync(backupPath, targetPath)
    }
    throw error
  }
}

function importAgentZip(zipPath, options = {}) {
  const paths = getPaths(options)
  const extension = path.extname(zipPath).toLowerCase()

  if (extension === '.toml') {
    installAgentTomlFile(zipPath, paths)
  } else if (extension === '.zip') {
    installTomlFilesFromZip(zipPath, paths.agentsPath, paths.downloadsPath, agentDefinition)
  } else {
    throw new Error('Agent 只支持 .toml 配置或包含 .toml 配置的 zip')
  }

  return readStatus(options)
}

async function importSkillFromGithub(url, options = {}) {
  const paths = getPaths(options)
  const zipPath = path.join(paths.downloadsPath, `skill-${Date.now()}.zip`)

  try {
    await downloadFile(url, zipPath)

    return importSkillZip(zipPath, options)
  } finally {
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })
  }
}

async function importAgentFromGithub(url, options = {}) {
  const paths = getPaths(options)
  const zipPath = path.join(paths.downloadsPath, `agent-${Date.now()}.zip`)

  try {
    await downloadFile(url, zipPath)

    return importAgentZip(zipPath, options)
  } finally {
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })
  }
}

function exportSkill(name, destinationZip, options = {}) {
  const sourcePath = resolveListedPackage(listSkills(options), name, 'Skill')

  compressZip(sourcePath, destinationZip)

  return { target: destinationZip }
}

function exportAgent(name, destinationZip, options = {}) {
  const sourcePath = resolveListedPackage(listAgents(options), name, 'Agent')

  if (fs.statSync(sourcePath).isFile()) {
    ensureDir(path.dirname(destinationZip))
    if (fs.existsSync(destinationZip)) fs.rmSync(destinationZip, { force: true })
    powershell(
      `Compress-Archive -Force -LiteralPath ${JSON.stringify(sourcePath)} -DestinationPath ${JSON.stringify(destinationZip)}`
    )
  } else {
    compressZip(sourcePath, destinationZip)
  }

  return { target: destinationZip }
}

function parsePowershellJsonArray(output) {
  const text = String(output || '').trim()

  if (!text) return []

  const parsed = JSON.parse(text)

  return Array.isArray(parsed) ? parsed : [parsed]
}

function codexClientCandidates(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
  const candidates = []

  if (process.env.CHATGPT_APP_PATH) candidates.push(process.env.CHATGPT_APP_PATH)

  for (const executable of CODEX_CLIENT_EXECUTABLE_NAMES) {
    candidates.push(path.join(localAppData, 'OpenAI', 'Codex', executable))
    candidates.push(path.join(localAppData, 'OpenAI', 'ChatGPT', executable))
    candidates.push(path.join(localAppData, 'Microsoft', 'WindowsApps', executable))
  }

  return candidates
}

function findCodexExecutableShallow(root, options = {}) {
  const maxDepth = Math.max(0, Number(options.maxDepth) || 3)
  const maxDirectories = Math.max(1, Number(options.maxDirectories) || 200)
  const queue = [{ directory: root, depth: 0 }]
  let scannedDirectories = 0

  while (queue.length && scannedDirectories < maxDirectories) {
    const current = queue.shift()

    if (!current?.directory || !fs.existsSync(current.directory)) continue
    scannedDirectories += 1

    let entries = []

    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const target = path.join(current.directory, entry.name)

      if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') return target
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ directory: target, depth: current.depth + 1 })
      }
    }
  }

  return ''
}

function findCodexQuickInstallationEvidence(targets = [], options = {}) {
  const customEnvironment = Boolean(options.localAppData || options.homeDir)

  if (!options.force && !customEnvironment && codexInstallationEvidenceCache.expiresAt > Date.now()) {
    return codexInstallationEvidenceCache.evidence
  }

  const firstTarget = Array.isArray(targets) ? targets.find(Boolean) : ''

  if (firstTarget) {
    const evidence = { found: true, kind: 'launch-target', path: firstTarget }

    if (!customEnvironment) {
      codexInstallationEvidenceCache = { expiresAt: Date.now() + CODEX_TARGETS_CACHE_MS, evidence }
    }

    return evidence
  }

  const homeDir = options.homeDir || os.homedir()
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
  const cliPath = findCodexExecutableShallow(path.join(localAppData, 'OpenAI', 'Codex', 'bin'))
  let evidence = cliPath ? { found: true, kind: 'local-runtime', path: cliPath } : null

  if (!evidence) {
    const packagesRoot = path.join(localAppData, 'Packages')

    try {
      const packageEntry = fs
        .readdirSync(packagesRoot, { withFileTypes: true })
        .find(entry => entry.isDirectory() && /^OpenAI\.(Codex|ChatGPT)_/i.test(entry.name))

      if (packageEntry) {
        evidence = {
          found: true,
          kind: 'appx-package-data',
          path: path.join(packagesRoot, packageEntry.name)
        }
      }
    } catch {
      // Package data discovery is best-effort and never invokes PowerShell.
    }
  }

  const result = evidence || { found: false, kind: 'not-found', path: '' }

  if (!customEnvironment) {
    codexInstallationEvidenceCache = { expiresAt: Date.now() + CODEX_TARGETS_CACHE_MS, evidence: result }
  }

  return result
}

function findCodexLaunchTargets(options = {}) {
  if (!options.force && codexTargetsCache.expiresAt > Date.now()) {
    return codexTargetsCache
  }

  const targets = []
  const appLaunchers = []
  const targetKeys = new Set()
  const launcherKeys = new Set()

  const pushIfExists = candidate => {
    const value = String(candidate || '').trim()

    if (!value || !fs.existsSync(value)) return null

    const key = value.toLowerCase()

    if (!targetKeys.has(key)) {
      targets.push(value)
      targetKeys.add(key)
    }

    return value
  }

  const pushAppLauncher = (candidate, appId) => {
    const target = pushIfExists(candidate)
    const launcherId = String(appId || '').trim()

    if (!target || !launcherId) return

    const key = launcherId.toLowerCase()

    if (!launcherKeys.has(key)) {
      appLaunchers.push({ appId: launcherId, target })
      launcherKeys.add(key)
    }
  }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "$names = @('Codex.exe','ChatGPT.exe'); Get-CimInstance Win32_Process | Where-Object { $names -icontains $_.Name } | Select-Object -ExpandProperty ExecutablePath -Unique"
        ],
        { encoding: 'utf8', windowsHide: true }
      )

      output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .forEach(pushIfExists)
    } catch {
      // Process discovery is best-effort.
    }

    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          [
            "@('OpenAI.Codex','OpenAI.ChatGPT') | ForEach-Object { Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue } | ForEach-Object {",
            '  $package = $_',
            '  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName',
            '  foreach ($app in @($manifest.Package.Applications.Application)) {',
            "    $exe = $app.Executable -replace '/', [System.IO.Path]::DirectorySeparatorChar",
            '    [pscustomobject]@{',
            '      appId = "$($package.PackageFamilyName)!$($app.Id)"',
            '      path = (Join-Path $package.InstallLocation $exe)',
            '    }',
            '  }',
            '} | ConvertTo-Json -Compress'
          ].join('\n')
        ],
        { encoding: 'utf8', windowsHide: true }
      )

      parsePowershellJsonArray(output)
        .filter(item => /\\(Codex|ChatGPT)\.exe$/i.test(String(item.path || '')))
        .forEach(item => pushAppLauncher(item.path, item.appId))
    } catch {
      // Appx discovery is best-effort.
    }

    const windowsApps = 'C:\\Program Files\\WindowsApps'

    try {
      fs.readdirSync(windowsApps)
        .filter(name => /^OpenAI\.(Codex|ChatGPT)_/i.test(name))
        .sort()
        .reverse()
        .forEach(name => {
          for (const executable of CODEX_CLIENT_EXECUTABLE_NAMES) {
            pushIfExists(path.join(windowsApps, name, 'app', executable))
          }
        })
    } catch {
      // WindowsApps can be unreadable on some machines.
    }
  }

  codexClientCandidates(options).forEach(pushIfExists)

  codexTargetsCache = { expiresAt: Date.now() + CODEX_TARGETS_CACHE_MS, targets, appLaunchers }
  codexInstallationEvidenceCache = {
    expiresAt: Date.now() + CODEX_TARGETS_CACHE_MS,
    evidence: targets.length
      ? { found: true, kind: 'launch-target', path: targets[0] }
      : findCodexQuickInstallationEvidence([], { ...options, force: true })
  }

  return codexTargetsCache
}

function findCodexTargets(options = {}) {
  return findCodexLaunchTargets(options).targets
}

function findCodexQuickTargets(options = {}) {
  if (!options.force && codexTargetsCache.expiresAt > Date.now() && codexTargetsCache.targets.length) {
    return [...codexTargetsCache.targets]
  }

  const targets = []
  const seen = new Set()
  const add = candidate => {
    const value = String(candidate || '').trim()

    if (!value || seen.has(value.toLowerCase()) || !fs.existsSync(value)) return
    seen.add(value.toLowerCase())
    targets.push(value)
  }

  codexClientCandidates(options).forEach(add)

  if (process.platform === 'win32') {
    const windowsApps = 'C:\\Program Files\\WindowsApps'

    try {
      fs.readdirSync(windowsApps)
        .filter(name => /^OpenAI\.(Codex|ChatGPT)_/i.test(name))
        .sort()
        .reverse()
        .forEach(name => {
          for (const executable of CODEX_CLIENT_EXECUTABLE_NAMES) {
            add(path.join(windowsApps, name, 'app', executable))
          }
        })
    } catch {
      // Quick status reads never invoke PowerShell or block on Appx discovery.
    }
  }

  return targets
}

function findCodexCli(options = {}) {
  const candidates = []
  const seen = new Set()
  const add = (candidate, priority = 5) => {
    const value = String(candidate || '').trim()

    if (!value || path.basename(value).toLowerCase() !== 'codex.exe' || !fs.existsSync(value)) return
    const key = value.toLowerCase()

    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ value, priority })
  }
  const scan = (directory, priority) => {
    if (!directory || !fs.existsSync(directory)) return

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)

      if (entry.isDirectory()) scan(target, priority)
      else add(target, priority)
    }
  }

  add(options.codexCliPath, 0)
  add(process.env.CODEX_CLI_PATH, 0)
  scan(path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'), 1)

  for (const target of findCodexTargets(options)) {
    const appDir = path.dirname(target)

    add(path.join(appDir, 'resources', 'codex.exe'), 2)
    add(path.join(appDir, 'resources', 'codex', 'codex.exe'), 2)
  }

  try {
    execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .forEach(candidate => add(candidate, 3))
  } catch {
    // PATH discovery is best-effort.
  }

  return (
    candidates
      .map(item => {
        try {
          return { ...item, modifiedAt: fs.statSync(item.value).mtimeMs }
        } catch {
          return { ...item, modifiedAt: 0 }
        }
      })
      .sort((left, right) => left.priority - right.priority || right.modifiedAt - left.modifiedAt)[0]?.value || ''
  )
}

function findBundledCodexTool(fileName, options = {}) {
  const expectedName = String(fileName || '').toLowerCase()
  const candidates = []
  const roots = [options.codexBinPath, path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')].filter(
    Boolean
  )

  for (const root of roots) {
    if (!fs.existsSync(root)) continue

    for (const candidate of walkFiles(root, filePath => path.basename(filePath).toLowerCase() === expectedName)) {
      try {
        candidates.push({ value: candidate, modifiedAt: fs.statSync(candidate).mtimeMs })
      } catch {
        // Ignore files that disappear during a client update.
      }
    }
  }

  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.value || ''
}

function runCodexAppServerRequest(codexPath, method, params = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess || spawn
    const child = spawnProcess(codexPath, ['app-server'], {
      cwd: options.cwd || os.homedir(),
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const output = readline.createInterface({ input: child.stdout })
    const stderr = []
    const requestId = 2
    let requestResult = null
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      output.close()
      if (!child.killed) child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const pipeError = error => {
      const details = stderr.join('').trim()
      const code = error?.code ? ` ${error.code}` : ''
      const wrapped = new Error(
        `Codex app-server 管道已关闭${code}：${error?.message || method}${details ? `；${details.slice(-1000)}` : ''}`
      )

      if (error?.code) wrapped.code = error.code
      finish(wrapped)
    }
    const send = message => {
      if (settled) return false

      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded || child.stdin.writable === false) {
        pipeError(Object.assign(new Error(`无法发送 ${method}`), { code: 'EPIPE' }))
        return false
      }

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (error) pipeError(error)
        })
        return true
      } catch (error) {
        pipeError(error)
        return false
      }
    }
    const timer = setTimeout(() => {
      finish(new Error(`Codex 本地运行时请求超时：${method}`))
    }, options.timeoutMs || 30000)

    child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')))
    child.stdin.on('error', pipeError)
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      if (!settled) {
        const exit = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`

        finish(
          new Error(`Codex app-server 在完成 ${method} 前退出（${exit}）：${stderr.join('').trim() || '无错误输出'}`)
        )
      }
    })
    output.on('line', line => {
      let message

      try {
        message = JSON.parse(line)
      } catch {
        return
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message || 'Codex app-server 初始化失败'))
          return
        }

        send({ method: 'initialized', params: {} })
        send({ method, id: requestId, params })
        return
      }

      if (message.id === requestId) {
        if (message.error) {
          finish(new Error(message.error.message || `${method} 失败`))
          return
        }

        requestResult = message.result || {}
        if (!options.waitForNotification) finish(null, { result: requestResult, notification: null })
        return
      }

      if (options.waitForNotification && message.method === options.waitForNotification) {
        finish(null, { result: requestResult || {}, notification: message.params || {} })
      }
    })

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'chatgpt_model_manager',
          title: 'ChatGPT Model Manager',
          version: APP_VERSION
        },
        capabilities: { experimentalApi: true }
      }
    })
  })
}

function runCodexAppServerBatchRequests(codexPath, requests, options = {}) {
  const items = Array.isArray(requests) ? requests.filter(item => item?.method) : []

  if (!items.length) return Promise.resolve([])

  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess || spawn
    const child = spawnProcess(codexPath, ['app-server'], {
      cwd: options.cwd || os.homedir(),
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const output = readline.createInterface({ input: child.stdout })
    const stderr = []
    const results = new Array(items.length)
    const requestIndexById = new Map(items.map((_item, index) => [index + 2, index]))
    let completed = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      output.close()
      if (!child.killed) child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const pipeError = error => {
      const details = stderr.join('').trim()
      const code = error?.code ? ` ${error.code}` : ''
      const wrapped = new Error(
        `Codex app-server 批量请求管道已关闭${code}：${error?.message || 'batch'}${
          details ? `；${details.slice(-1000)}` : ''
        }`
      )

      if (error?.code) wrapped.code = error.code
      finish(wrapped)
    }
    const send = message => {
      if (settled) return false
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded || child.stdin.writable === false) {
        pipeError(Object.assign(new Error('无法发送批量请求'), { code: 'EPIPE' }))
        return false
      }

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (error) pipeError(error)
        })
        return true
      } catch (error) {
        pipeError(error)
        return false
      }
    }
    const timer = setTimeout(() => {
      finish(new Error('Codex 本地运行时批量请求超时'))
    }, options.timeoutMs || 30000)

    child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')))
    child.stdin.on('error', pipeError)
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      if (!settled) {
        const exit = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`

        finish(new Error(`Codex app-server 在批量请求完成前退出（${exit}）：${stderr.join('').trim() || '无错误输出'}`))
      }
    })
    output.on('line', line => {
      let message

      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message || 'Codex app-server 初始化失败'))
          return
        }
        send({ method: 'initialized', params: {} })
        items.forEach((item, index) => send({ method: item.method, id: index + 2, params: item.params || {} }))
        return
      }
      const index = requestIndexById.get(message.id)

      if (index === undefined || results[index]) return
      const item = items[index]

      results[index] = message.error
        ? {
            method: item.method,
            params: item.params || {},
            ok: false,
            error: message.error.message || `${item.method} 失败`
          }
        : { method: item.method, params: item.params || {}, ok: true, result: message.result || {} }
      completed += 1
      if (completed === items.length) finish(null, results)
    })

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'chatgpt_model_manager',
          title: 'ChatGPT Model Manager',
          version: APP_VERSION
        },
        capabilities: { experimentalApi: true }
      }
    })
  })
}

async function repairCodexConversationIndex(options = {}) {
  const paths = getPaths(options)
  const projectRepair = ensureProjectsFromSessions(paths, options)
  const request = options.runAppServerRequest || runCodexAppServerRequest
  const codexPath = options.codexCliPath || findCodexCli(options)

  if (!codexPath && !options.runAppServerRequest) {
    throw new Error('没有找到 ChatGPT/Codex 自带的 codex.exe，无法修复客户端对话索引。')
  }

  const requestOptions = {
    cwd: options.cwd || os.homedir(),
    env: { ...process.env, CODEX_HOME: paths.codexHome },
    timeoutMs: options.timeoutMs || 60000
  }
  const collectThreads = async (useStateDbOnly, useDesktopFilters = true) => {
    const threads = []
    let cursor = null

    for (let page = 0; page < 100; page += 1) {
      const response = await request(
        codexPath,
        'thread/list',
        {
          archived: false,
          cursor,
          limit: 100,
          // The desktop request layer normalizes its UI-level null to [] on the app-server wire.
          // Sending raw null here means "no providers" and makes every local task disappear.
          modelProviders: [],
          sourceKinds: useDesktopFilters ? [] : CODEX_THREAD_SOURCE_KINDS,
          sortKey: 'recency_at',
          sortDirection: 'desc',
          useStateDbOnly
        },
        requestOptions
      )
      const data = Array.isArray(response?.result?.data) ? response.result.data : []

      threads.push(
        ...data.filter(thread => {
          if (!useDesktopFilters) return true

          return thread?.ephemeral !== true && thread?.threadSource !== 'ambient_suggestions'
        })
      )
      cursor = response?.result?.nextCursor || null
      if (!cursor || !data.length) break
    }

    return threads
  }
  const diskSessions = listSessions(paths).filter(session => session.location !== 'archived')
  const diskIds = new Set(diskSessions.map(session => String(session.id || '')).filter(Boolean))
  const indexedBefore = await collectThreads(true)
  const indexedBeforeIds = new Set(
    indexedBefore.map(thread => String(thread.id || thread.sessionId || '')).filter(Boolean)
  )
  const missingBefore = [...diskIds].filter(id => !indexedBeforeIds.has(id))

  // Force Codex to scan rollout files and update its SQLite state before changing any metadata.
  await collectThreads(false, false)

  const indexedAfterScan = await collectThreads(true)
  const indexedAfterScanIds = new Set(
    indexedAfterScan.map(thread => String(thread.id || thread.sessionId || '')).filter(Boolean)
  )
  const missingAfterScan = [...diskIds].filter(id => !indexedAfterScanIds.has(id))
  const missingAfterScanIds = new Set(missingAfterScan)
  const normalizedSessions = []

  for (const session of diskSessions) {
    if (!missingAfterScanIds.has(session.id)) continue

    const normalized = normalizeSessionForDesktop(session.path)

    if (normalized) normalizedSessions.push({ id: session.id, ...normalized })
  }

  const reindexedSessions = []
  const reindexErrors = []

  if (normalizedSessions.length) {
    const stagingDir = path.join(paths.stateDir, 'conversation-reindex-staging')

    ensureDir(stagingDir)

    for (const session of normalizedSessions) {
      const safeId = String(session.id || 'session').replace(/[^a-zA-Z0-9_-]/g, '_')
      const stagingPath = path.join(stagingDir, `${safeId}-${Date.now()}.jsonl`)
      let restored = false

      try {
        fs.copyFileSync(session.sessionPath, stagingPath)
        await request(codexPath, 'thread/delete', { threadId: session.id }, requestOptions)
        ensureDir(path.dirname(session.sessionPath))
        fs.copyFileSync(stagingPath, session.sessionPath)
        restored = true
        reindexedSessions.push(session.id)
      } catch (error) {
        reindexErrors.push({
          id: session.id,
          error: error instanceof Error ? error.message : String(error),
          recoveryPath: stagingPath
        })
      } finally {
        if (!restored && fs.existsSync(stagingPath)) {
          try {
            ensureDir(path.dirname(session.sessionPath))
            fs.copyFileSync(stagingPath, session.sessionPath)
            restored = true
          } catch (error) {
            reindexErrors.push({
              id: session.id,
              error: `会话恢复失败：${error instanceof Error ? error.message : String(error)}`,
              recoveryPath: stagingPath
            })
          }
        }

        if (restored && fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true })
      }
    }

    // Re-scan after removing only the stale SQLite rows and immediately restoring the rollout files.
    await collectThreads(false, false)
  }

  const indexedAfter = await collectThreads(true)
  const indexedAfterIds = new Set(
    indexedAfter.map(thread => String(thread.id || thread.sessionId || '')).filter(Boolean)
  )
  const missingAfter = [...diskIds].filter(id => !indexedAfterIds.has(id))
  const allIndexedAfter = await collectThreads(true, false)
  const allIndexedThreadSummaries = allIndexedAfter.slice(0, 50).map(thread => ({
    id: String(thread.id || thread.sessionId || ''),
    source: thread.source || '',
    threadSource: thread.threadSource || '',
    historyMode: thread.historyMode || '',
    modelProvider: thread.modelProvider || '',
    ephemeral: thread.ephemeral === true,
    archived: thread.archived === true,
    cwd: thread.cwd || ''
  }))

  return {
    ok: missingAfter.length === 0,
    repaired: missingAfter.length < missingBefore.length,
    diskSessionCount: diskIds.size,
    indexedBeforeCount: indexedBeforeIds.size,
    indexedAfterCount: indexedAfterIds.size,
    allIndexedAfterCount: allIndexedAfter.length,
    missingBeforeCount: missingBefore.length,
    missingSessionCount: missingAfter.length,
    missingSessionIds: missingAfter.slice(0, 20),
    normalizedSessionCount: normalizedSessions.length,
    normalizedSessions: normalizedSessions.map(session => ({
      id: session.id,
      backupPath: session.backupPath
    })),
    reindexedSessionCount: reindexedSessions.length,
    reindexedSessionIds: reindexedSessions,
    reindexErrors,
    allIndexedThreadSummaries,
    addedProjectCount: projectRepair.addedProjectCount,
    addedProjects: projectRepair.addedProjects,
    status: readStatus(options)
  }
}

async function inspectLocalToolRuntime(options = {}) {
  if (process.platform !== 'win32' && !options.allowNonWindows) {
    return {
      supported: false,
      healthy: false,
      readiness: 'unsupported',
      codexPath: '',
      codexVersion: '',
      doctorStatus: 'unavailable',
      doctorErrors: [],
      doctorWarnings: [],
      doctorLocalErrors: [],
      doctorLocalWarnings: [],
      doctorProviderIssues: [],
      localDoctorStatus: 'unavailable',
      providerDoctorStatus: 'unavailable',
      powershellOk: false,
      shellTestOk: false,
      message: '本地工具环境初始化目前仅支持 Windows。'
    }
  }

  const codexPath = findCodexCli(options)

  if (!codexPath) {
    return {
      supported: true,
      healthy: false,
      readiness: 'notConfigured',
      codexPath: '',
      codexVersion: '',
      doctorStatus: 'error',
      doctorErrors: [
        {
          id: 'installation',
          summary: '没有找到 ChatGPT/Codex 自带的 codex.exe。',
          remediation: '重新安装或更新 ChatGPT/Codex Windows 客户端。'
        }
      ],
      doctorWarnings: [],
      doctorLocalErrors: [
        {
          id: 'installation',
          status: 'error',
          summary: '没有找到 ChatGPT/Codex 自带的 codex.exe。',
          remediation: '重新安装或更新 ChatGPT/Codex Windows 客户端。'
        }
      ],
      doctorLocalWarnings: [],
      doctorProviderIssues: [],
      localDoctorStatus: 'error',
      providerDoctorStatus: 'unknown',
      powershellOk: false,
      shellTestOk: false,
      message: '没有找到 ChatGPT/Codex 自带的 codex.exe。'
    }
  }

  const paths = getPaths(options)
  const runtimeEnvironment = { ...process.env }
  const ripgrepPath = findBundledCodexTool('rg.exe', options)

  if (ripgrepPath) {
    const pathKey = Object.keys(runtimeEnvironment).find(key => key.toLowerCase() === 'path') || 'Path'
    const currentPath = String(runtimeEnvironment[pathKey] || '')

    runtimeEnvironment[pathKey] = [path.dirname(ripgrepPath), currentPath].filter(Boolean).join(path.delimiter)
  }

  const [versionResult, readinessResult, doctorResult] = await Promise.allSettled([
    execFileText(codexPath, ['--version'], { timeout: 10000 }),
    runCodexAppServerRequest(
      codexPath,
      'windowsSandbox/readiness',
      {},
      {
        cwd: paths.codexHome,
        timeoutMs: 20000,
        env: runtimeEnvironment
      }
    ),
    execFileText(codexPath, ['doctor', '--json'], { cwd: paths.codexHome, timeout: 60000, env: runtimeEnvironment })
  ])
  const readiness =
    readinessResult.status === 'fulfilled'
      ? String(readinessResult.value.result?.status || 'notConfigured')
      : 'notConfigured'
  let doctor = null
  const doctorText =
    doctorResult.status === 'fulfilled'
      ? doctorResult.value
      : String(doctorResult.reason?.stdout || doctorResult.reason?.stderr || '')

  try {
    doctor = doctorText.trim() ? JSON.parse(doctorText) : null
  } catch {
    doctor = null
  }
  const doctorChecks = Object.values(doctor?.checks || {})
  const doctorErrors = doctorChecks.filter(check => check?.status === 'error').map(doctorIssue)
  const doctorWarnings = doctorChecks.filter(check => check?.status === 'warning').map(doctorIssue)
  const doctorProviderIssues = doctorChecks
    .filter(check => isProviderDoctorIssue(check) && ['error', 'warning'].includes(String(check?.status || '')))
    .map(doctorIssue)
  const doctorLocalErrors = doctorChecks
    .filter(check => !isProviderDoctorIssue(check) && check?.status === 'error')
    .map(doctorIssue)
  const doctorLocalWarnings = doctorChecks
    .filter(check => !isProviderDoctorIssue(check) && check?.status === 'warning')
    .map(doctorIssue)

  let powershellOk = false
  let shellTestOk = false
  let shellTestMessage = ''

  try {
    powershellOk = (
      await execFileText('powershell.exe', ['-NoProfile', '-Command', 'Write-Output POWERSHELL_OK'], { timeout: 10000 })
    ).includes('POWERSHELL_OK')
  } catch (error) {
    shellTestMessage = error.message
  }

  if (readiness === 'ready' && powershellOk) {
    try {
      const result = await execFileText(
        codexPath,
        ['sandbox', 'powershell.exe', '-NoProfile', '-Command', 'Write-Output CODEX_LOCAL_TOOL_OK'],
        { cwd: paths.codexHome, timeout: 30000, env: runtimeEnvironment }
      )

      shellTestOk = result.includes('CODEX_LOCAL_TOOL_OK')
    } catch (error) {
      shellTestMessage = `${error.message} ${error.stderr || ''}`.trim()
    }
  }

  const healthy = readiness === 'ready' && powershellOk && shellTestOk
  const localDoctorStatus = doctorLocalErrors.length
    ? 'error'
    : doctor
      ? doctorLocalWarnings.length
        ? 'warning'
        : 'ok'
      : doctorResult.status === 'fulfilled'
        ? 'unknown'
        : 'error'
  const providerDoctorStatus = doctorProviderIssues.some(item => item.status === 'error')
    ? 'error'
    : doctorProviderIssues.length
      ? 'warning'
      : doctor
        ? 'ok'
        : 'unknown'

  return {
    supported: true,
    healthy,
    readiness,
    codexPath,
    codexVersion: versionResult.status === 'fulfilled' ? versionResult.value.trim() : '',
    doctorStatus: doctor?.overallStatus || (doctorResult.status === 'fulfilled' ? 'unknown' : 'error'),
    doctorErrors,
    doctorWarnings,
    doctorLocalErrors,
    doctorLocalWarnings,
    doctorProviderIssues,
    localDoctorStatus,
    providerDoctorStatus,
    powershellOk,
    shellTestOk,
    shellTestMessage: shellTestMessage.slice(0, 500),
    message: healthy
      ? doctorProviderIssues.length
        ? 'Codex Windows 本地工具、PowerShell 与 Sandbox 均已通过。Doctor 的异常来自当前 Provider 网络或鉴权，不是本地工具损坏；切换到已测试通过的渠道后重新检测即可。'
        : 'Codex Windows 本地工具运行环境已就绪，PowerShell 沙箱命令自检通过。'
      : readiness === 'updateRequired'
        ? 'Codex Windows Sandbox 需要更新后才能运行本地工具。'
        : readiness === 'notConfigured'
          ? 'Codex Windows Sandbox 尚未完成初始化。'
          : '本地工具环境尚未通过自检。'
  }
}

async function initializeLocalToolRuntime(mode = 'elevated', options = {}) {
  const setupMode = mode === 'unelevated' ? 'unelevated' : 'elevated'
  const codexPath = findCodexCli(options)

  if (!codexPath) throw new Error('没有找到 ChatGPT/Codex 自带的 codex.exe。')

  const paths = getPaths(options)
  const before = await inspectLocalToolRuntime(options)

  if (before.healthy && options.force !== true) return { initialized: false, mode: setupMode, before, after: before }

  const setup = await runCodexAppServerRequest(
    codexPath,
    'windowsSandbox/setupStart',
    { mode: setupMode, cwd: path.resolve(options.cwd || paths.codexHome) },
    {
      cwd: paths.codexHome,
      timeoutMs: options.setupTimeoutMs || 180000,
      waitForNotification: 'windowsSandbox/setupCompleted'
    }
  )

  if (setup.notification?.success !== true) {
    throw new Error(setup.notification?.error || `Windows Sandbox ${setupMode} 初始化失败。`)
  }

  const after = await inspectLocalToolRuntime(options)

  if (!after.healthy) throw new Error(after.shellTestMessage || after.message)

  return { initialized: true, mode: setupMode, before, after }
}

function repairGeneratedCodexFiles(options = {}) {
  const paths = getPaths(options)
  const repaired = []
  const backups = []

  for (const [name, filePath] of [
    ['config.toml', paths.configPath],
    [MODELS_CACHE_FILENAME, paths.modelsCachePath]
  ]) {
    if (!fs.existsSync(filePath)) continue

    const snapshot = backupFile(filePath, `repair-${name.replace(/[^a-z0-9._-]+/gi, '-')}`)

    fs.rmSync(filePath, { force: true })
    repaired.push(name)
    if (snapshot?.backupPath) backups.push(snapshot.backupPath)
  }

  return { repaired: repaired.length > 0, files: repaired, backups }
}

function repairCodexAppRegistration(options = {}) {
  if (process.platform !== 'win32' || options.skipAppRepair) return { ok: true, skipped: true }

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "$packages = @('OpenAI.Codex','OpenAI.ChatGPT') | ForEach-Object { Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue }",
          '$repaired = @()',
          'foreach ($package in @($packages)) {',
          "  $manifest = Join-Path $package.InstallLocation 'AppxManifest.xml'",
          '  if (Test-Path -LiteralPath $manifest) {',
          '    Add-AppxPackage -DisableDevelopmentMode -Register $manifest -ErrorAction Stop',
          '    $repaired += $package.Name',
          '  }',
          '}',
          '[pscustomobject]@{ ok = $true; repaired = $repaired } | ConvertTo-Json -Compress'
        ].join('\n')
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(String(output || '').trim() || '{}')

    return { ok: parsed.ok === true, repaired: Array.isArray(parsed.repaired) ? parsed.repaired : [] }
  } catch (error) {
    return {
      ok: false,
      error: restartErrorMessage(error)
    }
  }
}

async function repairLocalToolRuntime(mode = 'elevated', options = {}) {
  const before = await inspectLocalToolRuntime(options)
  const stopped = stopRunningCodexClients({ timeoutSeconds: 12 })
  const configRepair = repairGeneratedCodexFiles(options)
  const appRepair = repairCodexAppRegistration(options)
  const setupMode = mode === 'unelevated' ? 'unelevated' : 'elevated'

  if (before.healthy) {
    const restart = restartCodex({ dryRun: options.dryRunRestart })

    return {
      repaired: configRepair.repaired || appRepair.ok === true,
      initialized: false,
      mode: setupMode,
      before,
      after: before,
      stopped,
      configRepair,
      appRepair,
      restart,
      warning: configRepair.repaired
        ? '已备份并移除 config.toml / models_cache.json，ChatGPT 会在下次启动时重新生成干净配置。'
        : before.doctorProviderIssues?.length
          ? '本地工具环境已通过。Doctor 的剩余失败来自当前 Provider 网络或鉴权，不是本地工具损坏。'
          : '本地工具环境已通过；已执行 ChatGPT 应用修复检查。'
    }
  }

  try {
    const result = await initializeLocalToolRuntime(mode, { ...options, force: true })
    const restart = restartCodex({ dryRun: options.dryRunRestart })

    return { ...result, repaired: true, stopped, configRepair, appRepair, restart }
  } catch (error) {
    const after = await inspectLocalToolRuntime(options)

    if (after.healthy) {
      const restart = restartCodex({ dryRun: options.dryRunRestart })

      return {
        repaired: configRepair.repaired || appRepair.ok === true,
        initialized: false,
        mode: setupMode,
        before,
        after,
        stopped,
        configRepair,
        appRepair,
        restart,
        warning: error instanceof Error ? error.message : String(error || '修复未执行')
      }
    }

    throw error
  }
}
function codexTargetRank(target) {
  if (/\\resources\\|\\OpenAI\\Codex\\bin\\/i.test(target)) return 9
  if (/\\app\\(Codex|ChatGPT)\.exe$/i.test(target)) return 0
  if (/\\(Codex|ChatGPT)\.exe$/i.test(target)) return 1

  return 9
}

function preferredCodexTarget(targets) {
  return targets.slice().sort((left, right) => codexTargetRank(left) - codexTargetRank(right))[0] || null
}

function stopRunningCodexClients(options = {}) {
  const timeoutSeconds = Math.max(3, Number(options.timeoutSeconds) || 20)

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "$names = @('ChatGPT.exe', 'Codex.exe')",
          '$clients = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $names -icontains $_.Name })',
          '$clients | ForEach-Object {',
          '  try {',
          '    $process = Get-Process -Id $_.ProcessId -ErrorAction Stop',
          '    if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }',
          '  } catch {}',
          '}',
          '$graceDeadline = (Get-Date).AddSeconds(8)',
          'do {',
          '  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $names -icontains $_.Name })',
          '  if ($running.Count -eq 0) { break }',
          '  Start-Sleep -Milliseconds 200',
          '} while ((Get-Date) -lt $graceDeadline)',
          '$running | Sort-Object ProcessId -Descending | ForEach-Object {',
          '  & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null',
          '}',
          `$deadline = (Get-Date).AddSeconds(${timeoutSeconds})`,
          'do {',
          '  $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $names -icontains $_.Name })',
          '  if ($remaining.Count -eq 0) { break }',
          '  Start-Sleep -Milliseconds 250',
          '} while ((Get-Date) -lt $deadline)',
          '[pscustomobject]@{',
          '  ok = ($remaining.Count -eq 0)',
          '  stopped = @($clients).Count',
          '  remaining = @($remaining | ForEach-Object { "$($_.Name):$($_.ProcessId)" })',
          '} | ConvertTo-Json -Compress'
        ].join('\n')
      ],
      { encoding: 'utf8', windowsHide: true, timeout: (timeoutSeconds + 8) * 1000 }
    )

    const result = JSON.parse(String(output || '').trim() || '{}')

    return {
      ok: result.ok === true,
      stopped: Number(result.stopped) || 0,
      remaining: Array.isArray(result.remaining) ? result.remaining : result.remaining ? [String(result.remaining)] : []
    }
  } catch {
    return { ok: false, stopped: 0, remaining: [], error: '无法完整关闭当前 ChatGPT/Codex 进程。' }
  }
}

function launchCodexTarget(target, appId) {
  if (process.platform === 'win32') {
    if (appId) {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      })

      child.on('error', () => {})
      child.unref()
      return
    }

    if (/^C:\\Program Files\\WindowsApps\\/i.test(target)) {
      const error = new Error('WindowsApps 客户端必须通过系统应用入口启动')

      error.code = 'EPERM'
      throw error
    }

    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Start-Process -FilePath ${JSON.stringify(target)}`],
      { windowsHide: true, stdio: 'ignore' }
    )

    return
  }

  const child = spawn(target, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  })

  child.unref()
}

function waitForCodexClient(timeoutSeconds = 15) {
  if (process.platform !== 'win32') return true

  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$deadline = (Get-Date).AddSeconds(${Math.max(1, Number(timeoutSeconds) || 8)})`,
          'do {',
          "  $client = Get-CimInstance Win32_Process | Where-Object { @('ChatGPT.exe','Codex.exe') -icontains $_.Name -and $_.ExecutablePath -notlike '*\\resources\\*' } | Select-Object -First 1",
          '  if ($client) { exit 0 }',
          '  Start-Sleep -Milliseconds 200',
          '} while ((Get-Date) -lt $deadline)',
          'exit 1'
        ].join('\n')
      ],
      { windowsHide: true, stdio: 'ignore' }
    )

    return true
  } catch {
    return false
  }
}

function restartErrorMessage(error) {
  const details = [error?.message, error?.stderr ? String(error.stderr) : '', error?.stdout ? String(error.stdout) : '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (error?.code === 'EPERM' || /EPERM|access is denied|拒绝访问/i.test(details)) {
    return 'Windows 拒绝启动客户端，请手动重启 ChatGPT。'
  }

  return details ? details.slice(0, 240) : '自动重启失败，请手动重启 ChatGPT。'
}

function restartCodex(options = {}) {
  reportActivationProgress(options, 'locating-client', 60, '正在查找 Codex 客户端启动位置')
  let launchTargets = options.launchTargets || findCodexLaunchTargets({ force: options.forceTargetRefresh === true })

  if (!options.launchTargets && !launchTargets.targets.length && options.forceTargetRefresh !== true) {
    launchTargets = findCodexLaunchTargets({ force: true })
  }
  const targets = launchTargets.targets
  const target = preferredCodexTarget(targets)
  const appLauncher = target
    ? launchTargets.appLaunchers.find(item => item.target.toLowerCase() === target.toLowerCase())
    : launchTargets.appLaunchers[0]
  const appId = appLauncher?.appId || null

  if (options.dryRun) {
    reportActivationProgress(options, 'client-ready', 94, 'Codex 启动流程检查完成')
    return { dryRun: true, ok: true, target, targets, appId }
  }

  if (!target) {
    reportActivationProgress(options, 'client-not-found', 94, '没有找到 Codex 客户端，需要手动启动', 'warning')
    return { ok: false, target: null, targets, appId, error: '未找到 Codex/ChatGPT 客户端启动位置，无法自动重启。' }
  }

  if (process.platform === 'win32' || options.forceWindowsRestart) {
    const stopClients = options.stopClients || stopRunningCodexClients

    reportActivationProgress(options, 'closing-client', 66, '正在关闭旧的 Codex 进程')
    const stopResult = stopClients(options.stopOptions)

    if (!stopResult?.ok) {
      const remaining =
        Array.isArray(stopResult?.remaining) && stopResult.remaining.length
          ? `仍在运行：${stopResult.remaining.join('、')}`
          : stopResult?.error || 'Windows 拒绝结束旧实例'

      reportActivationProgress(options, 'close-failed', 94, '旧 Codex 进程未完全关闭，需要手动处理', 'warning')
      return {
        ok: false,
        target,
        targets,
        appId,
        stopped: stopResult?.stopped || 0,
        error: `当前 ChatGPT/Codex 尚未完全关闭，已取消重启。${remaining}`
      }
    }
  }

  let afterStopResult = null

  if (typeof options.afterStop === 'function') {
    reportActivationProgress(options, 'syncing-projects', 72, '正在同步历史任务与 Projects')

    try {
      afterStopResult = options.afterStop()
    } catch (error) {
      reportActivationProgress(options, 'project-sync-failed', 94, 'Projects 同步失败，已取消启动以保护数据', 'error')

      return {
        ok: false,
        target,
        targets,
        appId,
        afterStopResult: null,
        error: `Codex 已关闭，但 Projects 同步失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  const launchTarget = options.launchTarget || launchCodexTarget
  const waitForClient = options.waitForClient || waitForCodexClient

  let lastError = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      reportActivationProgress(
        options,
        'launching-client',
        attempt === 0 ? 76 : 89,
        attempt === 0 ? '正在启动 Codex 客户端' : '正在重试启动 Codex 客户端'
      )
      launchTarget(target, appId)

      reportActivationProgress(
        options,
        'waiting-for-client',
        attempt === 0 ? 86 : 92,
        '启动入口已调用，正在等待 Codex 进程就绪'
      )
      if (waitForClient()) {
        reportActivationProgress(options, 'client-ready', 94, '已检测到 Codex 进程')
        return { ok: true, target, targets, appId, afterStopResult }
      }

      lastError = new Error('系统应用入口已调用，但没有检测到 ChatGPT 进程')
    } catch (error) {
      lastError = error
    }
  }

  reportActivationProgress(options, 'launch-failed', 94, '没有检测到 Codex 进程，需要手动启动', 'warning')
  return { ok: false, target, targets, appId, afterStopResult, error: restartErrorMessage(lastError) }
}

async function verifyLocalAgentExecution(options = {}) {
  const codexPath = findCodexCli(options)

  if (!codexPath) throw new Error('没有找到 ChatGPT/Codex 自带的 codex.exe。')

  const paths = getPaths(options)
  const prompt = [
    'You are running inside Codex on Windows.',
    'Use the available shell tool now to execute exactly this Windows task:',
    'start notepad.exe and start calc.exe.',
    'You must call the shell tool and perform the task. Do not only explain how to do it.',
    'After the tool result is returned, reply with LOCAL_WINDOWS_TOOLS_OK.'
  ].join(' ')
  const result = await execFileText(codexPath, ['exec', '--skip-git-repo-check', '--ephemeral', '--json', prompt], {
    cwd: paths.codexHome,
    timeout: options.timeout || 180000,
    maxBuffer: 20 * 1024 * 1024
  })
  let processState = { notepad: false, calculator: false }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          [
            "$notepad = [bool](Get-Process -Name 'notepad' -ErrorAction SilentlyContinue)",
            "$calculator = [bool](Get-Process -Name 'CalculatorApp','Calculator' -ErrorAction SilentlyContinue)",
            '[pscustomobject]@{ notepad = $notepad; calculator = $calculator } | ConvertTo-Json -Compress'
          ].join('\n')
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }
      )

      processState = JSON.parse(output.trim())
    } catch {
      // Codex JSON output still records whether the model used the shell tool.
    }
  }

  const outputText = String(result.stdout || '')
  const usedTool = /command_execution|shell_command|LOCAL_WINDOWS_TOOLS_OK|notepad\.exe|calc\.exe/i.test(outputText)

  return {
    completedAt: new Date().toISOString(),
    ok: usedTool && (processState.notepad || processState.calculator),
    usedTool,
    notepadOpened: Boolean(processState.notepad),
    calculatorOpened: Boolean(processState.calculator),
    codexExitCode: 0,
    outputTail: outputText.slice(-4000),
    stderrTail: String(result.stderr || '').slice(-1000)
  }
}

module.exports = {
  activateRelay,
  applyRelay,
  exportAgent,
  exportProject,
  exportSession,
  exportSkill,
  findCodexTargets,
  getRelayApiKey,
  getRelayRuntime,
  getPaths,
  importAgentFromGithub,
  importAgentZip,
  importSkillFromGithub,
  importSkillZip,
  initializeLocalToolRuntime,
  inspectCodexDiskUsage,
  inspectLocalToolRuntime,
  maintainCodexDisk,
  migrateManagedProviderAuth,
  repairLocalToolRuntime,
  repairCodexConversationIndex,
  readStatus,
  refreshManagedProviderProxyBaseUrl,
  removeRelay,
  deleteConversationData,
  deleteProject,
  deleteSession,
  importSession,
  addProject,
  restoreDefaultProvider,
  restoreInitialBackup,
  refreshNewApiChannel,
  saveRelay,
  selectNewApiKey,
  syncNewApi,
  testSavedRelay,
  testAndSaveRelay,
  testRelay,
  restartCodex,
  verifyLocalAgentExecution,
  _internal: {
    appVersion: APP_VERSION,
    configProvidersFromParsed,
    envKeyForProvider,
    findCodexCli,
    findCodexQuickInstallationEvidence,
    findCodexQuickTargets,
    loginFreshClientWithApiKey,
    reconcileAuthForCustomProvider,
    buildModelAliasAssignments,
    modelAdapterProfile,
    modelDisplayName,
    modelReasoningProfile,
    modelWireApiMap,
    normalizeRelayInput,
    parseConfig,
    codexTargetRank,
    captureBundledModelCatalog,
    ensureProjectsFromSessions,
    syncDesktopProjects,
    normalizeSessionForDesktop,
    preferredCodexTarget,
    repairGeneratedCodexFiles,
    readResponseTextLimited,
    runCodexAppServerRequest,
    runCodexAppServerBatchRequests,
    removeRootKey,
    removeTableBlock,
    setRootKey,
    writeApiKeyAuth,
    writeChannelModelCatalog
  }
}
