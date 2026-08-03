const assert = require('assert')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const manager = require('./codexManager')
const { adaptResponsesRequest, normalizeResponsesToolItemIds, runWithAbortTimeout } = require('./protocolProxy')
const runtimeLogger = require('./runtimeLogger')
const { allowedGithubDownloadHost, safePackageName } = require('./features/packageArchive')
const { canonicalModelFor, modelIdentityInstruction, normalizeReasoningEffort } = require('./protocol/modelRouting')
const {
  followsImmediateToolResult,
  followsImmediateResponsesToolResult,
  isMalformedToolRecovery,
  looksLikePendingMultiStepAction,
  looksLikeStalledToolContinuation,
  requestLikelyRequiresTool,
  shouldAcceptContinuationRecovery
} = require('./protocol/toolContinuation')
const { readResponseBufferLimited, readResponseJsonLimited } = require('./protocol/upstreamRequest')
const {
  legacyCleanupCommand,
  legacyScanDecision,
  rememberManagerExecutable,
  rememberManagerExecutableAfterScan,
  stopLegacyManagerInstances
} = require('./runtime/legacyInstanceGuard')
const {
  configurePortableStorage,
  legacyDataMigrationEnabled,
  migratePortableData,
  parseCompleteReleaseVersion,
  portableStoragePaths,
  previousPortableDataRoots
} = require('./runtime/portableStorage')
const {
  cacheControlForTarget,
  isPathInsideRoot,
  resolveStaticTarget,
  startStaticUiServer
} = require('./runtime/staticUiServer')
const {
  CLOSE_ACTION,
  actionFromResponse,
  closePromptOptions,
  createWindowCloseHandler
} = require('./runtime/windowClose')
const { sameOrigin } = require('./runtime/windowSecurity')

function rawHttpRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let response = ''

    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
    })
    socket.once('end', () => resolve(response))
    socket.once('connect', () => socket.end(requestText))
  })
}

async function main() {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-legacy-'))
  const markerPath = path.join(legacyRoot, 'manager-executable.json')
  const currentExecutable = 'D:\\AI\\ChatGPT-Model-Manager-1.2.32-complete\\ChatGPT Model Manager.exe'
  const previousExecutable = 'D:\\AI\\ChatGPT-Model-Manager-1.2.31-complete\\ChatGPT Model Manager.exe'

  try {
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    assert.match(legacyCleanupCommand(currentExecutable, 1234), /Get-CimInstance Win32_Process -Filter/)
    assert.match(legacyCleanupCommand(currentExecutable, 1234), /\$currentPid = 1234/)

    fs.writeFileSync(markerPath, JSON.stringify({ version: 1, executablePath: previousExecutable }), 'utf8')
    let scanCalls = 0
    let clock = 100
    const changedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      processId: 1234,
      markerPath,
      platform: 'win32',
      execFileSyncFn(file, args, options) {
        scanCalls += 1
        assert.strictEqual(file, 'powershell.exe')
        assert.deepStrictEqual(args.slice(0, 2), ['-NoProfile', '-Command'])
        assert.strictEqual(options.encoding, 'utf8')
        assert.strictEqual(options.windowsHide, true)
        assert.deepStrictEqual(options.stdio, ['ignore', 'pipe', 'ignore'])
        assert.strictEqual(options.timeout, 10000)

        return '2'
      },
      now: () => {
        clock += 25

        return clock
      }
    })

    assert.deepStrictEqual(changedScan, {
      scan: true,
      reason: 'executable-changed',
      ok: true,
      durationMs: 25,
      stoppedCount: 2
    })
    assert.strictEqual(scanCalls, 1)
    assert.deepStrictEqual(
      rememberManagerExecutable({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { updated: true, reason: 'stored' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable.toUpperCase(),
        markerPath,
        platform: 'win32'
      }),
      { scan: false, reason: 'same-executable' }
    )
    const repeatedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      execFileSyncFn() {
        throw new Error('same-path startup must not launch PowerShell')
      }
    })

    assert.deepStrictEqual(repeatedScan, {
      scan: false,
      reason: 'same-executable',
      ok: true,
      durationMs: 0,
      stoppedCount: 0
    })

    fs.writeFileSync(markerPath, '{broken json', 'utf8')
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: 'C:\\Tools\\electron.exe',
        markerPath,
        platform: 'win32'
      }),
      { scan: false, reason: 'not-packaged-windows-manager' }
    )
    const failedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      execFileSyncFn() {
        const error = new Error('simulated access denied')

        error.code = 'EACCES'
        throw error
      },
      now: (() => {
        let value = 200

        return () => {
          value += 10

          return value
        }
      })()
    })

    assert.deepStrictEqual(failedScan, {
      scan: true,
      reason: 'marker-missing-or-invalid',
      ok: false,
      durationMs: 10,
      stoppedCount: 0,
      errorCode: 'EACCES'
    })
    assert.deepStrictEqual(
      rememberManagerExecutableAfterScan({
        scanResult: failedScan,
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { updated: false, reason: 'legacy-scan-failed' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    const forcedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      force: true,
      execFileSyncFn() {
        return '1'
      },
      now: (() => {
        let value = 300

        return () => {
          value += 5

          return value
        }
      })()
    })

    assert.deepStrictEqual(forcedScan, {
      scan: true,
      reason: 'single-instance-lock-conflict',
      ok: true,
      durationMs: 5,
      stoppedCount: 1
    })
  } finally {
    fs.rmSync(legacyRoot, { recursive: true, force: true })
  }

  const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-portable-'))
  const currentClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.32-complete')
  const previousClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.31-complete')
  const olderClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.30-complete')
  const legacyHome = path.join(portableRoot, 'legacy-home')
  const legacyAppData = path.join(legacyHome, 'AppData', 'Roaming')
  const legacyLocalAppData = path.join(legacyHome, 'AppData', 'Local')
  const legacyElectronUserData = path.join(legacyAppData, 'chatgpt-model-manager')

  try {
    const paths = portableStoragePaths({
      isPackaged: true,
      executablePath: path.join(currentClientRoot, 'ChatGPT Model Manager.exe')
    })

    fs.mkdirSync(path.join(previousClientRoot, 'data', 'manager'), { recursive: true })
    fs.mkdirSync(path.join(olderClientRoot, 'data', 'manager'), { recursive: true })
    fs.mkdirSync(path.join(legacyHome, '.codex', 'codex-model-manager'), { recursive: true })
    fs.mkdirSync(path.join(legacyElectronUserData, 'other-channels', 'grok-oauth'), { recursive: true })
    fs.mkdirSync(path.join(legacyLocalAppData, 'ChatGPT Model Manager', 'logs'), { recursive: true })
    fs.writeFileSync(
      path.join(previousClientRoot, 'data', 'manager', 'channels.json'),
      '{"source":"previous-portable"}'
    )
    fs.writeFileSync(path.join(olderClientRoot, 'data', 'manager', 'channels.json'), '{"source":"older-portable"}')
    fs.writeFileSync(
      path.join(legacyHome, '.codex', 'codex-model-manager', 'channels.json'),
      '{"source":"legacy-manager"}'
    )
    fs.writeFileSync(
      path.join(legacyHome, '.codex', 'codex-model-manager', 'newapi.json'),
      '{"source":"legacy-manager"}'
    )
    fs.writeFileSync(path.join(legacyElectronUserData, 'Preferences'), '{"theme":"portable-test"}')
    fs.writeFileSync(
      path.join(legacyElectronUserData, 'other-channels', 'grok-oauth', 'account.json'),
      '{"id":"portable-test"}'
    )
    fs.writeFileSync(path.join(legacyLocalAppData, 'ChatGPT Model Manager', 'logs', 'legacy.log'), 'legacy-log')

    assert.deepStrictEqual(parseCompleteReleaseVersion('ChatGPT-Model-Manager-1.2.32-complete'), [1, 2, 32])
    assert.strictEqual(parseCompleteReleaseVersion('unrelated-folder'), null)
    assert.deepStrictEqual(previousPortableDataRoots(paths), [
      path.join(previousClientRoot, 'data'),
      path.join(olderClientRoot, 'data')
    ])

    const setPaths = new Map()
    let appLogsPath = ''
    const fakeApp = {
      getPath(name) {
        assert.strictEqual(name, 'userData')
        return legacyElectronUserData
      },
      setPath(name, value) {
        setPaths.set(name, value)
      },
      setAppLogsPath(value) {
        appLogsPath = value
      }
    }
    const configured = configurePortableStorage({
      app: fakeApp,
      isPackaged: true,
      executablePath: path.join(currentClientRoot, 'ChatGPT Model Manager.exe')
    })

    assert.strictEqual(configured.dataRoot, path.join(currentClientRoot, 'data'))
    assert.strictEqual(configured.legacyElectronUserData, legacyElectronUserData)
    assert.strictEqual(setPaths.get('userData'), configured.electronUserData)
    assert.strictEqual(setPaths.get('sessionData'), configured.sessionData)
    assert.strictEqual(setPaths.get('crashDumps'), configured.crashDumps)
    assert.strictEqual(appLogsPath, configured.electronLogs)
    assert.strictEqual(legacyDataMigrationEnabled({}), false)
    assert.strictEqual(legacyDataMigrationEnabled({ CODEX_MM_ENABLE_LEGACY_DATA_MIGRATION: '1' }), true)
    assert.strictEqual(
      legacyDataMigrationEnabled({
        CODEX_MM_ENABLE_LEGACY_DATA_MIGRATION: '1',
        CODEX_MM_DISABLE_LEGACY_DATA_MIGRATION: '1'
      }),
      false
    )

    const migrated = migratePortableData(configured, {
      homeDir: legacyHome,
      appDataDir: legacyAppData,
      localAppDataDir: legacyLocalAppData,
      legacyElectronUserData
    })

    assert.strictEqual(migrated.migrated, true)
    assert.strictEqual(migrated.reason, 'migration-complete')
    assert.strictEqual(migrated.errors.length, 0)
    assert.ok(migrated.filesCopied >= 4)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configured.managerState, 'channels.json'), 'utf8')), {
      source: 'previous-portable'
    })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configured.managerState, 'newapi.json'), 'utf8')), {
      source: 'legacy-manager'
    })
    assert.strictEqual(fs.existsSync(path.join(configured.electronUserData, 'Preferences')), true)
    assert.strictEqual(
      fs.existsSync(path.join(configured.electronUserData, 'other-channels', 'grok-oauth', 'account.json')),
      false
    )
    assert.strictEqual(fs.existsSync(path.join(configured.logs, 'legacy.log')), true)
    assert.strictEqual(fs.existsSync(configured.migrationMarker), true)
    assert.deepStrictEqual(migratePortableData(configured), {
      migrated: false,
      reason: 'already-migrated',
      filesCopied: 0,
      bytesCopied: 0,
      skippedLinks: 0,
      errors: []
    })

    const markerFailurePaths = portableStoragePaths({
      isPackaged: true,
      executablePath: path.join(portableRoot, 'marker-failure-client', 'ChatGPT Model Manager.exe')
    })

    fs.mkdirSync(markerFailurePaths.migrationMarker, { recursive: true })
    const markerFailure = migratePortableData(markerFailurePaths, {
      homeDir: path.join(portableRoot, 'empty-home'),
      appDataDir: path.join(portableRoot, 'empty-appdata'),
      localAppDataDir: path.join(portableRoot, 'empty-localappdata')
    })

    assert.strictEqual(markerFailure.reason, 'migration-incomplete')
    assert.strictEqual(markerFailure.errors.length, 1)
    assert.strictEqual(markerFailure.errors[0].kind, 'migration-marker')
    assert.ok(markerFailure.errors[0].code)
  } finally {
    fs.rmSync(portableRoot, { recursive: true, force: true })
  }

  const closeOptions = closePromptOptions()

  assert.deepStrictEqual(closeOptions.buttons, ['最小化到任务栏', '关闭程序', '取消'])
  assert.strictEqual(closeOptions.defaultId, 0)
  assert.strictEqual(closeOptions.cancelId, 2)
  assert.strictEqual(actionFromResponse(0), CLOSE_ACTION.MINIMIZE)
  assert.strictEqual(actionFromResponse(1), CLOSE_ACTION.QUIT)
  assert.strictEqual(actionFromResponse(2), CLOSE_ACTION.CANCEL)
  assert.strictEqual(actionFromResponse(99), CLOSE_ACTION.CANCEL)

  async function runCloseChoice(response) {
    const state = {
      dialogCalls: 0,
      minimized: 0,
      quit: 0,
      quitting: false,
      options: null
    }
    const window = { id: 'main-window' }
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      }
    }
    const handler = createWindowCloseHandler({
      dialog: {
        async showMessageBox(parent, options) {
          assert.strictEqual(parent, window)
          state.dialogCalls += 1
          state.options = options

          return { response }
        }
      },
      getWindow: () => window,
      isQuitting: () => state.quitting,
      onMinimize: () => {
        state.minimized += 1
      },
      onQuit: () => {
        state.quitting = true
        state.quit += 1
      }
    })

    await handler(event)

    return { event, state }
  }

  const minimizeChoice = await runCloseChoice(0)

  assert.strictEqual(minimizeChoice.event.prevented, true)
  assert.strictEqual(minimizeChoice.state.dialogCalls, 1)
  assert.strictEqual(minimizeChoice.state.options.message, '要最小化到任务栏，还是关闭程序？')
  assert.strictEqual(minimizeChoice.state.minimized, 1)
  assert.strictEqual(minimizeChoice.state.quit, 0)

  const quitChoice = await runCloseChoice(1)

  assert.strictEqual(quitChoice.state.minimized, 0)
  assert.strictEqual(quitChoice.state.quit, 1)
  assert.strictEqual(quitChoice.state.quitting, true)

  const cancelChoice = await runCloseChoice(2)

  assert.strictEqual(cancelChoice.state.minimized, 0)
  assert.strictEqual(cancelChoice.state.quit, 0)

  let resolveClosePrompt
  let concurrentDialogCalls = 0
  const concurrentHandler = createWindowCloseHandler({
    dialog: {
      showMessageBox() {
        concurrentDialogCalls += 1

        return new Promise(resolve => {
          resolveClosePrompt = resolve
        })
      }
    },
    getWindow: () => ({}),
    isQuitting: () => false,
    onMinimize: () => {},
    onQuit: () => {}
  })
  const firstConcurrentEvent = { preventDefault() {} }
  const secondConcurrentEvent = { preventDefault() {} }
  const firstClose = concurrentHandler(firstConcurrentEvent)
  const secondClose = concurrentHandler(secondConcurrentEvent)

  assert.strictEqual(concurrentDialogCalls, 1)
  resolveClosePrompt({ response: 2 })
  await Promise.all([firstClose, secondClose])

  let promptFailure = null
  const failureEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  const failureHandler = createWindowCloseHandler({
    dialog: {
      async showMessageBox() {
        throw new Error('simulated close prompt failure')
      }
    },
    getWindow: () => ({}),
    isQuitting: () => false,
    onMinimize: () => {
      throw new Error('must not minimize after prompt failure')
    },
    onQuit: () => {
      throw new Error('must not quit after prompt failure')
    },
    logError: (event, error) => {
      promptFailure = { event, message: error.message }
    }
  })

  await failureHandler(failureEvent)
  assert.strictEqual(failureEvent.prevented, true)
  assert.deepStrictEqual(promptFailure, {
    event: 'window.close.prompt.failed',
    message: 'simulated close prompt failure'
  })

  let quittingDialogCalls = 0
  const quittingEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  const quittingHandler = createWindowCloseHandler({
    dialog: {
      async showMessageBox() {
        quittingDialogCalls += 1

        return { response: 0 }
      }
    },
    getWindow: () => ({}),
    isQuitting: () => true,
    onMinimize: () => {},
    onQuit: () => {}
  })

  await quittingHandler(quittingEvent)
  assert.strictEqual(quittingEvent.prevented, false)
  assert.strictEqual(quittingDialogCalls, 0)

  assert.match(modelIdentityInstruction('grok-4.5'), /selected_upstream_model_id="grok-4\.5"/)
  assert.strictEqual(
    canonicalModelFor({ modelAliases: { 'gpt-native-slot': 'grok-4.5' } }, 'gpt-native-slot'),
    'grok-4.5'
  )
  assert.strictEqual(normalizeReasoningEffort('ultra', ['low', 'high']), 'high')

  const crossModelInput = [
    {
      id: 'fc_53e2893f954b40c8af50100324613d7c',
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_cross_model',
      input: 'text("ok")'
    },
    { type: 'custom_tool_call_output', call_id: 'call_cross_model', output: 'ok' },
    {
      id: 'ctc_1c667409108a493b95f89b8ffefa4079',
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call_native_function',
      arguments: '{"command":"echo ok"}'
    }
  ]
  const normalizedCrossModelInput = normalizeResponsesToolItemIds(crossModelInput)

  assert.strictEqual(normalizedCrossModelInput[0].id, 'ctc_53e2893f954b40c8af50100324613d7c')
  assert.strictEqual(normalizedCrossModelInput[0].call_id, 'call_cross_model')
  assert.strictEqual(normalizedCrossModelInput[1], crossModelInput[1])
  assert.strictEqual(normalizedCrossModelInput[2].id, 'fc_1c667409108a493b95f89b8ffefa4079')
  assert.strictEqual(crossModelInput[0].id, 'fc_53e2893f954b40c8af50100324613d7c')
  assert.deepStrictEqual(
    adaptResponsesRequest({ model: 'gpt-5.6-sol', input: crossModelInput }, {}).input.map(item => item.id || ''),
    ['ctc_53e2893f954b40c8af50100324613d7c', '', 'fc_1c667409108a493b95f89b8ffefa4079']
  )

  assert.strictEqual(followsImmediateToolResult([{ role: 'user' }, { role: 'tool' }]), true)
  assert.strictEqual(followsImmediateToolResult([{ role: 'tool' }, { role: 'user' }]), false)
  assert.strictEqual(followsImmediateToolResult([{ role: 'tool' }, { role: 'system' }]), true)
  assert.strictEqual(
    followsImmediateResponsesToolResult([
      { type: 'custom_tool_call_output', call_id: 'call_image_skill', output: 'skill loaded' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context><cwd>D:\\AI</cwd></environment_context>' }]
      }
    ]),
    true
  )
  assert.strictEqual(
    followsImmediateResponsesToolResult([
      { type: 'custom_tool_call_output', call_id: 'call_image_skill', output: 'skill loaded' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Start a different task instead.' }]
      }
    ]),
    false
  )
  assert.strictEqual(isMalformedToolRecovery('<codex_no_tool>'), true)
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: '今日金价' }], new Set(['exec', 'wait'])),
    true
  )
  assert.strictEqual(
    requestLikelyRequiresTool(
      [{ role: 'user', content: 'This is a new task. Inspect it with the shell.' }],
      new Set(['shell_command'])
    ),
    true
  )
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: 'Explain how gold markets work.' }], new Set(['exec'])),
    false
  )
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: '今日金价' }], new Set(['request_user_input'])),
    false
  )
  assert.strictEqual(looksLikeStalledToolContinuation('我先确认有没有 image-gen 工具。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('我先检查是否有可用的 image_gen 技能。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('按照图像生成流程读取相关技能说明。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('正在加载图像生成能力。'), true)
  const screenshotPlan = '先改用更稳妥的方式：写一个本地脚本，再获取金价、打开记事本并保存到桌面。'

  assert.strictEqual(looksLikePendingMultiStepAction(screenshotPlan), true)
  assert.strictEqual(looksLikeStalledToolContinuation(screenshotPlan), false)
  assert.strictEqual(looksLikeStalledToolContinuation(screenshotPlan, { afterToolResult: true }), true)
  assert.strictEqual(looksLikeStalledToolContinuation('正在准备下一个可执行步骤。', { afterToolResult: true }), true)
  assert.strictEqual(
    looksLikeStalledToolContinuation('文件已经成功写入并保存到桌面。', { afterToolResult: true }),
    false
  )
  assert.strictEqual(
    looksLikeStalledToolContinuation('无法获取金价，请提供可用的数据源。', { afterToolResult: true }),
    false
  )
  assert.strictEqual(
    looksLikeStalledToolContinuation('我确认过了：没有可用的 image-gen 工具，因此无法继续生成。'),
    false
  )
  assert.strictEqual(looksLikeStalledToolContinuation('图片已经生成，见附件。'), false)
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledAfterToolResult: true,
      retryContent: '<codex_no_tool>',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledContinuation: true,
      retryContent: '正在加载图像生成能力。',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledAfterToolResult: true,
      stalledContinuation: true,
      retryContent: '下一步将继续执行保存任务。',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledContinuation: true,
      retryContent: '还缺少要编辑的原图，请重新附加图片。',
      retryToolCall: null
    }),
    true
  )

  assert.strictEqual(safePackageName('..'), 'imported')
  assert.strictEqual(safePackageName('my skill'), 'my-skill')
  assert.strictEqual(allowedGithubDownloadHost('github.com'), true)
  assert.strictEqual(allowedGithubDownloadHost('objects.githubusercontent.com', true), true)
  assert.strictEqual(allowedGithubDownloadHost('example.com', true), false)

  assert.strictEqual(sameOrigin('http://127.0.0.1:123/a', 'http://127.0.0.1:123/b'), true)
  assert.strictEqual(sameOrigin('https://example.com', 'http://127.0.0.1:123'), false)

  const limitedJson = await readResponseJsonLimited(new Response(JSON.stringify({ ok: true })), 64)

  assert.deepStrictEqual(limitedJson, { ok: true })
  await assert.rejects(readResponseBufferLimited(new Response('0123456789'), 5), /上游响应超过/)
  const recoveryTimeoutStartedAt = Date.now()

  await assert.rejects(
    runWithAbortTimeout(
      undefined,
      15,
      signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    ),
    /prompt tool recovery timed out/
  )
  assert.ok(Date.now() - recoveryTimeoutStartedAt < 1000)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-modules-'))
  const outRoot = path.join(tempRoot, 'out')
  const siblingRoot = path.join(tempRoot, 'output')

  fs.mkdirSync(outRoot)
  fs.mkdirSync(siblingRoot)
  const staticChunkPath = path.join(outRoot, '_next', 'static', 'chunks', 'app-test.js')

  fs.mkdirSync(path.dirname(staticChunkPath), { recursive: true })
  fs.writeFileSync(path.join(outRoot, 'index.html'), '<!doctype html><title>module-test</title>')
  fs.writeFileSync(staticChunkPath, 'window.__STATIC_CACHE_TEST__ = true')
  fs.writeFileSync(path.join(siblingRoot, 'secret.txt'), 'must-not-leak')
  assert.strictEqual(isPathInsideRoot(outRoot, path.join(outRoot, 'index.html')), true)
  assert.strictEqual(isPathInsideRoot(outRoot, path.join(siblingRoot, 'secret.txt')), false)
  assert.strictEqual(resolveStaticTarget(outRoot, '/%2e%2e%5coutput%5csecret.txt'), null)
  assert.strictEqual(cacheControlForTarget(outRoot, path.join(outRoot, 'index.html')), 'no-cache')
  assert.strictEqual(cacheControlForTarget(outRoot, staticChunkPath), 'public, max-age=31536000, immutable')

  const staticUi = await startStaticUiServer({ outDir: outRoot })

  try {
    const indexResponse = await fetch(staticUi.url)
    const methodResponse = await fetch(staticUi.url, { method: 'POST' })
    const traversalResponse = await fetch(`${staticUi.url}/%2e%2e%5coutput%5csecret.txt`)
    const staticChunkResponse = await fetch(`${staticUi.url}/_next/static/chunks/app-test.js`)

    assert.strictEqual(indexResponse.status, 200)
    assert.strictEqual(indexResponse.headers.get('cache-control'), 'no-cache')
    assert.strictEqual(staticChunkResponse.status, 200)
    assert.strictEqual(staticChunkResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(indexResponse.headers.get('content-security-policy') || '', /default-src 'self'/)
    assert.strictEqual(methodResponse.status, 405)
    assert.strictEqual(traversalResponse.status, 404)
    assert.doesNotMatch(await traversalResponse.text(), /must-not-leak/)
    const malformedResponse = await rawHttpRequest(
      staticUi.port,
      'GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    )

    assert.match(malformedResponse, /^HTTP\/1\.1 400 /)
    assert.strictEqual((await fetch(staticUi.url)).status, 200)
  } finally {
    await new Promise(resolve => staticUi.server.close(resolve))
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  const previousManagerStateDir = process.env.CODEX_MANAGER_STATE_DIR
  const portableManagerStateDir = path.join(os.tmpdir(), 'portable-manager-state-test')

  process.env.CODEX_MANAGER_STATE_DIR = portableManagerStateDir
  assert.strictEqual(manager.getPaths({ homeDir: os.tmpdir() }).stateDir, portableManagerStateDir)
  if (previousManagerStateDir === undefined) delete process.env.CODEX_MANAGER_STATE_DIR
  else process.env.CODEX_MANAGER_STATE_DIR = previousManagerStateDir
  assert.strictEqual(runtimeLogger.configureRuntimeLogger({ roots: [] }), '')
  assert.strictEqual(runtimeLogger.logEvent('info', 'test.no-appdata-fallback'), false)

  console.log('module boundary tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
