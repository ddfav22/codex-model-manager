const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const asar = require('@electron/asar')
const packageMetadata = require('../package.json')

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function copyCleanProgramTree(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true })

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === 'data') continue
    const sourcePath = path.join(sourceRoot, entry.name)
    const targetPath = path.join(targetRoot, entry.name)

    if (entry.isDirectory()) copyCleanProgramTree(sourcePath, targetPath)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
  }
}

function processIdsByName(names) {
  const script = [
    `$names = @(${names.map(name => `'${name.replace(/'/g, "''")}'`).join(',')})`,
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $names -icontains $_.Name } |',
    '  Select-Object -ExpandProperty ProcessId'
  ].join('\n')

  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    })
      .split(/\r?\n/)
      .map(value => Number(value.trim()))
      .filter(value => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

function managerProcessIds(executablePath) {
  const script = [
    '$target = $env:CODEX_MM_TEST_EXE',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    "  Where-Object { $_.Name -eq 'ChatGPT Model Manager.exe' -and $_.ExecutablePath -eq $target } |",
    '  Select-Object -ExpandProperty ProcessId'
  ].join('\n')

  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CODEX_MM_TEST_EXE: executablePath }
    })
      .split(/\r?\n/)
      .map(value => Number(value.trim()))
      .filter(value => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

async function stopManagerProcesses(executablePath) {
  let stableEmptyChecks = 0

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const processIds = managerProcessIds(executablePath)

    if (!processIds.length) {
      stableEmptyChecks += 1
      if (stableEmptyChecks >= 3) return

      await sleep(500)
      continue
    }

    stableEmptyChecks = 0

    for (const processId of processIds) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        // Retry after the process tree settles.
      }
    }

    await sleep(750)
  }
}

async function waitForApplicationPage(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const pages = await response.json()
      const page = pages.find(
        item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(String(item.url || ''))
      )

      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // The debug endpoint is not ready yet.
    }

    await sleep(200)
  }

  throw new Error('最终打包页面没有从 about:blank 导航到本地应用地址')
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  const exceptions = []
  const consoleErrors = []
  let nextId = 0

  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))

    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails || {}

      exceptions.push(details.exception?.description || details.text || 'unknown renderer exception')
    }

    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params?.type)) {
      consoleErrors.push(
        (message.params.args || []).map(argument => argument.value || argument.description || '').join(' ')
      )
    }

    if (!message.id) return
    const waiter = pending.get(message.id)

    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }

  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('无法连接最终打包页面调试端口'))
  })
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId

      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = expression =>
    command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }).then(result => result.result.value)

  return { socket, ready, command, evaluate, exceptions, consoleErrors }
}

function readNewLogEvents(logPath, existingLineCount) {
  if (!fs.existsSync(logPath)) return []

  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(existingLineCount)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function inspectPackagedContents(executablePath) {
  const archivePath = path.join(path.dirname(executablePath), 'resources', 'app.asar')
  const sourceIconBundlePath = path.join(__dirname, '..', 'src', 'assets', 'iconify-icons', 'generated-icons.css')
  const archiveEntries = asar.listPackage(archivePath)
  const normalizedEntries = archiveEntries.map(entry => entry.replace(/\\/g, '/'))
  const forbiddenDevelopmentFiles = normalizedEntries.filter(entry =>
    /^\/electron\/(?:build-next|test-[^/]+)\.js$/i.test(entry)
  )
  const remixIcons = new Set()
  const expectedRemixIcons = new Set(
    [...fs.readFileSync(sourceIconBundlePath, 'utf8').matchAll(/\bri-([a-z0-9-]+)\b/g)].map(match => match[1])
  )

  archiveEntries
    .filter(entry => /[\\/]out[\\/]_next[\\/]static[\\/]css[\\/].+\.css$/i.test(entry))
    .forEach(entry => {
      const cssContent = asar.extractFile(archivePath, entry.replace(/^[\\/]/, '')).toString('utf8')

      for (const match of cssContent.matchAll(/\bri-([a-z0-9-]+)\b/g)) remixIcons.add(match[1])
    })

  return {
    archiveBytes: fs.statSync(archivePath).size,
    entryCount: archiveEntries.length,
    forbiddenDevelopmentFiles,
    remixIconCount: remixIcons.size,
    expectedRemixIconCount: expectedRemixIcons.size
  }
}

async function main() {
  const sourceExecutablePath = path.resolve(
    process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'ChatGPT Model Manager.exe')
  )
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-packaged-ui-'))
  const isolatedProgramRoot = path.join(isolatedRoot, 'program')
  const isolatedCodexHome = path.join(isolatedRoot, 'codex-home')
  const executablePath = path.join(isolatedProgramRoot, path.basename(sourceExecutablePath))
  const port = Number(process.env.CODEX_MM_UI_TEST_PORT || 9340)
  const dataRoot = path.join(path.dirname(executablePath), 'data')
  const logPath = path.join(dataRoot, 'logs', 'manager.log')
  const deletionProjectPath = path.join(isolatedRoot, 'delete-project')
  const deletionSessionPath = path.join(
    isolatedCodexHome,
    'sessions',
    '2026',
    '07',
    '31',
    'packaged-delete-session.jsonl'
  )
  const packagedSkillPath = path.join(isolatedRoot, '.agents', 'skills', 'packaged-skill')
  const packagedAgentPath = path.join(isolatedCodexHome, 'agents', 'packaged-agent.toml')

  if (!fs.existsSync(sourceExecutablePath)) throw new Error(`最终打包程序不存在：${sourceExecutablePath}`)
  copyCleanProgramTree(path.dirname(sourceExecutablePath), isolatedProgramRoot)
  fs.mkdirSync(isolatedCodexHome, { recursive: true })
  fs.mkdirSync(path.dirname(deletionSessionPath), { recursive: true })
  fs.mkdirSync(deletionProjectPath, { recursive: true })
  fs.mkdirSync(packagedSkillPath, { recursive: true })
  fs.mkdirSync(path.dirname(packagedAgentPath), { recursive: true })
  fs.writeFileSync(path.join(deletionProjectPath, 'delete-me.txt'), 'isolated deletion smoke test', 'utf8')
  fs.writeFileSync(
    path.join(isolatedCodexHome, 'config.toml'),
    `[projects.'${deletionProjectPath.toLowerCase().replace(/'/g, "''")}']\ntrust_level = "trusted"\n`,
    'utf8'
  )
  fs.writeFileSync(
    deletionSessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'packaged-delete-session',
        thread_name: 'Packaged delete session',
        cwd: deletionProjectPath
      }
    })}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(packagedSkillPath, 'SKILL.md'),
    ['---', 'name: packaged-skill', 'description: Packaged skill discovery test.', '---', '', 'Test.'].join('\n'),
    'utf8'
  )
  fs.writeFileSync(
    packagedAgentPath,
    [
      'name = "packaged-agent"',
      'description = "Packaged agent discovery test."',
      'developer_instructions = "Return a concise test result."'
    ].join('\n'),
    'utf8'
  )
  const packagedContents = inspectPackagedContents(executablePath)

  await stopManagerProcesses(executablePath)
  await sleep(3000)
  if (managerProcessIds(executablePath).length) throw new Error('测试前仍有管理器进程占用最终 Release')

  const existingLogLineCount = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0
  const clientProcessIdsBefore = processIdsByName(['ChatGPT.exe', 'Codex.exe'])
  const child = spawn(executablePath, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executablePath),
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: isolatedCodexHome,
      CODEX_MM_DISABLE_UPDATE_CHECK: '1',
      CODEX_MM_DISABLE_LEGACY_DATA_MIGRATION: '1',
      CODEX_MM_USER_SKILLS_DIR: path.join(isolatedRoot, '.agents', 'skills'),
      CODEX_MM_LEGACY_SKILLS_DIR: path.join(isolatedCodexHome, 'skills'),
      CODEX_MM_AGENTS_DIR: path.join(isolatedCodexHome, 'agents')
    },
    stdio: 'ignore'
  })

  try {
    const page = await waitForApplicationPage(port)
    const cdp = connectCdp(page.webSocketDebuggerUrl)

    await cdp.ready
    await cdp.command('Runtime.enable')

    let pageText = ''
    let uiReadyMs = 0
    const uiStartedAt = Date.now()
    const expectedVersionLabel = `渠道管理 · v${packageMetadata.version}`

    for (let attempt = 0; attempt < 150; attempt += 1) {
      pageText = await cdp.evaluate('document.body?.textContent || ""')
      const versionVisible = pageText.includes(expectedVersionLabel)
      const installedVisible = pageText.includes('Codex 客户端已安装')
      const missingVisibleAndStable = pageText.includes('未发现 Codex 客户端') && Date.now() - uiStartedAt >= 2000

      if (versionVisible && (installedVisible || missingVisibleAndStable)) {
        uiReadyMs = Date.now() - uiStartedAt
        break
      }
      await sleep(100)
    }

    const quick = await cdp.evaluate(`(async () => {
      const status = await window.codexManager.getStatus(false)
      return {
        installed: status.diagnostics.codexInstalled,
        detection: status.diagnostics.codexDetection,
        detectedPath: status.diagnostics.codexDetectedPath,
        targetCount: status.codexTargets.length,
        issues: status.diagnostics.issues
      }
    })()`)
    const full = await cdp.evaluate(`(async () => {
      const status = await window.codexManager.getStatus(true)
      return {
        installed: status.diagnostics.codexInstalled,
        detection: status.diagnostics.codexDetection,
        detectedPath: status.diagnostics.codexDetectedPath,
        targetCount: status.codexTargets.length,
        issues: status.diagnostics.issues
      }
    })()`)
    if ((quick.installed || full.installed) && !pageText.includes('Codex 客户端已安装')) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        pageText = await cdp.evaluate('document.body?.textContent || ""')
        if (pageText.includes('Codex 客户端已安装')) break
        await sleep(100)
      }
    }
    const packageManagement = await cdp.evaluate(`(async () => {
      const status = await window.codexManager.getStatus(false)
      return {
        skills: status.skills.map(item => ({
          name: item.name,
          source: item.source,
          valid: item.valid
        })),
        agents: status.agents.map(item => ({
          name: item.name,
          source: item.source,
          valid: item.valid
        }))
      }
    })()`)
    const visibleVersionLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map(element => String(element.textContent || '').trim())
      .filter(text => /^渠道管理 · v\\d+\\.\\d+\\.\\d+$/.test(text))`)
    const removedGrokOAuthSurface = await cdp.evaluate(`(() => {
      const bridge = window.codexManager
      const removedApiNames = [
        'getGrokOAuthState',
        'importGrokOAuthAccounts',
        'discardGrokOAuthBatch',
        'loginGrokOAuthBatch',
        'loginGrokOAuthAccount',
        'refreshGrokOAuthAccount',
        'onGrokOAuthStateChanged'
      ]
      const text = document.body?.textContent || ''
      let activationProgressSubscription = false

      if (typeof bridge?.onApplyRelayProgress === 'function') {
        const unsubscribe = bridge.onApplyRelayProgress(() => {})

        activationProgressSubscription = typeof unsubscribe === 'function'
        unsubscribe?.()
      }

      return {
        exposedApis: removedApiNames.filter(name => typeof bridge?.[name] === 'function'),
        menuFound: text.includes('其他渠道导入'),
        activationProgressSubscription
      }
    })()`)
    const updateSurface = await cdp.evaluate(`(async () => {
      const bridge = window.codexManager
      const state = await bridge.getUpdateState()
      const updateButton = Array.from(document.querySelectorAll('button')).find(element =>
        /在线更新|检查更新|重启更新/.test(String(element.textContent || '').trim())
      )
      const runtimeLogButton = Array.from(document.querySelectorAll('button')).find(
        element => String(element.textContent || '').trim() === '打开运行日志'
      )
      const runtimeDiagnostic = await bridge.getRuntimeDiagnosticSummary()
      const unsubscribeRuntimeDiagnostic = bridge.onRuntimeDiagnostic(() => {})
      const runtimeDiagnosticSubscription = typeof unsubscribeRuntimeDiagnostic === 'function'

      unsubscribeRuntimeDiagnostic?.()

      return {
        bridgeMethods: ['getUpdateState', 'checkForUpdates', 'installUpdate', 'onUpdateState'].map(name => ({
          name,
          type: typeof bridge?.[name]
        })),
        stage: state.stage,
        runtimeDiagnosticBridgeMethods: ['getRuntimeDiagnosticSummary', 'onRuntimeDiagnostic'].map(name => ({
          name,
          type: typeof bridge?.[name]
        })),
        runtimeDiagnostic,
        runtimeDiagnosticSubscription,
        buttonFound: Boolean(updateButton),
        buttonDisabled: Boolean(updateButton?.disabled),
        runtimeLogBridge: typeof bridge?.openRuntimeLog,
        runtimeLogButtonFound: Boolean(runtimeLogButton)
      }
    })()`)
    const onlineLoginDialog = await cdp.evaluate(`(async () => {
      const clickButton = label => {
        const button = Array.from(document.querySelectorAll('button')).find(
          element => String(element.textContent || '').trim() === label
        )
        button?.click()
        return Boolean(button)
      }
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const addOpened = clickButton('添加渠道')
      await wait(100)
      const newApiSelected = clickButton('从 NewAPI 添加')
      await wait(100)
      const dialog = document.querySelector('[role="dialog"]')
      const buttons = dialog
        ? Array.from(dialog.querySelectorAll('button')).map(element => String(element.textContent || '').trim())
        : []
      const newApiAddressValues = dialog
        ? Array.from(dialog.querySelectorAll('input')).map(element => String(element.value || '').trim())
        : []
      clickButton('取消')

      return {
        addOpened,
        newApiSelected,
        dialogFound: Boolean(dialog),
        loginAndSyncCount: buttons.filter(text => text === '登录并同步').length,
        completeCount: buttons.filter(text => text === '完成').length,
        defaultAddressFound: newApiAddressValues.includes('https://ainiubi.org'),
        buttons
      }
    })()`)
    const conversationTransferUi = await cdp.evaluate(`(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const buttonsByLabel = label =>
        Array.from(document.querySelectorAll('button')).filter(
          element => String(element.textContent || '').trim() === label
        )
      const clickControl = label => {
        const control = Array.from(document.querySelectorAll('button,[role="button"]')).find(
          element => String(element.textContent || '').trim() === label
        )
        control?.click()
        return Boolean(control)
      }
      const conversationOpened = clickControl('对话管理')

      await wait(100)
      const conversationTextBeforeReveal = String(document.body?.textContent || '')
      const pathButtons = buttonsByLabel('查看路径')
      const pathInitiallyHidden =
        !conversationTextBeforeReveal.includes(${JSON.stringify(deletionProjectPath)}) &&
        !conversationTextBeforeReveal.includes(${JSON.stringify(deletionSessionPath)})
      pathButtons[0]?.click()
      await wait(100)
      const pathRevealWorks = String(document.body?.textContent || '').includes(${JSON.stringify(deletionProjectPath)})
      buttonsByLabel('隐藏路径')[0]?.click()
      await wait(100)
      const readableTextFound = Array.from(document.querySelectorAll('p')).some(element => {
        const style = getComputedStyle(element)
        const fontSize = Number.parseFloat(style.fontSize || '0')
        const lineHeight = Number.parseFloat(style.lineHeight || '0')

        return fontSize >= 13.4 && lineHeight / fontSize >= 1.5
      })
      const topImportCount = buttonsByLabel('导入').length
      const topExportCount = buttonsByLabel('导出').length
      const legacyImportSessionCount = buttonsByLabel('导入对话').length
      const legacyImportProjectCount = buttonsByLabel('导入项目').length
      const importOpened = clickControl('导入')

      await wait(100)
      const importDialog = document.querySelector('[role="dialog"]')
      const importText = String(importDialog?.textContent || '')
      clickControl('取消')
      await wait(100)
      const exportOpened = clickControl('导出')

      await wait(100)
      const exportDialog = document.querySelector('[role="dialog"]')
      const exportText = String(exportDialog?.textContent || '')
      const exportOptions = exportDialog
        ? Array.from(exportDialog.querySelectorAll('[role="option"]')).map(element =>
            String(element.textContent || '').trim()
          )
        : []
      clickControl('取消')

      return {
        conversationOpened,
        pathControlCount: pathButtons.length,
        pathInitiallyHidden,
        pathRevealWorks,
        readableTextFound,
        topImportCount,
        topExportCount,
        legacyImportSessionCount,
        legacyImportProjectCount,
        importOpened,
        importDialogFound: Boolean(importDialog),
        importSessionChoice: importText.includes('导入会话文件（.jsonl）'),
        importProjectChoice: importText.includes('导入项目文件夹'),
        exportOpened,
        exportDialogFound: Boolean(exportDialog),
        exportSessionChoice: exportText.includes('会话'),
        exportProjectChoice: exportText.includes('项目'),
        exportSelectionFound: exportText.includes('选择会话') || exportText.includes('选择项目'),
        exportOptions,
        importBridge: typeof window.codexManager.importConversationData,
        exportBridge: typeof window.codexManager.exportConversationData,
        legacyImportSessionBridge: typeof window.codexManager.importSession,
        legacyAddProjectBridge: typeof window.codexManager.addProject
      }
    })()`)
    const rejectedConversationTransfer = await cdp.evaluate(`(async () => {
      const results = []

      for (const action of [
        () => window.codexManager.importConversationData('invalid'),
        () => window.codexManager.exportConversationData('session', '')
      ]) {
        try {
          await action()
          results.push({ rejected: false, message: '' })
        } catch (error) {
          results.push({ rejected: true, message: String(error?.message || error) })
        }
      }

      return results
    })()`)
    const deletionSmoke = await cdp.evaluate(`(async () => {
      const result = await window.codexManager.deleteConversationData({
        scope: 'active',
        projectPath: ${JSON.stringify(deletionProjectPath)}
      })

      return {
        deletedSessionCount: result.deletedSessionCount,
        skippedSessionCount: result.skippedSessionCount,
        deletedProjectCount: result.deletedProjectCount,
        skippedProjectCount: result.skippedProjectCount,
        configurationError: result.configurationError,
        indexDeleteOk: result.indexDelete?.ok,
        indexRefreshOk: result.indexRefresh?.ok
      }
    })()`)
    const rejectedDelete = await cdp.evaluate(`(async () => {
      try {
        await window.codexManager.deleteConversationData({ scope: 'invalid' })
        return { rejected: false, message: '' }
      } catch (error) {
        return { rejected: true, message: String(error?.message || error) }
      }
    })()`)
    cdp.socket.close()
    const clientProcessIdsAfter = processIdsByName(['ChatGPT.exe', 'Codex.exe'])
    const newClientProcessIds = clientProcessIdsAfter.filter(id => !clientProcessIdsBefore.includes(id))
    const logEvents = readNewLogEvents(logPath, existingLogLineCount)
    const processStart = logEvents.find(event => event.event === 'process.start')
    const startupComplete = logEvents.find(event => event.event === 'app.startup.complete')
    const startupErrors = logEvents.filter(event =>
      ['app.startup.failed', 'process.uncaughtException'].includes(event.event)
    )
    const deletionLog = logEvents.find(event => event.event === 'conversation.delete.complete')
    const rejectedDeleteLog = logEvents.find(
      event => event.event === 'ipc.request.failed' && event.details?.channel === 'codex:deleteConversationData'
    )
    const rejectedImportLog = logEvents.find(
      event => event.event === 'ipc.request.failed' && event.details?.channel === 'codex:importConversationData'
    )
    const rejectedExportLog = logEvents.find(
      event => event.event === 'ipc.request.failed' && event.details?.channel === 'codex:exportConversationData'
    )
    const result = {
      appPageUrl: page.url,
      uiReadyMs,
      expectedVersionLabel,
      visibleVersionLabels: [...new Set(visibleVersionLabels)],
      uiInstalled: pageText.includes('Codex 客户端已安装'),
      uiNotFound: pageText.includes('未发现 Codex 客户端'),
      rendererExceptions: cdp.exceptions,
      rendererConsoleErrors: cdp.consoleErrors,
      quick,
      full,
      packageManagement,
      removedGrokOAuthSurface,
      updateSurface,
      onlineLoginDialog,
      conversationTransferUi,
      rejectedConversationTransfer,
      rejectedConversationTransferLogged: Boolean(rejectedImportLog) && Boolean(rejectedExportLog),
      deletionSmoke,
      deletionFilesRemoved: !fs.existsSync(deletionSessionPath) && !fs.existsSync(deletionProjectPath),
      deletionLog: deletionLog?.details || null,
      rejectedDelete,
      rejectedDeleteLogged: Boolean(rejectedDeleteLog),
      packagedContents,
      newClientProcessIds,
      processVersion: processStart?.details?.version || '',
      portableDataRoot: processStart?.details?.dataRoot || '',
      startupComplete: startupComplete?.details || null,
      startupErrorCount: startupErrors.length
    }

    console.log(JSON.stringify(result, null, 2))

    const installedClientStateValid =
      result.uiInstalled === true &&
      result.uiNotFound === false &&
      result.quick?.installed === true &&
      result.full?.installed === true &&
      Number(result.full?.targetCount) > 0
    const missingClientStateValid =
      result.uiInstalled === false &&
      result.uiNotFound === true &&
      result.quick?.installed === false &&
      result.full?.installed === false &&
      Number(result.quick?.targetCount) === 0 &&
      Number(result.full?.targetCount) === 0 &&
      [...(result.quick?.issues || []), ...(result.full?.issues || [])].some(issue => /没有发现 Codex/.test(issue))
    const checks = [
      result.uiReadyMs > 0,
      installedClientStateValid || missingClientStateValid,
      result.visibleVersionLabels.length === 1,
      result.visibleVersionLabels[0] === expectedVersionLabel,
      result.rendererExceptions.length === 0,
      result.rendererConsoleErrors.length === 0,
      result.packageManagement?.skills?.some(
        item => item.name === 'packaged-skill' && item.source === 'user' && item.valid === true
      ),
      result.packageManagement?.agents?.some(
        item => item.name === 'packaged-agent' && item.source === 'custom-agent' && item.valid === true
      ),
      result.removedGrokOAuthSurface?.exposedApis?.length === 0,
      result.removedGrokOAuthSurface?.menuFound === false,
      result.removedGrokOAuthSurface?.activationProgressSubscription === true,
      result.updateSurface?.bridgeMethods?.every(item => item.type === 'function'),
      result.updateSurface?.stage === 'unsupported',
      result.updateSurface?.runtimeDiagnosticBridgeMethods?.every(item => item.type === 'function'),
      result.updateSurface?.runtimeDiagnostic === null,
      result.updateSurface?.runtimeDiagnosticSubscription === true,
      result.updateSurface?.buttonFound === true,
      result.updateSurface?.buttonDisabled === true,
      result.updateSurface?.runtimeLogBridge === 'function',
      result.updateSurface?.runtimeLogButtonFound === true,
      result.onlineLoginDialog?.addOpened === true,
      result.onlineLoginDialog?.newApiSelected === true,
      result.onlineLoginDialog?.dialogFound === true,
      result.onlineLoginDialog?.loginAndSyncCount === 1,
      result.onlineLoginDialog?.completeCount === 0,
      result.onlineLoginDialog?.defaultAddressFound === true,
      result.conversationTransferUi?.conversationOpened === true,
      result.conversationTransferUi?.pathControlCount >= 2,
      result.conversationTransferUi?.pathInitiallyHidden === true,
      result.conversationTransferUi?.pathRevealWorks === true,
      result.conversationTransferUi?.readableTextFound === true,
      result.conversationTransferUi?.topImportCount === 1,
      result.conversationTransferUi?.topExportCount === 1,
      result.conversationTransferUi?.legacyImportSessionCount === 0,
      result.conversationTransferUi?.legacyImportProjectCount === 0,
      result.conversationTransferUi?.importOpened === true,
      result.conversationTransferUi?.importDialogFound === true,
      result.conversationTransferUi?.importSessionChoice === true,
      result.conversationTransferUi?.importProjectChoice === true,
      result.conversationTransferUi?.exportOpened === true,
      result.conversationTransferUi?.exportDialogFound === true,
      result.conversationTransferUi?.exportSessionChoice === true,
      result.conversationTransferUi?.exportProjectChoice === true,
      result.conversationTransferUi?.exportSelectionFound === true,
      result.conversationTransferUi?.importBridge === 'function',
      result.conversationTransferUi?.exportBridge === 'function',
      result.conversationTransferUi?.legacyImportSessionBridge === 'undefined',
      result.conversationTransferUi?.legacyAddProjectBridge === 'undefined',
      result.rejectedConversationTransfer?.length === 2,
      result.rejectedConversationTransfer?.every(item => item.rejected === true),
      /请选择要导入的内容类型/.test(result.rejectedConversationTransfer?.[0]?.message || ''),
      /请选择要导出的对话或项目/.test(result.rejectedConversationTransfer?.[1]?.message || ''),
      result.rejectedConversationTransferLogged === true,
      result.deletionSmoke?.deletedSessionCount === 1,
      result.deletionSmoke?.skippedSessionCount === 0,
      result.deletionSmoke?.deletedProjectCount === 1,
      result.deletionSmoke?.skippedProjectCount === 0,
      !result.deletionSmoke?.configurationError,
      result.deletionFilesRemoved === true,
      result.deletionLog?.deletedSessionCount === 1,
      result.deletionLog?.deletedProjectCount === 1,
      result.rejectedDelete?.rejected === true,
      /批量删除必须经过确认/.test(result.rejectedDelete?.message || ''),
      result.rejectedDeleteLogged === true,
      result.packagedContents?.forbiddenDevelopmentFiles?.length === 0,
      result.packagedContents?.expectedRemixIconCount > 0,
      result.packagedContents?.expectedRemixIconCount <= 128,
      result.packagedContents?.remixIconCount === result.packagedContents?.expectedRemixIconCount,
      result.newClientProcessIds.length === 0,
      result.processVersion === packageMetadata.version,
      path.resolve(result.portableDataRoot) === path.resolve(dataRoot),
      path.resolve(result.startupComplete?.portableDataRoot || '') === path.resolve(dataRoot),
      result.startupComplete?.storageMigration?.reason === 'disabled',
      result.startupComplete?.automaticCodexLaunch === false,
      Boolean(result.startupComplete?.legacyInstanceScan?.reason),
      result.startupComplete?.legacyInstanceScan?.ok === true,
      result.startupComplete?.legacyInstanceScan?.reason !== 'same-executable' ||
        (result.startupComplete?.legacyInstanceScan?.scanned === false &&
          result.startupComplete?.legacyInstanceScan?.durationMs === 0),
      result.startupComplete?.closePromptEnabled === true,
      result.startupComplete?.closeMinimizeTarget === 'taskbar',
      result.startupErrorCount === 0
    ]

    if (checks.some(check => !check)) throw new Error('最终打包 UI 验收未通过')
  } finally {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      // The app may already have exited.
    }
    await stopManagerProcesses(executablePath)
    await sleep(2000)
    fs.rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }

  const remaining = managerProcessIds(executablePath)
  if (remaining.length) throw new Error(`最终打包管理器仍有 ${remaining.length} 个残留进程`)
}

main().catch(async error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
