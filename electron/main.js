const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, dialog, shell, Menu, Tray } = require('electron')
const packageMetadata = require('../package.json')
const {
  configurePortableStorage,
  legacyDataMigrationEnabled,
  migratePortableData
} = require('./runtime/portableStorage')

const portableStorage = configurePortableStorage({
  app,
  isPackaged: app.isPackaged,
  executablePath: process.execPath,
  sourceRoot: path.join(__dirname, '..')
})

process.env.CODEX_MANAGER_STATE_DIR = portableStorage.managerState

const { configureRuntimeLogger, getRuntimeLogPath, logError, logEvent } = require('./runtimeLogger')
const { createAppUpdater, repositoryFromPackageMetadata } = require('./features/appUpdater')
const { toUserFacingErrorMessage } = require('./features/userFacingErrors')
const manager = require('./codexManager')
const { createProtocolProxy } = require('./protocolProxy')
const { registerIpcHandlers } = require('./runtime/ipcHandlers')
const { rememberManagerExecutableAfterScan, stopLegacyManagerInstances } = require('./runtime/legacyInstanceGuard')
const { startStaticUiServer } = require('./runtime/staticUiServer')
const { createWindowCloseHandler } = require('./runtime/windowClose')
const { configureWindowSecurity } = require('./runtime/windowSecurity')

let mainWindow
let staticServer
let protocolProxy
let tray
let isQuitting = false
let runtimeDiagnostic = {}
let runtimeReadyPromise = Promise.resolve(null)
const processStartedAt = Date.now()
const runtimeLogPath = configureRuntimeLogger({
  roots: [portableStorage.logs]
})
const updateRepository = process.env.CODEX_MM_UPDATE_REPOSITORY || repositoryFromPackageMetadata(packageMetadata)
const appUpdater = createAppUpdater({
  currentVersion: app.getVersion(),
  currentExecutablePath: process.execPath,
  repository: updateRepository,
  updatesRoot: portableStorage.updates,
  enabled: app.isPackaged && process.env.CODEX_MM_DISABLE_UPDATE_CHECK !== '1',
  logEvent,
  logError,
  onState: state => {
    if (!mainWindow || mainWindow.isDestroyed()) return

    mainWindow.webContents.send('codex:updateState', state)
  },
  onBeforeInstall: () => {
    isQuitting = true
    setImmediate(() => app.quit())
  }
})

logEvent('info', 'process.start', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  executable: process.execPath,
  dataRoot: portableStorage.dataRoot,
  logPath: runtimeLogPath
})

process.on('uncaughtException', error => {
  logError('process.uncaughtException', error)

  try {
    dialog.showErrorBox(
      '程序运行错误',
      `${toUserFacingErrorMessage(error)}\n\n详细信息已记录在程序文件夹的 data\\logs 中。`
    )
  } finally {
    app.exit(1)
  }
})

process.on('unhandledRejection', reason => {
  logError('process.unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})

function runtimeDiagnosticPath() {
  return path.join(portableStorage.diagnostics, 'runtime.json')
}

function toolVerificationPath() {
  return path.join(portableStorage.diagnostics, 'tool-verification.json')
}

function diagnosticSnapshot() {
  try {
    const paths = manager.getPaths()
    const configText = fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath, 'utf8') : ''
    const parsed = configText ? manager._internal.parseConfig(configText) : {}
    const catalogPath = parsed.model_catalog_json || paths.modelsCachePath
    const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : {}
    const selectedModel = String(parsed.model || '')
    const catalogModel = Array.isArray(catalog.models)
      ? catalog.models.find(item => String(item?.slug || '').toLowerCase() === selectedModel.toLowerCase())
      : null
    const status = manager.readStatus()

    return {
      capturedAt: new Date().toISOString(),
      managerVersion: app.getVersion(),
      runtimeLogPath: getRuntimeLogPath(),
      currentProvider: status.currentProvider,
      currentModel: status.currentModel,
      shellToolEnabled: parsed?.features?.shell_tool !== false,
      sandboxMode: parsed.sandbox_mode || 'default',
      approvalPolicy: parsed.approval_policy || 'default',
      sessionCount: Array.isArray(status.sessions) ? status.sessions.length : 0,
      projectCount: Array.isArray(status.projects) ? status.projects.length : 0,
      channels: (Array.isArray(status.providers) ? status.providers : []).map(provider => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        models: provider.models,
        active: provider.active,
        managed: provider.managed,
        testStatus: provider.testStatus
          ? {
              ok: provider.testStatus.ok,
              chatOk: provider.testStatus.chatOk,
              streamOk: provider.testStatus.streamOk,
              agentToolOk: provider.testStatus.agentToolOk,
              actualModel: provider.testStatus.actualModel,
              agentToolMessage: provider.testStatus.agentToolMessage
            }
          : null
      })),
      selectedModelCapabilities: catalogModel
        ? {
            slug: catalogModel.slug,
            shellType: catalogModel.shell_type,
            toolMode: catalogModel.tool_mode,
            applyPatchToolType: catalogModel.apply_patch_tool_type,
            supportsParallelToolCalls: catalogModel.supports_parallel_tool_calls,
            baseInstructionsLength: String(catalogModel.base_instructions || '').length,
            instructionsTemplateLength: String(catalogModel.model_messages?.instructions_template || '').length
          }
        : null
    }
  } catch (error) {
    return {
      capturedAt: new Date().toISOString(),
      managerVersion: app.getVersion(),
      snapshotError: error instanceof Error ? error.message : String(error)
    }
  }
}

function writeRuntimeDiagnostic(patch = {}, options = {}) {
  const snapshot =
    options.lightweight === true
      ? {
          capturedAt: new Date().toISOString(),
          managerVersion: app.getVersion(),
          runtimeLogPath: getRuntimeLogPath()
        }
      : diagnosticSnapshot()

  runtimeDiagnostic = { ...runtimeDiagnostic, ...snapshot, ...patch }

  try {
    fs.writeFileSync(runtimeDiagnosticPath(), `${JSON.stringify(runtimeDiagnostic, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics must never block the manager or model proxy.
  }

  logEvent('info', 'runtime.diagnostic', { keys: Object.keys(patch) })
}

function ensureTray(trigger) {
  if (tray || isQuitting) return

  setImmediate(() => {
    if (tray || isQuitting) return

    const trayStartedAt = Date.now()

    try {
      createTray()
      logEvent('info', 'tray.ready', { durationMs: Date.now() - trayStartedAt, trigger })
    } catch (error) {
      logError('tray.failed', error)
    }
  })
}

async function createWindow() {
  const windowStartedAt = Date.now()
  let targetUrl = process.env.NEXT_DEV_SERVER_URL
  let staticUiServerMs = 0

  if (!targetUrl) {
    const staticUiStartedAt = Date.now()
    const staticUi = await startStaticUiServer({ outDir: path.join(__dirname, '..', 'out') })

    staticServer = staticUi.server
    targetUrl = staticUi.url
    staticUiServerMs = Date.now() - staticUiStartedAt
    console.log(`ChatGPT Model Manager is serving UI on ${targetUrl}`)
  }

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    title: 'ChatGPT Model Manager',
    icon: path.join(__dirname, 'assets', 'app-icon.ico'),
    backgroundColor: '#f7f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  configureWindowSecurity(mainWindow, targetUrl)

  const readyToShow = new Promise(resolve => mainWindow.once('ready-to-show', resolve))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.on('query-session-end', () => {
    isQuitting = true
  })
  mainWindow.on(
    'close',
    createWindowCloseHandler({
      dialog,
      getWindow: () => mainWindow,
      isQuitting: () => isQuitting,
      onMinimize: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return

        mainWindow.minimize()
        ensureTray('window-close-minimize')
      },
      onQuit: () => {
        isQuitting = true
        app.quit()
      },
      logEvent,
      logError
    })
  )

  const loadUrlStartedAt = Date.now()

  await mainWindow.loadURL(targetUrl)
  const loadUrlMs = Date.now() - loadUrlStartedAt
  const readyToShowWaitStartedAt = Date.now()

  await readyToShow
  logEvent('info', 'window.readyToShow', {
    durationMs: Date.now() - processStartedAt,
    windowDurationMs: Date.now() - windowStartedAt,
    staticUiServerMs,
    loadUrlMs,
    readyToShowWaitMs: Date.now() - readyToShowWaitStartedAt
  })
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function openRuntimeLog() {
  const logPath = getRuntimeLogPath()

  if (logPath && fs.existsSync(logPath)) {
    shell.showItemInFolder(logPath)
    return
  }

  if (logPath) shell.openPath(path.dirname(logPath))
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'app.ico'))
  tray.setToolTip('ChatGPT Model Manager')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开管理器', click: showMainWindow },
      { label: '打开运行日志', click: openRuntimeLog },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showMainWindow)
}

function registerIpc() {
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getRuntimeReadyPromise: () => runtimeReadyPromise,
    logError,
    logEvent,
    manager,
    updater: appUpdater,
    writeRuntimeDiagnostic
  })
}

async function initializeProtocolRuntime() {
  const runtimeStartedAt = Date.now()
  const authMigrationStartedAt = Date.now()
  const authMigration = manager.migrateManagedProviderAuth()

  writeRuntimeDiagnostic({ authMigration }, { lightweight: true })
  logEvent('info', 'auth.migration.complete', {
    action: authMigration?.action || '',
    durationMs: Date.now() - authMigrationStartedAt
  })
  const proxyStartedAt = Date.now()

  protocolProxy = await createProtocolProxy({
    port: 0,
    resolveChannel: id => manager.getRelayRuntime(id),
    onDiagnostic: diagnostic => {
      writeRuntimeDiagnostic({ lastProxyRequest: diagnostic }, { lightweight: true })
      logEvent('info', 'proxy.request', diagnostic)
    }
  })
  process.env.CODEX_MM_PROXY_BASE_URL = protocolProxy.baseUrl
  logEvent('info', 'proxy.started', {
    baseUrl: protocolProxy.publicBaseUrl,
    port: protocolProxy.port,
    reused: protocolProxy.reused === true,
    durationMs: Date.now() - proxyStartedAt
  })
  let proxyConfigMigration = null
  const configRefreshStartedAt = Date.now()

  try {
    proxyConfigMigration = manager.refreshManagedProviderProxyBaseUrl({ proxyBaseUrl: protocolProxy.baseUrl })
  } catch (error) {
    proxyConfigMigration = { updated: false, error: error instanceof Error ? error.message : String(error) }
  }

  writeRuntimeDiagnostic(
    {
      startedAt: new Date().toISOString(),
      protocolProxy: {
        baseUrl: protocolProxy.publicBaseUrl,
        port: protocolProxy.port,
        reused: protocolProxy.reused === true
      },
      proxyConfigMigration,
      lastProxyRequest: protocolProxy.lastDiagnostic || null
    },
    { lightweight: true }
  )
  logEvent('info', 'provider.runtimeConfig.complete', {
    updated: proxyConfigMigration?.updated === true,
    reason: proxyConfigMigration?.reason || '',
    providerId: proxyConfigMigration?.providerId || '',
    durationMs: Date.now() - configRefreshStartedAt
  })

  return {
    authMigration,
    proxyConfigMigration,
    durationMs: Date.now() - runtimeStartedAt
  }
}

const legacyInstanceMarkerPath = path.join(portableStorage.runtime, 'manager-executable.json')
const legacyInstanceScan = stopLegacyManagerInstances({
  executablePath: process.execPath,
  processId: process.pid,
  markerPath: legacyInstanceMarkerPath
})

logEvent('info', 'legacyInstances.checked', legacyInstanceScan)
const lock = app.requestSingleInstanceLock()

if (!lock) {
  const lockConflictScan =
    legacyInstanceScan.scan === false
      ? stopLegacyManagerInstances({
          executablePath: process.execPath,
          processId: process.pid,
          markerPath: legacyInstanceMarkerPath,
          force: true
        })
      : null

  if (lockConflictScan) logEvent('info', 'legacyInstances.lockConflict', lockConflictScan)
  if (lockConflictScan?.ok && lockConflictScan.stoppedCount > 0) {
    logEvent('info', 'legacyInstances.relaunch', { stoppedCount: lockConflictScan.stoppedCount })
    app.relaunch()
    app.exit(0)
  } else {
    app.quit()
  }
} else {
  const storageMigration = migratePortableData(portableStorage, {
    legacyElectronUserData: portableStorage.legacyElectronUserData,
    disabled: !legacyDataMigrationEnabled(process.env)
  })

  logEvent(storageMigration.errors.length ? 'error' : 'info', 'storage.migration', storageMigration)
  const executableMarker = rememberManagerExecutableAfterScan({
    scanResult: legacyInstanceScan,
    executablePath: process.execPath,
    markerPath: legacyInstanceMarkerPath
  })

  logEvent('info', 'legacyInstances.marker', executableMarker)
  app.on('second-instance', () => {
    showMainWindow()
  })

  app
    .whenReady()
    .then(async () => {
      logEvent('info', 'app.ready', { durationMs: Date.now() - processStartedAt })
      app.setAppUserModelId('cn.chatgpt.manager')
      registerIpc()
      runtimeReadyPromise = initializeProtocolRuntime()
      const [, runtime] = await Promise.all([createWindow(), runtimeReadyPromise])

      logEvent('info', 'app.startup.complete', {
        durationMs: Date.now() - processStartedAt,
        runtimeDurationMs: runtime.durationMs,
        automaticCodexLaunch: false,
        automaticHistoryRepair: false,
        automaticLocalRuntimeInspection: false,
        automaticReleaseDeletion: false,
        pendingToolVerificationDeferred: fs.existsSync(toolVerificationPath()),
        portableDataRoot: portableStorage.dataRoot,
        storageMigration: {
          reason: storageMigration.reason,
          filesCopied: storageMigration.filesCopied,
          bytesCopied: storageMigration.bytesCopied,
          errors: storageMigration.errors.length
        },
        legacyInstanceScan: {
          scanned: legacyInstanceScan.scan,
          reason: legacyInstanceScan.reason,
          ok: legacyInstanceScan.ok,
          durationMs: legacyInstanceScan.durationMs
        },
        closePromptEnabled: true,
        closeMinimizeTarget: 'taskbar',
        trayInitializationDeferredUntilWindowClose: true
      })
      if (appUpdater.enabled) {
        setTimeout(() => {
          appUpdater.check({ manual: false, autoDownload: true })
        }, 1500)
      }
    })
    .catch(error => {
      logError('app.startup.failed', error)
      throw error
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'win32') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  logEvent('info', 'process.willQuit')
  if (staticServer) staticServer.close()
  if (protocolProxy?.server) protocolProxy.server.close()
})
