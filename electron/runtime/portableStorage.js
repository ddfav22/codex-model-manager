const fs = require('fs')
const os = require('os')
const path = require('path')

const PORTABLE_DATA_DIRNAME = 'data'
const STORAGE_MIGRATION_VERSION = 1
const COMPLETE_RELEASE_PATTERN = /^ChatGPT-Model-Manager-(\d+)\.(\d+)\.(\d+)-complete$/i
const PERSISTENT_ELECTRON_ENTRIES = [
  'Cookies',
  'IndexedDB',
  'Local State',
  'Local Storage',
  'Network',
  'Preferences',
  'Session Storage',
  'SharedStorage',
  'databases'
]

function legacyDataMigrationEnabled(env = process.env) {
  return env.CODEX_MM_ENABLE_LEGACY_DATA_MIGRATION === '1' && env.CODEX_MM_DISABLE_LEGACY_DATA_MIGRATION !== '1'
}

function isPathInsideRoot(rootPath, candidatePath) {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)

  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function resolveClientRoot({ isPackaged, executablePath = process.execPath, sourceRoot }) {
  if (isPackaged) return path.dirname(path.resolve(executablePath))
  if (!sourceRoot) throw new Error('Development portable storage requires sourceRoot')

  return path.resolve(sourceRoot)
}

function portableStoragePaths(options) {
  const clientRoot = resolveClientRoot(options)
  const dataRoot = path.join(clientRoot, PORTABLE_DATA_DIRNAME)

  return {
    clientRoot,
    dataRoot,
    managerState: path.join(dataRoot, 'manager'),
    electronUserData: path.join(dataRoot, 'electron'),
    sessionData: path.join(dataRoot, 'electron', 'session'),
    crashDumps: path.join(dataRoot, 'crash-dumps'),
    logs: path.join(dataRoot, 'logs'),
    electronLogs: path.join(dataRoot, 'logs', 'electron'),
    diagnostics: path.join(dataRoot, 'diagnostics'),
    runtime: path.join(dataRoot, 'runtime'),
    updates: path.join(dataRoot, 'updates'),
    migrationMarker: path.join(dataRoot, 'runtime', 'storage-migration.json')
  }
}

function ensurePortableDirectories(paths, fsModule = fs) {
  const directories = [
    paths.dataRoot,
    paths.managerState,
    paths.electronUserData,
    paths.sessionData,
    paths.crashDumps,
    paths.logs,
    paths.electronLogs,
    paths.diagnostics,
    paths.runtime,
    paths.updates
  ]

  for (const directoryPath of directories) {
    if (!isPathInsideRoot(paths.dataRoot, directoryPath)) {
      throw new Error(`Portable data path escaped the client data directory: ${directoryPath}`)
    }

    fsModule.mkdirSync(directoryPath, { recursive: true })
  }
}

function configurePortableStorage({ app, fsModule = fs, ...options }) {
  if (!app || typeof app.getPath !== 'function' || typeof app.setPath !== 'function') {
    throw new Error('Electron app path API is unavailable')
  }

  const legacyElectronUserData = app.getPath('userData')
  const paths = portableStoragePaths(options)

  ensurePortableDirectories(paths, fsModule)
  app.setPath('userData', paths.electronUserData)
  app.setPath('sessionData', paths.sessionData)
  app.setPath('crashDumps', paths.crashDumps)
  if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(paths.electronLogs)

  return { ...paths, legacyElectronUserData }
}

function parseCompleteReleaseVersion(directoryName) {
  const match = String(directoryName || '').match(COMPLETE_RELEASE_PATTERN)

  return match ? match.slice(1).map(value => Number(value)) : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }

  return 0
}

function previousPortableDataRoots(paths, fsModule = fs) {
  const parent = path.dirname(paths.clientRoot)
  const currentVersion = parseCompleteReleaseVersion(path.basename(paths.clientRoot))
  let entries = []

  try {
    entries = fsModule.readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      entry,
      version: parseCompleteReleaseVersion(entry.name)
    }))
    .filter(item => item.version)
    .filter(item => !currentVersion || compareVersions(item.version, currentVersion) < 0)
    .map(item => ({
      ...item,
      clientRoot: path.join(parent, item.entry.name)
    }))
    .filter(item => path.resolve(item.clientRoot) !== path.resolve(paths.clientRoot))
    .filter(item => fsModule.existsSync(path.join(item.clientRoot, PORTABLE_DATA_DIRNAME)))
    .sort((left, right) => compareVersions(right.version, left.version))
    .map(item => path.join(item.clientRoot, PORTABLE_DATA_DIRNAME))
}

function uniquePaths(values) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    if (!value) continue
    const resolved = path.resolve(value)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved

    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }

  return result
}

function migrationMappings(paths, options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const appDataDir = options.appDataDir || process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
  const localAppDataDir = options.localAppDataDir || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
  const legacyUserDataRoots = uniquePaths([
    options.legacyElectronUserData,
    path.join(appDataDir, 'chatgpt-model-manager'),
    path.join(appDataDir, 'ChatGPT Model Manager'),
    path.join(appDataDir, 'Codex Model Manager'),
    path.join(appDataDir, 'codex-model-manager')
  ])
  const mappings = []

  for (const source of previousPortableDataRoots(paths, options.fsModule || fs)) {
    mappings.push(
      {
        kind: 'previous-portable-manager-state',
        source: path.join(source, 'manager'),
        target: paths.managerState
      },
      {
        kind: 'previous-portable-logs',
        source: path.join(source, 'logs'),
        target: paths.logs
      }
    )

    for (const entry of PERSISTENT_ELECTRON_ENTRIES) {
      mappings.push({
        kind: 'previous-portable-electron-data',
        source: path.join(source, 'electron', entry),
        target: path.join(paths.electronUserData, entry)
      })
    }
  }

  mappings.push({
    kind: 'legacy-manager-state',
    source: path.join(homeDir, '.codex', 'codex-model-manager'),
    target: paths.managerState
  })

  for (const source of legacyUserDataRoots) {
    for (const entry of PERSISTENT_ELECTRON_ENTRIES) {
      mappings.push({
        kind: 'legacy-electron-data',
        source: path.join(source, entry),
        target: path.join(paths.electronUserData, entry)
      })
    }
  }

  mappings.push({
    kind: 'legacy-runtime-logs',
    source: path.join(localAppDataDir, 'ChatGPT Model Manager', 'logs'),
    target: paths.logs
  })

  return mappings
}

function copyMissingTree(sourceRoot, targetRoot, options = {}) {
  const fsModule = options.fsModule || fs
  const report = { filesCopied: 0, bytesCopied: 0, skippedLinks: 0, errors: [] }

  function visit(source, target) {
    let stat

    try {
      stat = fsModule.lstatSync(source)
    } catch (error) {
      report.errors.push({ code: String(error?.code || error?.name || 'stat-failed') })
      return
    }

    if (stat.isSymbolicLink()) {
      report.skippedLinks += 1
      return
    }

    if (stat.isDirectory()) {
      try {
        fsModule.mkdirSync(target, { recursive: true })
        for (const entry of fsModule.readdirSync(source)) {
          visit(path.join(source, entry), path.join(target, entry))
        }
      } catch (error) {
        report.errors.push({ code: String(error?.code || error?.name || 'directory-copy-failed') })
      }

      return
    }

    if (!stat.isFile() || fsModule.existsSync(target)) return

    try {
      fsModule.mkdirSync(path.dirname(target), { recursive: true })
      fsModule.copyFileSync(source, target, fsModule.constants.COPYFILE_EXCL)
      report.filesCopied += 1
      report.bytesCopied += stat.size
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        report.errors.push({ code: String(error?.code || error?.name || 'file-copy-failed') })
      }
    }
  }

  visit(sourceRoot, targetRoot)

  return report
}

function readMigrationMarker(markerPath, fsModule = fs) {
  try {
    return JSON.parse(fsModule.readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

function migratePortableData(paths, options = {}) {
  const fsModule = options.fsModule || fs
  const existing = readMigrationMarker(paths.migrationMarker, fsModule)

  if (existing?.version === STORAGE_MIGRATION_VERSION) {
    return {
      migrated: false,
      reason: 'already-migrated',
      filesCopied: 0,
      bytesCopied: 0,
      skippedLinks: 0,
      errors: []
    }
  }

  if (options.disabled === true) {
    return {
      migrated: false,
      reason: 'disabled',
      filesCopied: 0,
      bytesCopied: 0,
      skippedLinks: 0,
      errors: []
    }
  }

  const report = {
    migrated: true,
    reason: 'migration-complete',
    filesCopied: 0,
    bytesCopied: 0,
    skippedLinks: 0,
    sourcesUsed: [],
    errors: []
  }

  for (const mapping of migrationMappings(paths, { ...options, fsModule })) {
    if (!fsModule.existsSync(mapping.source)) continue
    if (!isPathInsideRoot(paths.dataRoot, mapping.target)) {
      report.errors.push({ kind: mapping.kind, code: 'target-outside-portable-data' })
      continue
    }

    const copied = copyMissingTree(mapping.source, mapping.target, { fsModule })

    report.filesCopied += copied.filesCopied
    report.bytesCopied += copied.bytesCopied
    report.skippedLinks += copied.skippedLinks
    if (copied.filesCopied > 0 && !report.sourcesUsed.includes(mapping.kind)) {
      report.sourcesUsed.push(mapping.kind)
    }
    report.errors.push(...copied.errors.map(error => ({ kind: mapping.kind, ...error })))
  }

  if (report.errors.length) {
    report.reason = 'migration-incomplete'
    return report
  }

  try {
    fsModule.mkdirSync(path.dirname(paths.migrationMarker), { recursive: true })
    fsModule.writeFileSync(
      paths.migrationMarker,
      `${JSON.stringify({
        version: STORAGE_MIGRATION_VERSION,
        migratedAt: new Date().toISOString(),
        filesCopied: report.filesCopied,
        bytesCopied: report.bytesCopied
      })}\n`,
      'utf8'
    )
  } catch (error) {
    report.reason = 'migration-incomplete'
    report.errors.push({
      kind: 'migration-marker',
      code: String(error?.code || error?.name || 'marker-write-failed')
    })
  }

  return report
}

module.exports = {
  PORTABLE_DATA_DIRNAME,
  STORAGE_MIGRATION_VERSION,
  compareVersions,
  configurePortableStorage,
  copyMissingTree,
  ensurePortableDirectories,
  isPathInsideRoot,
  legacyDataMigrationEnabled,
  migratePortableData,
  migrationMappings,
  parseCompleteReleaseVersion,
  portableStoragePaths,
  previousPortableDataRoots,
  readMigrationMarker,
  resolveClientRoot
}
