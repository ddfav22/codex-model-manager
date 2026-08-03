const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough, Writable } = require('stream')
const manager = require('./codexManager')
const runtimeLogger = require('./runtimeLogger')
const { inspectZip } = require('./features/packageArchive')
const { parseResponsesProbePayload } = require('./protocol/probeParsing')
const {
  DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS,
  RESPONSES_PROBE_MAX_ATTEMPTS,
  isTransientResponsesProbeFailure,
  responsesProbeRuntimeOptions
} = require('./protocol/probeRequests')

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-manager-'))
  const options = {
    codexHome: tempRoot,
    configPath: path.join(tempRoot, 'config.toml'),
    stateDir: path.join(tempRoot, 'codex-model-manager'),
    skipEnvWrite: true,
    skipChannelTest: true,
    skipBundledModelCapture: true,
    dryRunRestart: true
  }
  const authPath = path.join(tempRoot, 'auth.json')
  const modelsCachePath = path.join(tempRoot, 'models_cache.json')
  const sessionDir = path.join(tempRoot, 'sessions', '2026', '06', '25')
  const externalDir = path.join(tempRoot, 'external')
  const projectDir = path.join(tempRoot, 'project-a')
  const projectTablePath = projectDir.toLowerCase().replace(/'/g, "''")
  const originalCodexInstructions =
    'You are Codex, an agent based on GPT-5. ' +
    'ORIGINAL_CODEX_CAPABILITY_MARKER Shell file MCP plugin approval and tool-result behavior. '.repeat(30)

  const runtimeLogDir = path.join(tempRoot, 'runtime-logs')
  const runtimeLogPath = runtimeLogger.configureRuntimeLogger({ roots: [runtimeLogDir] })

  assert.strictEqual(manager._internal.appVersion, require('../package.json').version)
  assert.strictEqual(
    runtimeLogger.logEvent('info', 'test.logger', {
      apiKey: 'test-api-key-super-secret-value',
      authorization: 'Bearer hidden-token',
      safe: 'visible'
    }),
    true
  )
  const runtimeLogText = fs.readFileSync(runtimeLogPath, 'utf8')

  assert.match(runtimeLogText, /test\.logger/)
  assert.match(runtimeLogText, /visible/)
  assert.doesNotMatch(runtimeLogText, /test-api-key-super-secret-value/)
  assert.doesNotMatch(runtimeLogText, /hidden-token/)
  assert.deepStrictEqual(responsesProbeRuntimeOptions('gpt-5.6-sol'), {
    max_output_tokens: DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS,
    stream: true,
    reasoning: { effort: 'low' }
  })
  assert.deepStrictEqual(responsesProbeRuntimeOptions('grok-4.5'), {
    max_output_tokens: DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS,
    stream: true
  })
  assert.strictEqual(RESPONSES_PROBE_MAX_ATTEMPTS, 3)
  assert.strictEqual(
    isTransientResponsesProbeFailure(
      { failure: { code: 'server_is_overloaded', type: 'service_unavailable_error' } },
      200
    ),
    true
  )
  assert.strictEqual(isTransientResponsesProbeFailure({ failure: { code: 'invalid_request_error' } }, 400), false)
  assert.strictEqual(isTransientResponsesProbeFailure(null, 503), true)
  const failedResponsesProbe = parseResponsesProbePayload(
    [
      `data: ${JSON.stringify({
        type: 'response.created',
        response: { status: 'in_progress', model: 'gpt-5.6-sol' }
      })}`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}`,
      `data: ${JSON.stringify({
        type: 'error',
        code: 'probe_budget_exhausted',
        message: 'The compatibility probe did not reach a final answer.'
      })}`,
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          status: 'failed',
          model: 'gpt-5.6-sol',
          error: { code: 'probe_budget_exhausted', type: 'invalid_request_error' }
        }
      })}`
    ].join('\n\n')
  )

  assert.strictEqual(failedResponsesProbe.completed, false)
  assert.strictEqual(failedResponsesProbe.terminalType, 'response.failed')
  assert.strictEqual(failedResponsesProbe.actualModel, 'gpt-5.6-sol')
  assert.strictEqual(failedResponsesProbe.failure.code, 'probe_budget_exhausted')
  assert.strictEqual(failedResponsesProbe.failure.type, 'invalid_request_error')

  const brokenPipeChild = new EventEmitter()

  brokenPipeChild.stdout = new PassThrough()
  brokenPipeChild.stderr = new PassThrough()
  brokenPipeChild.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }
  })
  brokenPipeChild.killed = false
  brokenPipeChild.kill = () => {
    brokenPipeChild.killed = true
  }

  await assert.rejects(
    manager._internal.runCodexAppServerRequest(
      'test-codex.exe',
      'thread/list',
      {},
      {
        timeoutMs: 1000,
        spawnProcess: () => brokenPipeChild
      }
    ),
    error => error?.code === 'EPIPE' && /管道已关闭/.test(error.message)
  )
  assert.strictEqual(brokenPipeChild.killed, true)

  const batchChild = new EventEmitter()

  batchChild.stdout = new PassThrough()
  batchChild.stderr = new PassThrough()
  batchChild.killed = false
  batchChild.kill = () => {
    batchChild.killed = true
  }
  batchChild.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk).trim())

      if (message.method === 'initialize') {
        process.nextTick(() => batchChild.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`))
      } else if (message.id) {
        const response =
          message.params?.threadId === 'thread-fail'
            ? { id: message.id, error: { message: 'thread locked' } }
            : { id: message.id, result: { deleted: true } }

        process.nextTick(() => batchChild.stdout.write(`${JSON.stringify(response)}\n`))
      }
      callback()
    }
  })
  const batchResults = await manager._internal.runCodexAppServerBatchRequests(
    'test-codex.exe',
    [
      { method: 'thread/delete', params: { threadId: 'thread-ok' } },
      { method: 'thread/delete', params: { threadId: 'thread-fail' } }
    ],
    { timeoutMs: 1000, spawnProcess: () => batchChild }
  )

  assert.strictEqual(batchResults.length, 2)
  assert.strictEqual(batchResults[0].ok, true)
  assert.strictEqual(batchResults[1].ok, false)
  assert.match(batchResults[1].error, /thread locked/)
  assert.strictEqual(batchChild.killed, true)

  fs.mkdirSync(sessionDir, { recursive: true })
  fs.mkdirSync(externalDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })

  fs.writeFileSync(
    options.configPath,
    [
      'model = "gpt-5"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "on-request"',
      'model_provider = "builtin-relay"',
      '',
      '[features]',
      'js_repl = false',
      'shell_tool = false',
      '',
      '[model_providers.builtin-relay]',
      'name = "Builtin Relay"',
      'base_url = "https://builtin.example.com/v1"',
      'env_key = "BUILTIN_RELAY_KEY"',
      'wire_api = "responses"',
      '',
      `[projects.'${projectTablePath}']`,
      'trust_level = "trusted"',
      ''
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'redacted' }, last_refresh: '2026-06-25T00:00:00.000Z' }, null, 2)}\n`,
    'utf8'
  )
  fs.writeFileSync(
    modelsCachePath,
    `${JSON.stringify(
      {
        fetched_at: '2026-06-25T00:00:00.000Z',
        etag: 'original-etag',
        client_version: 'test',
        models: [
          {
            slug: 'gpt-5.6-sol',
            display_name: 'GPT-5.6-Sol',
            description: 'Original catalog entry',
            visibility: 'list',
            supported_in_api: true,
            shell_type: 'disabled',
            tool_mode: 'code_mode_only',
            base_instructions: originalCodexInstructions,
            model_messages: {
              instructions_template: originalCodexInstructions
            },
            priority: 0
          },
          {
            slug: 'gpt-5.6-terra',
            display_name: 'GPT-5.6-Terra',
            description: 'Second native visible slot',
            visibility: 'list',
            supported_in_api: true,
            shell_type: 'disabled',
            tool_mode: 'code_mode_only',
            base_instructions: originalCodexInstructions,
            model_messages: {
              instructions_template: originalCodexInstructions
            },
            priority: 1
          },
          {
            slug: 'gpt-5.6-luna',
            display_name: 'GPT-5.6-Luna',
            description: 'Third native visible slot',
            visibility: 'list',
            supported_in_api: true,
            shell_type: 'disabled',
            tool_mode: 'code_mode_only',
            base_instructions: originalCodexInstructions,
            model_messages: {
              instructions_template: originalCodexInstructions
            },
            priority: 2
          },
          {
            slug: 'codex-auto-review',
            display_name: 'Codex Auto Review',
            visibility: 'hide',
            supported_in_api: true,
            priority: 99
          }
        ]
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const sessionPath = path.join(sessionDir, 'rollout-test-session.jsonl')
  const archivedSessionDir = path.join(tempRoot, 'archived_sessions')
  const archivedSessionPath = path.join(archivedSessionDir, 'rollout-archived-session.jsonl')
  const externalSessionPath = path.join(externalDir, 'external-session.jsonl')
  const sessionText = `${JSON.stringify({
    type: 'session_meta',
    payload: {
      session_id: 'test-session',
      thread_name: '测试对话',
      cwd: projectDir
    }
  })}\n`

  fs.writeFileSync(sessionPath, sessionText, 'utf8')
  const largeSessionPath = path.join(sessionDir, 'rollout-large-session.jsonl')

  fs.writeFileSync(
    largeSessionPath,
    `${sessionText.replace('test-session', 'large-test-session')}${'x'.repeat(2 * 1024 * 1024)}`,
    'utf8'
  )
  fs.mkdirSync(archivedSessionDir, { recursive: true })
  fs.writeFileSync(archivedSessionPath, sessionText.replace('test-session', 'archived-test-session'), 'utf8')
  fs.writeFileSync(externalSessionPath, sessionText, 'utf8')

  const firstStatus = manager.readStatus(options)
  assert.strictEqual(firstStatus.currentProvider, 'builtin-relay')
  assert.strictEqual(firstStatus.initialBackup.exists, true)
  assert.ok(fs.existsSync(firstStatus.initialBackup.path))
  assert.ok(
    firstStatus.providers.some(provider => provider.id === 'builtin-relay' && provider.source === 'codex-config')
  )
  assert.ok(firstStatus.sessions.some(session => session.id === 'test-session'))
  assert.ok(firstStatus.sessions.some(session => session.id === 'large-test-session'))
  assert.ok(
    firstStatus.sessions.some(session => session.id === 'archived-test-session' && session.location === 'archived')
  )
  const blockedSessionPath = path.join(sessionDir, 'rollout-blocked-session.jsonl')

  fs.writeFileSync(blockedSessionPath, sessionText.replace('test-session', 'blocked-test-session'), 'utf8')
  const originalStatSync = fs.statSync

  fs.statSync = function statSyncWithBlockedSession(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(blockedSessionPath)) {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }

    return originalStatSync.call(fs, filePath, ...args)
  }

  try {
    const statusWithBlockedSession = manager.readStatus(options)

    assert.ok(statusWithBlockedSession.sessions.some(session => session.id === 'test-session'))
    assert.ok(!statusWithBlockedSession.sessions.some(session => session.id === 'blocked-test-session'))
  } finally {
    fs.statSync = originalStatSync
    fs.rmSync(blockedSessionPath, { force: true })
  }
  assert.ok(firstStatus.projects.some(project => project.path === projectDir.toLowerCase()))
  assert.strictEqual(firstStatus.newApi.baseUrl, '')
  assert.strictEqual(firstStatus.newApi.relayBaseUrl, '')
  assert.strictEqual(firstStatus.initialBackup.modelsCacheExists, true)
  let conversationIndexScanned = false
  const conversationIndexRepair = await manager.repairCodexConversationIndex({
    ...options,
    codexCliPath: 'test-codex.exe',
    runAppServerRequest: async (_codexPath, method, params) => {
      assert.strictEqual(method, 'thread/list')
      assert.deepStrictEqual(params.modelProviders, [])
      assert.strictEqual(params.sortKey, 'recency_at')
      assert.strictEqual(params.sortDirection, 'desc')
      assert.ok(Array.isArray(params.sourceKinds))

      if (!params.useStateDbOnly) conversationIndexScanned = true

      return {
        result: {
          data:
            params.useStateDbOnly && !conversationIndexScanned
              ? []
              : [
                  { id: 'test-session', cwd: projectDir },
                  { id: 'large-test-session', cwd: projectDir }
                ],
          nextCursor: null
        }
      }
    }
  })

  assert.strictEqual(conversationIndexRepair.ok, true)
  assert.strictEqual(conversationIndexRepair.repaired, true)
  assert.strictEqual(conversationIndexRepair.diskSessionCount, 2)
  assert.strictEqual(conversationIndexRepair.indexedBeforeCount, 0)
  assert.strictEqual(conversationIndexRepair.indexedAfterCount, 2)
  assert.strictEqual(conversationIndexRepair.missingSessionCount, 0)
  assert.strictEqual(conversationIndexRepair.normalizedSessionCount, 0)

  const originalSessionLines = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)
  const normalizedSession = manager._internal.normalizeSessionForDesktop(sessionPath)
  const normalizedSessionLines = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)
  const normalizedSessionMeta = JSON.parse(normalizedSessionLines[0]).payload

  assert.ok(normalizedSession?.backupPath)
  assert.ok(fs.existsSync(normalizedSession.backupPath))
  assert.strictEqual(normalizedSessionMeta.session_id, 'test-session')
  assert.strictEqual(normalizedSessionMeta.cwd, projectDir)
  assert.strictEqual(normalizedSessionMeta.originator, 'Codex Desktop')
  assert.strictEqual(normalizedSessionMeta.source, 'vscode')
  assert.strictEqual(normalizedSessionMeta.thread_source, 'user')
  assert.strictEqual(normalizedSessionMeta.history_mode, 'legacy')
  assert.deepStrictEqual(normalizedSessionLines.slice(1), originalSessionLines.slice(1))
  assert.strictEqual(manager._internal.normalizeSessionForDesktop(sessionPath), null)

  const sessionFilesById = new Map([
    ['test-session', sessionPath],
    ['large-test-session', largeSessionPath]
  ])
  const desktopVisibilityRepair = await manager.repairCodexConversationIndex({
    ...options,
    codexCliPath: 'test-codex.exe',
    runAppServerRequest: async (_codexPath, method, params) => {
      if (method === 'thread/delete') {
        const target = sessionFilesById.get(params.threadId)

        assert.ok(target)
        fs.rmSync(target, { force: true })
        return { result: {} }
      }

      assert.strictEqual(method, 'thread/list')

      const data = []

      for (const [id, filePath] of sessionFilesById) {
        if (!fs.existsSync(filePath)) continue

        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]).payload
        const source = payload.source || 'unknown'

        if (!params.sourceKinds.length ? source === 'vscode' : params.sourceKinds.includes(source)) {
          data.push({ id, source, threadSource: payload.thread_source || null, ephemeral: false })
        }
      }

      return { result: { data, nextCursor: null } }
    }
  })

  assert.strictEqual(desktopVisibilityRepair.ok, true)
  assert.strictEqual(desktopVisibilityRepair.indexedBeforeCount, 1)
  assert.strictEqual(desktopVisibilityRepair.indexedAfterCount, 2)
  assert.strictEqual(desktopVisibilityRepair.normalizedSessionCount, 1)
  assert.strictEqual(desktopVisibilityRepair.reindexedSessionCount, 1)
  assert.deepStrictEqual(desktopVisibilityRepair.reindexedSessionIds, ['large-test-session'])
  assert.deepStrictEqual(desktopVisibilityRepair.reindexErrors, [])
  assert.ok(fs.existsSync(largeSessionPath))
  assert.strictEqual(
    JSON.parse(fs.readFileSync(largeSessionPath, 'utf8').split(/\r?\n/, 1)[0]).payload.source,
    'vscode'
  )

  const diskMaintenanceHome = path.join(tempRoot, 'disk-maintenance-home')
  const diskMaintenanceSession = path.join(diskMaintenanceHome, 'sessions', '2026', '07', '27', 'rollout-keep.jsonl')
  const diskMaintenanceFiles = {
    log: path.join(diskMaintenanceHome, 'logs_2.sqlite'),
    wal: path.join(diskMaintenanceHome, 'logs_2.sqlite-wal'),
    legacyLog: path.join(diskMaintenanceHome, 'sqlite', 'logs_2.sqlite'),
    temp: path.join(diskMaintenanceHome, '.tmp', 'download.tmp'),
    cache: path.join(diskMaintenanceHome, 'cache', 'catalog.json'),
    state: path.join(diskMaintenanceHome, 'state_5.sqlite'),
    config: path.join(diskMaintenanceHome, 'config.toml')
  }

  for (const [filePath, size] of [
    [diskMaintenanceFiles.log, 300],
    [diskMaintenanceFiles.wal, 20],
    [diskMaintenanceFiles.legacyLog, 400],
    [diskMaintenanceFiles.temp, 100],
    [diskMaintenanceFiles.cache, 200],
    [diskMaintenanceFiles.state, 50],
    [diskMaintenanceSession, 500]
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.alloc(size, 1))
  }
  fs.writeFileSync(diskMaintenanceFiles.config, 'model = "gpt-5.6"\n', 'utf8')

  const diskOptions = {
    codexHome: diskMaintenanceHome,
    stateDir: path.join(diskMaintenanceHome, 'codex-model-manager')
  }
  const diskUsage = manager.inspectCodexDiskUsage(diskOptions)

  assert.strictEqual(diskUsage.reclaimableBytes, 1020)
  assert.strictEqual(diskUsage.sessionBytes, 500)
  assert.strictEqual(diskUsage.categories.find(item => item.id === 'logs').bytes, 720)
  assert.throws(() => manager.maintainCodexDisk(diskOptions), /需要用户确认/)

  let diskStopCalled = 0
  let diskRestartCalled = 0
  const diskMaintenance = manager.maintainCodexDisk({
    ...diskOptions,
    confirmed: true,
    forceWindowsMaintenance: true,
    stopClients: () => {
      diskStopCalled += 1
      return { ok: true, stopped: 3, remaining: [] }
    },
    restartClient: () => {
      diskRestartCalled += 1
      return { ok: true, target: 'ChatGPT.exe', targets: ['ChatGPT.exe'], appId: null }
    }
  })

  assert.strictEqual(diskStopCalled, 1)
  assert.strictEqual(diskRestartCalled, 1)
  assert.strictEqual(diskMaintenance.ok, true)
  assert.strictEqual(diskMaintenance.removedBytes, 1020)
  assert.strictEqual(diskMaintenance.after.reclaimableBytes, 0)
  assert.strictEqual(fs.existsSync(diskMaintenanceFiles.log), false)
  assert.strictEqual(fs.existsSync(path.dirname(diskMaintenanceFiles.temp)), false)
  assert.strictEqual(fs.existsSync(path.dirname(diskMaintenanceFiles.cache)), false)
  assert.strictEqual(fs.existsSync(diskMaintenanceSession), true)
  assert.strictEqual(fs.existsSync(diskMaintenanceFiles.state), true)
  assert.strictEqual(fs.existsSync(diskMaintenanceFiles.config), true)

  fs.mkdirSync(path.dirname(diskMaintenanceFiles.temp), { recursive: true })
  fs.writeFileSync(diskMaintenanceFiles.temp, Buffer.alloc(25, 1))
  assert.throws(
    () =>
      manager.maintainCodexDisk({
        ...diskOptions,
        confirmed: true,
        forceWindowsMaintenance: true,
        stopClients: () => ({ ok: false, stopped: 0, remaining: ['ChatGPT.exe:123'] }),
        restartClient: () => {
          throw new Error('must not restart')
        }
      }),
    /未删除任何文件/
  )
  assert.strictEqual(fs.existsSync(diskMaintenanceFiles.temp), true)

  await assert.rejects(
    manager._internal.readResponseTextLimited({
      headers: { get: name => (name === 'content-length' ? String(64 * 1024 * 1024) : '') }
    }),
    /响应过大/
  )

  const emptyCatalogPath = path.join(tempRoot, 'empty-models-cache.json')
  const nativeCatalogFixturePath = path.join(tempRoot, 'native-models-fixture.json')

  fs.writeFileSync(
    nativeCatalogFixturePath,
    `${JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          visibility: 'list',
          priority: 1,
          shell_type: 'shell_command',
          tool_mode: 'code_mode',
          base_instructions: originalCodexInstructions,
          model_messages: { instructions_template: originalCodexInstructions }
        }
      ]
    })}\n`,
    'utf8'
  )
  manager._internal.writeChannelModelCatalog(emptyCatalogPath, ['grok-4.5'], [nativeCatalogFixturePath])
  const emptyCatalogModel = JSON.parse(fs.readFileSync(emptyCatalogPath, 'utf8')).models[0]

  assert.strictEqual(emptyCatalogModel.slug, 'gpt-5.6-sol')
  assert.strictEqual(emptyCatalogModel.display_name, 'grok-4.5')
  assert.strictEqual(emptyCatalogModel.minimal_client_version, '0.0.1')
  assert.match(emptyCatalogModel.description, /grok-chat/)
  assert.match(emptyCatalogModel.base_instructions, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
  assert.match(emptyCatalogModel.base_instructions, /agent based on Grok 4\.5/)
  assert.match(emptyCatalogModel.base_instructions, /selected_upstream_model_id="grok-4\.5"/)
  assert.match(emptyCatalogModel.base_instructions, /does not prescribe a canned identity answer/)
  assert.doesNotMatch(emptyCatalogModel.base_instructions, /based on GPT-5/)
  assert.match(emptyCatalogModel.model_messages?.instructions_template, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
  assert.deepStrictEqual(emptyCatalogModel.truncation_policy, { mode: 'tokens', limit: 10000 })
  assert.strictEqual(emptyCatalogModel.apply_patch_tool_type, 'freeform')
  assert.strictEqual(emptyCatalogModel.shell_type, 'shell_command')
  assert.strictEqual(emptyCatalogModel.tool_mode, 'code_mode')
  assert.strictEqual(emptyCatalogModel.default_reasoning_level, 'high')
  assert.deepStrictEqual(
    emptyCatalogModel.supported_reasoning_levels.map(item => item.effort),
    ['low', 'medium', 'high']
  )

  const saved = manager.saveRelay(
    {
      name: 'Acme Relay',
      baseUrl: 'https://relay.example.com/v1/',
      apiKey: 'sk-test-123456',
      model: 'gpt-5-mini',
      wireApi: 'responses'
    },
    options
  )

  assert.strictEqual(saved.channel.id, 'acme-relay')
  assert.strictEqual(saved.channel.baseUrl, 'https://relay.example.com/v1')

  process.env.CODEX_MM_ACME_RELAY_API_KEY = 'sk-test-123456'
  const applied = manager.applyRelay('acme-relay', options)
  assert.strictEqual(applied.status.currentProvider, 'acme-relay')
  assert.strictEqual(applied.status.isDefaultProvider, false)
  assert.strictEqual(applied.status.currentModel, 'gpt-5-mini')
  assert.strictEqual(applied.status.providers.find(provider => provider.id === 'acme-relay').active, true)
  assert.ok(applied.status.projects.some(project => project.path === projectDir.toLowerCase()))
  assert.ok(applied.status.sessions.some(session => session.id === 'test-session'))
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'redacted' },
    last_refresh: '2026-06-25T00:00:00.000Z'
  })
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))
      .models.filter(model => model.visibility === 'list')
      .map(model => model.slug),
    ['gpt-5.6-sol']
  )
  const appliedCatalog = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))
  const appliedCatalogModel = appliedCatalog.models.find(
    model => model.manager_actual_model === 'gpt-5-mini' && model.visibility === 'list'
  )

  assert.ok(appliedCatalog.models.some(model => model.slug === 'codex-auto-review'))
  assert.ok(appliedCatalog.models.some(model => model.slug === 'gpt-5-mini' && model.visibility === 'hide'))
  assert.match(appliedCatalogModel.base_instructions, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
  assert.match(appliedCatalogModel.base_instructions, /agent based on GPT-5 mini/)
  assert.match(appliedCatalogModel.base_instructions, /selected_upstream_model_id="gpt-5-mini"/)
  assert.doesNotMatch(appliedCatalogModel.base_instructions, /based on GPT-5\./)
  assert.match(appliedCatalogModel.model_messages.instructions_template, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
  assert.strictEqual(appliedCatalogModel.shell_type, 'disabled')
  assert.strictEqual(appliedCatalogModel.tool_mode, 'code_mode_only')

  manager._internal.writeChannelModelCatalog(modelsCachePath, ['gpt-5-mini', 'grok-4.5'])
  const expandedCatalog = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))

  assert.deepStrictEqual(
    expandedCatalog.models.filter(model => model.visibility === 'list').map(model => model.slug),
    ['gpt-5.6-sol', 'gpt-5.6-terra']
  )
  assert.ok(expandedCatalog.models.some(model => model.slug === 'gpt-5-mini' && model.visibility === 'hide'))
  assert.ok(expandedCatalog.models.some(model => model.slug === 'grok-4.5' && model.visibility === 'hide'))
  assert.ok(expandedCatalog.models.some(model => model.slug === 'codex-auto-review' && model.visibility === 'hide'))

  const activeConfig = fs.readFileSync(options.configPath, 'utf8')
  const parsedActiveConfig = manager._internal.parseConfig(activeConfig)
  assert.strictEqual(parsedActiveConfig.model_catalog_json, modelsCachePath)
  assert.strictEqual(parsedActiveConfig.features.shell_tool, true)
  assert.strictEqual(parsedActiveConfig.model_provider, 'openai')
  assert.strictEqual(parsedActiveConfig.openai_base_url, 'http://127.0.0.1:47891/v1/acme-relay')
  assert.strictEqual(parsedActiveConfig.preferred_auth_method, undefined)
  assert.strictEqual(parsedActiveConfig.model_providers?.['acme-relay'], undefined)
  assert.doesNotMatch(activeConfig, /env_key = "CODEX_MM_ACME_RELAY_API_KEY"/)
  assert.doesNotMatch(activeConfig, /sk-test-123456/)

  const refreshedProxy = manager.refreshManagedProviderProxyBaseUrl({
    ...options,
    proxyBaseUrl: 'http://127.0.0.1:53123'
  })
  const refreshedProxyConfig = manager._internal.parseConfig(fs.readFileSync(options.configPath, 'utf8'))

  assert.strictEqual(refreshedProxy.updated, true)
  assert.strictEqual(refreshedProxy.providerId, 'acme-relay')
  assert.strictEqual(refreshedProxyConfig.model_provider, 'openai')
  assert.strictEqual(refreshedProxyConfig.openai_base_url, 'http://127.0.0.1:53123/v1/acme-relay')
  assert.ok(manager.readStatus(options).projects.some(project => project.path === projectDir.toLowerCase()))
  assert.ok(manager.readStatus(options).sessions.some(session => session.id === 'test-session'))
  assert.strictEqual(
    manager.refreshManagedProviderProxyBaseUrl({ ...options, proxyBaseUrl: 'http://127.0.0.1:53123' }).updated,
    false
  )

  let legacyManagedConfig = fs.readFileSync(options.configPath, 'utf8')

  legacyManagedConfig = manager._internal.removeRootKey(legacyManagedConfig, 'openai_base_url')
  legacyManagedConfig = manager._internal.setRootKey(legacyManagedConfig, 'model_provider', 'acme-relay')
  legacyManagedConfig += [
    '',
    '[model_providers.acme-relay]',
    'name = "Acme Relay"',
    'base_url = "http://127.0.0.1:47891/v1/acme-relay"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join('\n')
  fs.writeFileSync(options.configPath, legacyManagedConfig, 'utf8')
  const migratedLegacyProvider = manager.refreshManagedProviderProxyBaseUrl({
    ...options,
    proxyBaseUrl: 'http://127.0.0.1:53123'
  })
  const migratedLegacyConfig = manager._internal.parseConfig(fs.readFileSync(options.configPath, 'utf8'))

  assert.strictEqual(migratedLegacyProvider.updated, true)
  assert.strictEqual(migratedLegacyProvider.reason, 'migrated-to-stable-openai-provider')
  assert.strictEqual(migratedLegacyConfig.model_provider, 'openai')
  assert.strictEqual(migratedLegacyConfig.openai_base_url, 'http://127.0.0.1:53123/v1/acme-relay')
  assert.strictEqual(migratedLegacyConfig.model_providers?.['acme-relay'], undefined)

  const activationProgress = []
  const activated = await manager.activateRelay('acme-relay', 'gpt-5-mini', {
    ...options,
    proxyBaseUrl: 'http://127.0.0.1:53124',
    codexCliPath: 'test-codex.exe',
    loginWithApiKey: true,
    restartCodex: true,
    onProgress: progress => activationProgress.push(progress),
    restartOptions: {
      launchTargets: {
        targets: ['C:\\Program Files\\OpenAI\\ChatGPT.exe'],
        appLaunchers: []
      }
    },
    runAppServerRequest: async () => {
      throw new Error('切换渠道时不应自动扫描会话索引')
    }
  })
  const activatedConfig = manager._internal.parseConfig(fs.readFileSync(options.configPath, 'utf8'))

  assert.strictEqual(activated.restart.ok, true)
  assert.strictEqual(activated.restart.dryRun, true)
  assert.strictEqual(activated.authLogin.skipped, false)
  assert.strictEqual(activated.authLogin.preservedChatGptTokens, true)
  assert.strictEqual(activated.timings.totalMs >= activated.timings.applyMs, true)
  assert.strictEqual(activated.conversationIndexRepairBefore, null)
  assert.strictEqual(activated.conversationIndexRepair, null)
  assert.deepStrictEqual(
    activationProgress.map(progress => progress.stage),
    [
      'preparing',
      'reading-config',
      'backing-up',
      'configuring-login',
      'building-model-catalog',
      'configuration-written',
      'configured',
      'locating-client',
      'client-ready',
      'refreshing-status',
      'complete'
    ]
  )
  assert.ok(
    activationProgress.every(
      (progress, index) => index === 0 || progress.progress >= activationProgress[index - 1].progress
    )
  )
  assert.strictEqual(activationProgress.at(-1).progress, 100)
  assert.strictEqual(activationProgress.at(-1).status, 'success')
  assert.strictEqual(activatedConfig.model_provider, 'openai')
  assert.strictEqual(activatedConfig.openai_base_url, 'http://127.0.0.1:53124/v1/acme-relay')
  assert.strictEqual(activatedConfig.model_providers?.['acme-relay'], undefined)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {
    auth_mode: 'apikey',
    tokens: { access_token: 'redacted' },
    last_refresh: '2026-06-25T00:00:00.000Z',
    OPENAI_API_KEY: 'sk-test-123456'
  })
  assert.ok(activated.status.projects.some(project => project.path === projectDir.toLowerCase()))
  assert.ok(activated.status.sessions.some(session => session.id === 'test-session'))

  const restored = manager.restoreDefaultProvider(options)
  assert.strictEqual(restored.status.currentProvider, 'openai')
  assert.ok(restored.status.projects.some(project => project.path === projectDir.toLowerCase()))
  assert.ok(restored.status.sessions.some(session => session.id === 'test-session'))
  assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).auth_mode, 'chatgpt')
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))
      .models.filter(model => model.visibility === 'list')
      .map(model => model.slug),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  )

  const restoredConfig = fs.readFileSync(options.configPath, 'utf8')
  assert.doesNotMatch(restoredConfig, /model_provider =/)
  assert.doesNotMatch(restoredConfig, /openai_base_url/)
  assert.doesNotMatch(restoredConfig, /model_catalog_json/)
  assert.match(restoredConfig, /\[features\]/)

  const initialRestored = manager.restoreInitialBackup(options)
  assert.strictEqual(initialRestored.status.currentProvider, 'builtin-relay')
  assert.match(fs.readFileSync(options.configPath, 'utf8'), /model_provider = "builtin-relay"/)
  assert.strictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')).auth_mode, 'chatgpt')
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))
      .models.filter(model => model.visibility === 'list')
      .map(model => model.slug),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  )

  assert.throws(() => manager.removeRelay('builtin-relay', options), /来自 Codex 配置/)

  const removed = manager.removeRelay('acme-relay', options)
  assert.strictEqual(
    removed.providers.some(provider => provider.id === 'acme-relay'),
    false
  )
  assert.doesNotMatch(fs.readFileSync(options.configPath, 'utf8'), /\[model_providers\.acme-relay\]/)

  const multi = manager.saveRelay(
    {
      name: 'Multi Relay',
      baseUrl: 'https://multi.example.com/v1',
      apiKey: 'AIza-test-key',
      model: 'claude-sonnet-5',
      models: ['claude-sonnet-5', 'grok-4.5', 'gemini-3.5-flash'],
      wireApi: 'chat'
    },
    options
  )

  assert.deepStrictEqual(multi.channel.models, ['claude-sonnet-5', 'grok-4.5', 'gemini-3.5-flash'])
  assert.strictEqual(multi.channel.testStatus, null)
  assert.deepStrictEqual(
    manager._internal.modelWireApiMap({
      keySource: 'newapi',
      wireApi: 'chat',
      models: ['gpt-dynamic-responses', 'grok-dynamic-chat', 'provider-specific-model'],
      modelTests: {
        'gpt-dynamic-responses': { wireApi: 'responses' }
      }
    }),
    {
      'gpt-dynamic-responses': 'responses',
      'grok-dynamic-chat': 'chat'
    }
  )

  process.env.CODEX_MM_MULTI_RELAY_API_KEY = 'AIza-test-key'
  const originalFetch = global.fetch
  const testedModels = []
  const gpt56ProbeBodies = []
  let gpt56TransientFailures = 0

  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const requestedModel = body.model
    const requestedUrl = String(_url)
    const hasToolResult = Array.isArray(body.messages) && body.messages.some(message => message.role === 'tool')

    if (requestedModel === 'grok-no-channel') {
      testedModels.push(`${requestedModel}:${requestedUrl.endsWith('/responses') ? 'responses' : 'chat'}`)

      return {
        ok: false,
        status: 503,
        text: async () =>
          JSON.stringify({
            error: { message: 'No available channel for model grok-no-channel under group default' }
          })
      }
    }

    if (requestedUrl.endsWith('/responses')) {
      testedModels.push(`${requestedModel}:responses`)

      if (
        requestedModel === 'gpt-responses-only' ||
        requestedModel === 'gpt-responses-terminal-only' ||
        requestedModel === 'gpt-5.6-sol'
      ) {
        const responseInput = Array.isArray(body.input) ? body.input : []
        const hasFunctionOutput = responseInput.some(item => item?.type === 'function_call_output')
        const hasFunctionTools = Array.isArray(body.tools) && body.tools.some(tool => tool?.type === 'function')

        if (requestedModel === 'gpt-5.6-sol') gpt56ProbeBodies.push(body)

        if (
          requestedModel === 'gpt-5.6-sol' &&
          !hasFunctionOutput &&
          !hasFunctionTools &&
          gpt56TransientFailures === 0
        ) {
          gpt56TransientFailures += 1

          return {
            ok: true,
            status: 200,
            text: async () =>
              [
                `data: ${JSON.stringify({
                  type: 'response.created',
                  response: { status: 'in_progress', model: requestedModel }
                })}`,
                `data: ${JSON.stringify({
                  type: 'error',
                  code: 'server_is_overloaded',
                  message: 'Our servers are currently overloaded. Please try again later.'
                })}`,
                `data: ${JSON.stringify({
                  type: 'response.failed',
                  response: {
                    status: 'failed',
                    model: requestedModel,
                    error: { code: 'server_is_overloaded', type: 'service_unavailable_error' }
                  }
                })}`,
                ''
              ].join('\n\n')
          }
        }

        if (hasFunctionOutput) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              [
                `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'CODEX_TOOL_LOOP_OK' })}`,
                `data: ${JSON.stringify({
                  type: 'response.output_item.done',
                  item: {
                    id: 'msg_probe_done',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'CODEX_TOOL_LOOP_OK' }]
                  }
                })}`,
                `data: ${JSON.stringify({
                  type: 'response.completed',
                  response: {
                    model: `${requestedModel}-build`,
                    output: [
                      {
                        id: 'msg_probe_done',
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'CODEX_TOOL_LOOP_OK' }]
                      }
                    ]
                  }
                })}`,
                'data: [DONE]',
                ''
              ].join('\n\n')
          }
        }

        if (hasFunctionTools) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              [
                `data: ${JSON.stringify({
                  type: 'response.output_item.done',
                  item: {
                    id: 'fc_probe',
                    type: 'function_call',
                    call_id: 'call_probe',
                    name: 'codex_local_tool_probe',
                    arguments: '{"ack":"OK"}'
                  }
                })}`,
                `data: ${JSON.stringify({
                  type: 'response.completed',
                  response: {
                    model: `${requestedModel}-build`,
                    output: [
                      {
                        id: 'fc_probe',
                        type: 'function_call',
                        call_id: 'call_probe',
                        name: 'codex_local_tool_probe',
                        arguments: '{"ack":"OK"}'
                      }
                    ]
                  }
                })}`,
                'data: [DONE]',
                ''
              ].join('\n\n')
          }
        }

        if (requestedModel === 'gpt-responses-terminal-only') {
          return {
            ok: true,
            status: 200,
            text: async () =>
              [
                `data: ${JSON.stringify({
                  type: 'response.output_item.done',
                  item: {
                    id: 'msg_terminal_only',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'OK' }]
                  }
                })}`,
                `data: ${JSON.stringify({
                  type: 'response.completed',
                  response: {
                    model: `${requestedModel}-build`,
                    output: [
                      {
                        id: 'msg_terminal_only',
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'OK' }]
                      }
                    ]
                  }
                })}`,
                ''
              ].join('\n\n')
          }
        }

        return {
          ok: true,
          status: 200,
          text: async () =>
            [
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'OK',
                response: { model: `${requestedModel}-build` }
              })}`,
              `data: ${JSON.stringify({
                type: 'response.completed',
                response: { model: `${requestedModel}-build` }
              })}`,
              'data: [DONE]',
              ''
            ].join('\n\n')
        }
      }

      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { message: 'responses endpoint not supported' } })
      }
    }

    testedModels.push(
      `${requestedModel}:${hasToolResult ? 'tool-result' : body.tools ? 'tool' : body.stream ? 'stream' : 'chat'}`
    )

    if (
      requestedModel === 'gpt-responses-only' ||
      requestedModel === 'gpt-responses-terminal-only' ||
      requestedModel === 'gpt-5.6-sol'
    ) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { message: 'chat/completions endpoint not supported' } })
      }
    }

    if (hasToolResult) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'chatcmpl-tool-result-test',
            object: 'chat.completion',
            model: `${requestedModel}-build`,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'CODEX_TOOL_LOOP_OK' },
                finish_reason: 'stop'
              }
            ]
          })
      }
    }

    if (requestedModel === 'grok-auto-tool-broken' && body.tools && body.tool_choice === 'auto') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'chatcmpl-auto-tool-broken',
            object: 'chat.completion',
            model: `${requestedModel}-build`,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'I cannot use local tools.' },
                finish_reason: 'stop'
              }
            ]
          })
      }
    }

    if (body.tools) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'chatcmpl-tool-test',
            object: 'chat.completion',
            model: `${requestedModel}-build`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_probe',
                      type: 'function',
                      function: { name: 'codex_local_tool_probe', arguments: '{"ack":"OK"}' }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })
      }
    }

    if (requestedModel === 'grok-stream-broken' && body.stream) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: 'not an SSE stream' }) }
    }

    if (requestedModel === 'grok-chat-broken' && !body.stream) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: 'not a chat completion' }) }
    }

    if (body.stream) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream-test',
            object: 'chat.completion.chunk',
            model: `${requestedModel}-build`,
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }]
          })}\n\ndata: [DONE]\n\n`
      }
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: `${requestedModel}-build`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
        })
    }
  }

  try {
    const streamBlocked = await manager.testRelay(
      {
        name: 'Broken Stream',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'grok-stream-broken',
        models: ['grok-stream-broken'],
        wireApi: 'chat'
      },
      options
    )

    assert.strictEqual(streamBlocked.ok, false)
    assert.strictEqual(streamBlocked.chatOk, true)
    assert.strictEqual(streamBlocked.streamOk, false)
    testedModels.length = 0

    const streamOnlyReady = await manager.testRelay(
      {
        name: 'Stream Only',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'grok-chat-broken',
        models: ['grok-chat-broken'],
        wireApi: 'chat'
      },
      options
    )

    assert.strictEqual(streamOnlyReady.ok, false)
    assert.strictEqual(streamOnlyReady.chatOk, false)
    assert.strictEqual(streamOnlyReady.streamOk, false)
    testedModels.length = 0

    const noChannel = await manager.testRelay(
      {
        name: 'Unavailable NewAPI Route',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'grok-no-channel',
        models: ['grok-no-channel'],
        wireApi: 'chat'
      },
      options
    )

    assert.strictEqual(noChannel.ok, false)
    assert.strictEqual(noChannel.status, 503)
    assert.match(noChannel.message, /NewAPI 上游无可用渠道/)
    assert.match(noChannel.message, /不是本地 Agent Loop 故障/)
    testedModels.length = 0

    const responsesOnlyReady = await manager.testRelay(
      {
        name: 'Responses Only',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'gpt-responses-only',
        models: ['gpt-responses-only'],
        wireApi: 'chat'
      },
      options
    )

    assert.strictEqual(responsesOnlyReady.ok, true)
    assert.strictEqual(responsesOnlyReady.chatOk, true)
    assert.strictEqual(responsesOnlyReady.streamOk, true)
    assert.strictEqual(responsesOnlyReady.agentToolOk, true)
    assert.strictEqual(responsesOnlyReady.wireApi, 'responses')
    assert.strictEqual(responsesOnlyReady.actualModel, 'gpt-responses-only-build')
    assert.deepStrictEqual(testedModels, [
      'gpt-responses-only:responses',
      'gpt-responses-only:responses',
      'gpt-responses-only:responses'
    ])
    testedModels.length = 0

    const terminalOnlyReady = await manager.testRelay(
      {
        name: 'Responses Terminal Events',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'gpt-responses-terminal-only',
        models: ['gpt-responses-terminal-only'],
        wireApi: 'responses'
      },
      options
    )

    assert.strictEqual(terminalOnlyReady.ok, true)
    assert.strictEqual(terminalOnlyReady.chatOk, true)
    assert.strictEqual(terminalOnlyReady.streamOk, true)
    assert.strictEqual(terminalOnlyReady.agentToolOk, true)
    assert.strictEqual(terminalOnlyReady.wireApi, 'responses')
    assert.strictEqual(terminalOnlyReady.actualModel, 'gpt-responses-terminal-only-build')
    assert.deepStrictEqual(testedModels, [
      'gpt-responses-terminal-only:responses',
      'gpt-responses-terminal-only:responses',
      'gpt-responses-terminal-only:responses'
    ])
    testedModels.length = 0
    gpt56ProbeBodies.length = 0

    const gpt56Ready = await manager.testRelay(
      {
        name: 'GPT 5.6 Sol Responses',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-test-key',
        model: 'gpt-5.6-sol',
        models: ['gpt-5.6-sol'],
        wireApi: 'responses'
      },
      options
    )

    assert.strictEqual(gpt56Ready.ok, true)
    assert.strictEqual(gpt56Ready.chatOk, true)
    assert.strictEqual(gpt56Ready.streamOk, true)
    assert.strictEqual(gpt56Ready.agentToolOk, true)
    assert.strictEqual(gpt56Ready.wireApi, 'responses')
    assert.strictEqual(gpt56Ready.actualModel, 'gpt-5.6-sol-build')
    assert.strictEqual(gpt56TransientFailures, 1)
    assert.strictEqual(gpt56ProbeBodies.length, 4)
    for (const body of gpt56ProbeBodies) {
      assert.strictEqual(body.stream, true)
      assert.strictEqual(body.max_output_tokens, DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS)
      assert.deepStrictEqual(body.reasoning, { effort: 'low' })
    }
    assert.deepStrictEqual(testedModels, [
      'gpt-5.6-sol:responses',
      'gpt-5.6-sol:responses',
      'gpt-5.6-sol:responses',
      'gpt-5.6-sol:responses'
    ])
    testedModels.length = 0

    const keyWithThreeModels = manager.saveRelay(
      {
        name: 'Three Model Key',
        baseUrl: 'https://multi.example.com/v1',
        apiKey: 'AIza-three-model-test',
        model: 'grok-4.5',
        models: ['gpt-5.5', 'gpt-5.6-sol', 'grok-4.5'],
        wireApi: 'chat'
      },
      options
    )

    process.env[keyWithThreeModels.channel.envKey] = 'AIza-three-model-test'
    const testedThreeModels = await manager.testSavedRelay(keyWithThreeModels.channel.id, options)
    const testedThreeProvider = testedThreeModels.status.providers.find(
      provider => provider.id === keyWithThreeModels.channel.id
    )

    assert.strictEqual(testedThreeModels.test.ok, true)
    assert.deepStrictEqual(
      testedThreeModels.tests.map(test => test.model),
      ['gpt-5.5', 'gpt-5.6-sol', 'grok-4.5']
    )
    assert.deepStrictEqual(Object.keys(testedThreeProvider.modelTests), ['gpt-5.5', 'gpt-5.6-sol', 'grok-4.5'])
    assert.ok(Object.values(testedThreeProvider.modelTests).every(test => test.ok === true))
    const appliedThreeModels = manager.applyRelay(keyWithThreeModels.channel.id, 'grok-4.5', {
      ...options,
      skipChannelTest: false
    })
    const threeModelRuntime = manager.getRelayRuntime(keyWithThreeModels.channel.id, options)
    const threeModelCatalog = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8')).models.filter(
      model => model.visibility === 'list'
    )

    assert.strictEqual(appliedThreeModels.modelCatalog.models.length, 3)
    assert.deepStrictEqual(threeModelRuntime.models, ['gpt-5.5', 'gpt-5.6-sol', 'grok-4.5'])
    assert.strictEqual(Object.keys(threeModelRuntime.modelAliases).length, 3)
    assert.deepStrictEqual(
      threeModelCatalog.map(model => model.display_name),
      ['gpt-5.5', 'gpt-5.6-sol', 'grok-4.5']
    )
    testedModels.length = 0

    const tested = await manager.testSavedRelay('multi-relay', options)

    assert.strictEqual(tested.test.ok, true)
    assert.strictEqual(tested.test.chatOk, true)
    assert.strictEqual(tested.test.streamOk, true)
    assert.strictEqual(tested.test.agentToolOk, true)
    assert.deepStrictEqual(testedModels, ['grok-4.5:chat', 'grok-4.5:stream', 'grok-4.5:tool', 'grok-4.5:tool-result'])
    assert.strictEqual(tested.tests.length, 1)
    assert.strictEqual(
      tested.status.providers.find(provider => provider.id === 'multi-relay').modelTests['claude-sonnet-5'],
      undefined
    )
    assert.strictEqual(
      tested.status.providers.find(provider => provider.id === 'multi-relay').modelTests['gemini-3.5-flash'],
      undefined
    )
    assert.ok(tested.status.providers.find(provider => provider.id === 'multi-relay').modelTests['grok-4.5'].ok)
    assert.strictEqual(
      tested.status.providers.find(provider => provider.id === 'multi-relay').modelTests['grok-4.5'].actualModel,
      'grok-4.5-build'
    )

    const appliedMulti = manager.applyRelay('multi-relay', 'grok-4.5', { ...options, skipChannelTest: false })

    assert.strictEqual(appliedMulti.status.currentProvider, 'multi-relay')
    assert.strictEqual(appliedMulti.status.currentModel, 'grok-4.5')
    assert.match(fs.readFileSync(options.configPath, 'utf8'), /model = "gpt-5\.6-sol"/)
    const multiConfig = manager._internal.parseConfig(fs.readFileSync(options.configPath, 'utf8'))

    assert.strictEqual(multiConfig.model_provider, 'openai')
    assert.strictEqual(multiConfig.openai_base_url, 'http://127.0.0.1:47891/v1/multi-relay')
    assert.strictEqual(multiConfig.model_providers?.['multi-relay'], undefined)
    assert.strictEqual(multiConfig.sandbox_mode, 'danger-full-access')
    assert.strictEqual(multiConfig.approval_policy, 'on-request')
    assert.strictEqual(multiConfig.features.shell_tool, true)
    assert.strictEqual(multiConfig.model_reasoning_effort, undefined)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'redacted' },
      last_refresh: '2026-06-25T00:00:00.000Z'
    })
    assert.strictEqual(manager.getRelayApiKey('multi-relay', options).apiKey, 'AIza-test-key')
    const multiRuntime = manager.getRelayRuntime('multi-relay', options)

    assert.strictEqual(multiRuntime.id, 'multi-relay')
    assert.strictEqual(multiRuntime.baseUrl, 'https://multi.example.com/v1')
    assert.strictEqual(multiRuntime.apiKey, 'AIza-test-key')
    assert.deepStrictEqual(multiRuntime.models, ['grok-4.5'])
    assert.deepStrictEqual(multiRuntime.allModels, ['claude-sonnet-5', 'grok-4.5', 'gemini-3.5-flash'])
    assert.deepStrictEqual(multiRuntime.modelAliases, { 'gpt-5.6-sol': 'grok-4.5' })
    assert.strictEqual(multiRuntime.modelCapabilities['claude-sonnet-5'].available, false)
    assert.strictEqual(multiRuntime.modelCapabilities['grok-4.5'].available, true)
    assert.deepStrictEqual(multiRuntime.modelWireApis, { 'grok-4.5': 'chat' })
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'))
        .models.filter(model => model.visibility === 'list')
        .map(model => model.slug),
      ['gpt-5.6-sol']
    )
    const generatedGrokModel = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8')).models.find(
      model => model.manager_actual_model === 'grok-4.5' && model.visibility === 'list'
    )

    assert.strictEqual(generatedGrokModel.display_name, 'grok-4.5')
    assert.match(generatedGrokModel.description, /grok-chat/)
    assert.match(generatedGrokModel.base_instructions, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
    assert.match(generatedGrokModel.base_instructions, /agent based on Grok 4\.5/)
    assert.match(generatedGrokModel.base_instructions, /respond in your own words/)
    assert.doesNotMatch(generatedGrokModel.base_instructions, /based on GPT-5/)
    assert.match(generatedGrokModel.model_messages?.instructions_template, /ORIGINAL_CODEX_CAPABILITY_MARKER/)
    assert.strictEqual(generatedGrokModel.shell_type, 'disabled')
    assert.strictEqual(generatedGrokModel.tool_mode, 'code_mode_only')
    assert.deepStrictEqual(
      generatedGrokModel.supported_reasoning_levels.map(item => item.effort),
      ['low', 'medium', 'high']
    )
  } finally {
    global.fetch = originalFetch
  }

  const originalFetchForManualRefresh = global.fetch

  global.fetch = async (url, init = {}) => {
    assert.strictEqual(String(url), 'https://multi.example.com/v1/models')
    assert.strictEqual(init.method, 'GET')
    assert.strictEqual(init.headers?.authorization, 'Bearer AIza-test-key')

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'grok-4.5' }, { id: 'grok-4.5-fast' }] })
    }
  }

  try {
    const refreshedManual = await manager.refreshNewApiChannel('multi-relay', options)
    const refreshedProvider = refreshedManual.status.providers.find(provider => provider.id === 'multi-relay')

    assert.strictEqual(refreshedManual.refreshedKeys, false)
    assert.strictEqual(refreshedManual.modelCount, 2)
    assert.deepStrictEqual(refreshedProvider.models, ['grok-4.5', 'grok-4.5-fast'])
    assert.strictEqual(refreshedProvider.model, 'grok-4.5')
    assert.strictEqual(refreshedProvider.testStatus, null)
  } finally {
    global.fetch = originalFetchForManualRefresh
  }

  const freshAuthPath = path.join(tempRoot, 'fresh-auth.json')

  manager._internal.writeApiKeyAuth(freshAuthPath, 'sk-fresh-client')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(freshAuthPath, 'utf8')), {
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'sk-fresh-client'
  })

  const neverLoggedInRoot = path.join(tempRoot, 'never-logged-in')
  const neverLoggedInOptions = {
    codexHome: neverLoggedInRoot,
    configPath: path.join(neverLoggedInRoot, 'config.toml'),
    authPath: path.join(neverLoggedInRoot, 'auth.json'),
    modelsCachePath: path.join(neverLoggedInRoot, 'models_cache.json'),
    nativeModelsPath: nativeCatalogFixturePath,
    stateDir: path.join(neverLoggedInRoot, 'codex-model-manager'),
    skipEnvWrite: true,
    skipChannelTest: true,
    dryRunRestart: true
  }

  fs.mkdirSync(neverLoggedInRoot, { recursive: true })
  const neverLoggedInStatus = manager.readStatus(neverLoggedInOptions)

  assert.strictEqual(neverLoggedInStatus.initialBackup.exists, true)
  assert.strictEqual(neverLoggedInStatus.initialBackup.configExists, false)
  assert.strictEqual(neverLoggedInStatus.initialBackup.authExists, false)
  assert.strictEqual(neverLoggedInStatus.initialBackup.modelsCacheExists, false)

  const neverLoggedInRelay = manager.saveRelay(
    {
      name: 'Fresh Client Relay',
      baseUrl: 'https://fresh.example.com/v1',
      apiKey: 'sk-fresh-client',
      model: 'grok-4.5',
      models: ['grok-4.5'],
      wireApi: 'chat'
    },
    neverLoggedInOptions
  )

  process.env[neverLoggedInRelay.channel.envKey] = 'sk-fresh-client'
  manager.applyRelay(neverLoggedInRelay.channel.id, 'grok-4.5', neverLoggedInOptions)
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.authPath), false)
  assert.ok(fs.existsSync(neverLoggedInOptions.modelsCachePath))

  // Upgrade cleanup: versions before 1.2.16 wrote the relay key into auth.json.
  // A managed custom provider does not require OpenAI auth, so remove only a
  // manager-owned API-key login and leave unrelated/user-created auth untouched.
  fs.writeFileSync(
    neverLoggedInOptions.authPath,
    `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fresh-client' }, null, 2)}\n`,
    'utf8'
  )
  const startupAuthMigration = manager.migrateManagedProviderAuth(neverLoggedInOptions)

  assert.strictEqual(startupAuthMigration.action, 'removed-manager-api-key-auth')
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.authPath), false)

  fs.writeFileSync(
    neverLoggedInOptions.authPath,
    `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fresh-client' }, null, 2)}\n`,
    'utf8'
  )
  manager.applyRelay(neverLoggedInRelay.channel.id, 'grok-4.5', neverLoggedInOptions)
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.authPath), false)

  fs.writeFileSync(
    neverLoggedInOptions.authPath,
    `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'test-api-key-user-owned-unrelated' }, null, 2)}\n`,
    'utf8'
  )
  manager.applyRelay(neverLoggedInRelay.channel.id, 'grok-4.5', neverLoggedInOptions)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(neverLoggedInOptions.authPath, 'utf8')), {
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'test-api-key-user-owned-unrelated'
  })

  const neverLoggedInRestored = manager.restoreInitialBackup(neverLoggedInOptions)

  assert.strictEqual(neverLoggedInRestored.status.currentProvider, 'openai')
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.configPath), false)
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.authPath), false)
  assert.strictEqual(fs.existsSync(neverLoggedInOptions.modelsCachePath), false)
  delete process.env[neverLoggedInRelay.channel.envKey]

  const brokenConfigRoot = path.join(tempRoot, 'broken-config')
  const brokenConfigOptions = {
    codexHome: brokenConfigRoot,
    configPath: path.join(brokenConfigRoot, 'config.toml'),
    authPath: path.join(brokenConfigRoot, 'auth.json'),
    modelsCachePath: path.join(brokenConfigRoot, 'models_cache.json'),
    stateDir: path.join(brokenConfigRoot, 'codex-model-manager')
  }

  fs.mkdirSync(path.join(brokenConfigRoot, 'sessions'), { recursive: true })
  fs.writeFileSync(brokenConfigOptions.configPath, 'model = "broken"\n[bad\n', 'utf8')
  fs.writeFileSync(brokenConfigOptions.modelsCachePath, '{bad json', 'utf8')
  fs.writeFileSync(path.join(brokenConfigRoot, 'sessions', 'keep.jsonl'), '{"type":"session_meta"}\n', 'utf8')
  const configRepair = manager._internal.repairGeneratedCodexFiles(brokenConfigOptions)

  assert.strictEqual(configRepair.repaired, true)
  assert.deepStrictEqual(configRepair.files, ['config.toml', 'models_cache.json'])
  assert.strictEqual(fs.existsSync(brokenConfigOptions.configPath), false)
  assert.strictEqual(fs.existsSync(brokenConfigOptions.modelsCachePath), false)
  assert.strictEqual(fs.existsSync(path.join(brokenConfigRoot, 'sessions', 'keep.jsonl')), true)
  assert.strictEqual(configRepair.backups.length, 2)

  const deleteDataRoot = path.join(tempRoot, 'delete-data')
  const deleteProjectDir = path.join(deleteDataRoot, 'project-delete-me')
  const backfillProjectDir = path.join(deleteDataRoot, 'project-backfill-me')
  const deleteCodexHome = path.join(deleteDataRoot, '.codex')
  const deleteSessionDir = path.join(deleteCodexHome, 'sessions', '2026', '07', '27')
  const deleteDataOptions = {
    codexHome: deleteCodexHome,
    configPath: path.join(deleteCodexHome, 'config.toml'),
    authPath: path.join(deleteCodexHome, 'auth.json'),
    modelsCachePath: path.join(deleteCodexHome, 'models_cache.json'),
    stateDir: path.join(deleteCodexHome, 'codex-model-manager'),
    dryRunRestart: true
  }

  fs.mkdirSync(deleteProjectDir, { recursive: true })
  fs.mkdirSync(backfillProjectDir, { recursive: true })
  fs.mkdirSync(deleteSessionDir, { recursive: true })
  fs.writeFileSync(path.join(deleteProjectDir, 'keep.txt'), 'delete me', 'utf8')
  fs.writeFileSync(
    deleteDataOptions.configPath,
    [
      'model = "gpt-5"',
      '',
      `[projects.'${deleteProjectDir.toLowerCase().replace(/'/g, "''")}']`,
      'trust_level = "trusted"',
      ''
    ].join('\n'),
    'utf8'
  )
  const deleteSessionPath = path.join(deleteSessionDir, 'delete-session.jsonl')
  const backfillSessionPath = path.join(deleteSessionDir, 'backfill-session.jsonl')

  fs.writeFileSync(
    deleteSessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'delete-session', thread_name: 'Delete session', cwd: deleteProjectDir }
    })}\n`,
    'utf8'
  )
  fs.writeFileSync(
    backfillSessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'backfill-session', thread_name: 'Backfill session', cwd: backfillProjectDir }
    })}\n`,
    'utf8'
  )
  const ensuredProjects = manager._internal.ensureProjectsFromSessions(manager.getPaths(deleteDataOptions))

  assert.strictEqual(ensuredProjects.addedProjectCount, 1)
  assert.ok(
    manager.readStatus(deleteDataOptions).projects.some(project => project.path === backfillProjectDir.toLowerCase())
  )
  const deletedConversationData = await manager.deleteConversationData(
    { scope: 'active', projectPath: deleteProjectDir },
    deleteDataOptions
  )

  assert.strictEqual(deletedConversationData.deletedSessionCount, 1)
  assert.strictEqual(deletedConversationData.skippedSessionCount, 0)
  assert.strictEqual(deletedConversationData.deletedProjectCount, 1)
  assert.strictEqual(fs.existsSync(deleteSessionPath), false)
  assert.strictEqual(fs.existsSync(backfillSessionPath), true)
  assert.strictEqual(fs.existsSync(deleteProjectDir), false)
  assert.strictEqual(
    deletedConversationData.status.projects.some(project => project.path === backfillProjectDir.toLowerCase()),
    true
  )
  let busyDeleteAttempts = 0
  let busyDeleteStopCalls = 0
  let deleteIndexDeleteCalls = 0
  let deleteIndexRefreshCalls = 0
  const busyDeletedConversationData = await manager.deleteConversationData(
    { scope: 'active', projectPath: backfillProjectDir },
    {
      ...deleteDataOptions,
      stopClientsOnBusy: true,
      refreshConversationIndex: true,
      codexCliPath: 'test-codex.exe',
      removeSessionFile: targetPath => {
        busyDeleteAttempts += 1
        if (busyDeleteAttempts === 1) throw Object.assign(new Error('file in use'), { code: 'EBUSY' })
        fs.rmSync(targetPath, { force: true })
      },
      stopCodexClients: () => {
        busyDeleteStopCalls += 1
        return { ok: true, stopped: 1, remaining: [] }
      },
      runAppServerRequest: async (_codexPath, method, params) => {
        if (method === 'thread/delete') {
          deleteIndexDeleteCalls += 1
          assert.strictEqual(params.threadId, 'backfill-session')
          return { result: {} }
        }

        deleteIndexRefreshCalls += 1
        assert.strictEqual(method, 'thread/list')
        assert.strictEqual(params.useStateDbOnly, false)
        assert.deepStrictEqual(params.modelProviders, [])
        return { result: { data: [] } }
      }
    }
  )

  assert.strictEqual(busyDeletedConversationData.deletedSessionCount, 1)
  assert.strictEqual(busyDeletedConversationData.skippedSessionCount, 0)
  assert.strictEqual(busyDeletedConversationData.stoppedProcessCount, 1)
  assert.strictEqual(busyDeleteStopCalls, 1)
  assert.strictEqual(busyDeleteAttempts, 2)
  assert.strictEqual(deleteIndexDeleteCalls, 1)
  assert.strictEqual(deleteIndexRefreshCalls, 1)
  assert.strictEqual(busyDeletedConversationData.indexDelete.ok, true)
  assert.strictEqual(busyDeletedConversationData.indexDelete.deletedCount, 1)
  assert.deepStrictEqual(busyDeletedConversationData.indexRefresh, { ok: true, skipped: false })
  assert.strictEqual(fs.existsSync(backfillSessionPath), false)
  assert.strictEqual(fs.existsSync(backfillProjectDir), false)

  const skippedProjectDir = path.join(deleteDataRoot, 'project-keep-on-delete-error')
  const skippedSessionPath = path.join(deleteSessionDir, 'skipped-session.jsonl')

  fs.mkdirSync(skippedProjectDir, { recursive: true })
  fs.writeFileSync(path.join(skippedProjectDir, 'keep.txt'), 'keep me', 'utf8')
  fs.writeFileSync(
    skippedSessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'skipped-session', thread_name: 'Skipped session', cwd: skippedProjectDir }
    })}\n`,
    'utf8'
  )
  const skippedConversationData = await manager.deleteConversationData(
    { scope: 'active', projectPath: skippedProjectDir },
    {
      ...deleteDataOptions,
      stopClientsOnBusy: true,
      removeSessionFile: () => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      },
      stopCodexClients: () => ({ ok: false, stopped: 0, remaining: ['ChatGPT.exe:42'], error: 'still running' })
    }
  )

  assert.strictEqual(skippedConversationData.deletedSessionCount, 0)
  assert.strictEqual(skippedConversationData.skippedSessionCount, 1)
  assert.strictEqual(skippedConversationData.deletedProjectCount, 0)
  assert.strictEqual(skippedConversationData.skippedProjectCount, 1)
  assert.strictEqual(fs.existsSync(skippedSessionPath), true)
  assert.strictEqual(fs.existsSync(skippedProjectDir), true)

  const packageManagementRoot = path.join(tempRoot, 'package-management')
  const currentSkillsPath = path.join(packageManagementRoot, '.agents', 'skills')
  const legacySkillsPath = path.join(packageManagementRoot, '.codex', 'skills')
  const customAgentsPath = path.join(packageManagementRoot, '.codex', 'agents')
  const packageOptions = {
    ...options,
    codexHome: path.join(packageManagementRoot, '.codex'),
    configPath: path.join(packageManagementRoot, '.codex', 'config.toml'),
    stateDir: path.join(packageManagementRoot, 'manager-state'),
    skillsPath: currentSkillsPath,
    legacySkillsPath,
    agentsPath: customAgentsPath
  }
  const validSkillPath = path.join(currentSkillsPath, 'release-helper')
  const invalidLegacySkillPath = path.join(legacySkillsPath, 'broken-skill')

  fs.mkdirSync(validSkillPath, { recursive: true })
  fs.mkdirSync(invalidLegacySkillPath, { recursive: true })
  fs.mkdirSync(customAgentsPath, { recursive: true })
  fs.writeFileSync(
    path.join(validSkillPath, 'SKILL.md'),
    [
      '---',
      'name: release-helper',
      'description: Validate and package releases.',
      '---',
      '',
      'Run release checks.'
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(path.join(invalidLegacySkillPath, 'SKILL.md'), '# missing front matter\n', 'utf8')
  fs.writeFileSync(
    path.join(customAgentsPath, 'reviewer.toml'),
    [
      'name = "reviewer"',
      'description = "Review code changes."',
      'developer_instructions = "Inspect code and report actionable findings."'
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(path.join(customAgentsPath, 'broken.toml'), 'name = "broken"\n', 'utf8')
  fs.mkdirSync(path.join(customAgentsPath, 'old-agent-folder'))
  fs.writeFileSync(path.join(customAgentsPath, 'old-agent-folder', 'AGENTS.md'), '# old format\n', 'utf8')
  const packageStatus = manager.readStatus(packageOptions)
  const currentSkill = packageStatus.skills.find(item => item.path === validSkillPath)
  const invalidLegacySkill = packageStatus.skills.find(item => item.path === invalidLegacySkillPath)
  const validAgent = packageStatus.agents.find(item => item.path === path.join(customAgentsPath, 'reviewer.toml'))
  const invalidAgent = packageStatus.agents.find(item => item.path === path.join(customAgentsPath, 'broken.toml'))
  const oldAgentFolder = packageStatus.agents.find(
    item => item.path === path.join(customAgentsPath, 'old-agent-folder')
  )

  assert.strictEqual(currentSkill.source, 'user')
  assert.strictEqual(currentSkill.valid, true)
  assert.strictEqual(currentSkill.displayName, 'release-helper')
  assert.strictEqual(invalidLegacySkill.source, 'legacy')
  assert.strictEqual(invalidLegacySkill.valid, false)
  assert.match(invalidLegacySkill.message, /front matter/)
  assert.strictEqual(validAgent.valid, true)
  assert.strictEqual(validAgent.displayName, 'reviewer')
  assert.strictEqual(invalidAgent.valid, false)
  assert.match(invalidAgent.message, /description/)
  assert.strictEqual(oldAgentFolder.valid, false)
  assert.match(oldAgentFolder.message, /不会被当前 Codex/)

  const directAgentPath = path.join(packageManagementRoot, 'security-agent.toml')

  fs.writeFileSync(
    directAgentPath,
    [
      'name = "security"',
      'description = "Review security boundaries."',
      'developer_instructions = "Focus on credentials and path safety."'
    ].join('\n'),
    'utf8'
  )
  const importedAgentStatus = manager.importAgentZip(directAgentPath, packageOptions)

  assert.strictEqual(
    importedAgentStatus.agents.some(item => item.path === path.join(customAgentsPath, 'security-agent.toml')),
    true
  )
  const invalidDirectAgentPath = path.join(packageManagementRoot, 'invalid-agent.toml')

  fs.writeFileSync(invalidDirectAgentPath, 'name = "invalid"\n', 'utf8')
  assert.throws(() => manager.importAgentZip(invalidDirectAgentPath, packageOptions), /description/)
  const exportedAgentZip = path.join(packageManagementRoot, 'reviewer-export.zip')
  const invalidAgentZip = path.join(packageManagementRoot, 'broken-agent-export.zip')
  const exportedSkillZip = path.join(packageManagementRoot, 'release-helper.zip')
  const invalidSkillZip = path.join(packageManagementRoot, 'broken-skill-export.zip')

  manager.exportAgent(validAgent.path, exportedAgentZip, packageOptions)
  manager.exportAgent(invalidAgent.path, invalidAgentZip, packageOptions)
  manager.exportSkill(currentSkill.path, exportedSkillZip, packageOptions)
  manager.exportSkill(invalidLegacySkill.path, invalidSkillZip, packageOptions)
  assert.strictEqual(fs.existsSync(exportedAgentZip), true)
  assert.strictEqual(fs.existsSync(invalidAgentZip), true)
  assert.strictEqual(fs.existsSync(exportedSkillZip), true)
  assert.strictEqual(fs.existsSync(invalidSkillZip), true)
  assert.throws(() => manager.importAgentZip(invalidAgentZip, packageOptions), /没有有效的自定义 Agent 配置/)
  assert.throws(() => manager.importSkillZip(invalidSkillZip, packageOptions), /front matter/)
  const reimportedAgentStatus = manager.importAgentZip(exportedAgentZip, packageOptions)

  assert.strictEqual(
    reimportedAgentStatus.agents.some(
      item => item.path === path.join(customAgentsPath, 'reviewer.toml') && item.valid === true
    ),
    true
  )
  const reimportedSkillStatus = manager.importSkillZip(exportedSkillZip, packageOptions)

  assert.strictEqual(
    reimportedSkillStatus.skills.some(item => item.path === path.join(currentSkillsPath, 'release-helper')),
    true
  )

  const directLoginAuthPath = path.join(tempRoot, 'direct-login-auth.json')
  const directLogin = manager._internal.loginFreshClientWithApiKey(
    { authPath: directLoginAuthPath },
    'sk-direct-login',
    { dryRunRestart: false }
  )

  assert.strictEqual(directLogin.reason, 'auth-file-written')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(directLoginAuthPath, 'utf8')), {
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'sk-direct-login'
  })

  const restoredAfterProxy = manager.restoreDefaultProvider(options)

  assert.strictEqual(restoredAfterProxy.status.isDefaultProvider, true)
  assert.strictEqual(
    manager._internal.parseConfig(fs.readFileSync(options.configPath, 'utf8')).model_providers?.['multi-relay'],
    undefined
  )

  assert.strictEqual(
    manager._internal.preferredCodexTarget([
      'C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\version\\codex.exe',
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test\\app\\ChatGPT.exe',
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test\\app\\resources\\codex.exe'
    ]),
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test\\app\\ChatGPT.exe'
  )
  assert.strictEqual(
    manager._internal.codexTargetRank('C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\resources\\codex.exe'),
    9
  )
  assert.strictEqual(
    manager._internal.codexTargetRank('C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\Codex.exe'),
    0
  )
  assert.strictEqual(
    manager._internal.preferredCodexTarget([
      'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe',
      'C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\version\\codex.exe'
    ]),
    'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe'
  )

  const clientEvidenceLocalAppData = path.join(tempRoot, 'client-evidence-local-app-data')
  const clientEvidenceCli = path.join(clientEvidenceLocalAppData, 'OpenAI', 'Codex', 'bin', 'version', 'codex.exe')

  fs.mkdirSync(path.dirname(clientEvidenceCli), { recursive: true })
  fs.writeFileSync(clientEvidenceCli, 'codex-cli', 'utf8')
  assert.deepStrictEqual(
    manager._internal.findCodexQuickInstallationEvidence([], {
      localAppData: clientEvidenceLocalAppData,
      force: true
    }),
    {
      found: true,
      kind: 'local-runtime',
      path: clientEvidenceCli
    }
  )

  const packageEvidenceLocalAppData = path.join(tempRoot, 'package-evidence-local-app-data')
  const packageEvidencePath = path.join(packageEvidenceLocalAppData, 'Packages', 'OpenAI.Codex_test')

  fs.mkdirSync(packageEvidencePath, { recursive: true })
  assert.deepStrictEqual(
    manager._internal.findCodexQuickInstallationEvidence([], {
      localAppData: packageEvidenceLocalAppData,
      force: true
    }),
    {
      found: true,
      kind: 'appx-package-data',
      path: packageEvidencePath
    }
  )

  const aliasLocalAppData = path.join(tempRoot, 'execution-alias-local-app-data')
  const codexExecutionAlias = path.join(aliasLocalAppData, 'Microsoft', 'WindowsApps', 'Codex.exe')

  fs.mkdirSync(path.dirname(codexExecutionAlias), { recursive: true })
  fs.writeFileSync(codexExecutionAlias, 'codex-app-alias', 'utf8')
  assert.ok(
    manager._internal
      .findCodexQuickTargets({ localAppData: aliasLocalAppData, homeDir: tempRoot, force: true })
      .includes(codexExecutionAlias)
  )

  const restartEvents = []
  const restartProgress = []
  const completeRestart = manager.restartCodex({
    forceWindowsRestart: true,
    launchTargets: {
      targets: ['C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe'],
      appLaunchers: []
    },
    stopClients: () => {
      restartEvents.push('stop')
      return { ok: true, stopped: 4, remaining: [] }
    },
    launchTarget: () => restartEvents.push('launch'),
    waitForClient: () => {
      restartEvents.push('wait')
      return true
    },
    onProgress: progress => restartProgress.push(progress)
  })

  assert.strictEqual(completeRestart.ok, true)
  assert.deepStrictEqual(restartEvents, ['stop', 'launch', 'wait'])
  assert.deepStrictEqual(
    restartProgress.map(progress => progress.stage),
    ['locating-client', 'closing-client', 'launching-client', 'waiting-for-client', 'client-ready']
  )
  assert.ok(
    restartProgress.every((progress, index) => index === 0 || progress.progress >= restartProgress[index - 1].progress)
  )

  let blockedRestartLaunched = false
  const blockedRestartProgress = []
  const blockedRestart = manager.restartCodex({
    forceWindowsRestart: true,
    launchTargets: {
      targets: ['C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe'],
      appLaunchers: []
    },
    stopClients: () => ({ ok: false, stopped: 2, remaining: ['ChatGPT.exe:1234'] }),
    launchTarget: () => {
      blockedRestartLaunched = true
    },
    onProgress: progress => blockedRestartProgress.push(progress)
  })

  assert.strictEqual(blockedRestart.ok, false)
  assert.strictEqual(blockedRestartLaunched, false)
  assert.match(blockedRestart.error, /尚未完全关闭/)
  assert.strictEqual(blockedRestartProgress.at(-1).stage, 'close-failed')
  assert.strictEqual(blockedRestartProgress.at(-1).status, 'warning')

  const originalFetchForNewApi = global.fetch
  const newApiRequests = []
  const newApiWorkKeyModels = [
    'gpt-5.6',
    'grok-4.5',
    'claude-sonnet-5',
    'gemini-3.5-flash',
    'deepseek-r1',
    'provider-specific-model'
  ]

  global.fetch = async (url, init = {}) => {
    newApiRequests.push({ url: String(url), init })

    if (String(url).endsWith('/api/user/login')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: { access_token: 'login-access-token', user: { id: 42, username: 'alice' } }
          })
      }
    }

    if (String(url).endsWith('/api/token/batch/keys')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { keys: { 7: 'sk-newapi-full', 8: 'fixture-grok' } } })
      }
    }

    if (String(url).includes('/api/token/')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 7,
                  name: 'Work Key',
                  key: 'sk********1234',
                  status: 1,
                  group: 'default',
                  remain_quota: 1000,
                  unlimited_quota: false,
                  model_limits_enabled: false,
                  model_limits: ''
                },
                {
                  id: 8,
                  name: 'Grok Key',
                  key: 'sk********grok',
                  status: 1,
                  group: 'paid',
                  remain_quota: 2000,
                  unlimited_quota: false,
                  model_limits_enabled: true,
                  model_limits: 'gpt-fake-token-limit'
                }
              ]
            }
          })
      }
    }

    if (String(url).endsWith('/v1/models')) {
      const models =
        init.headers?.authorization === 'Bearer sk-fixture-grok'
          ? [{ id: 'grok-4.5' }]
          : newApiWorkKeyModels.map(id => ({ id }))

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'list', data: models })
      }
    }

    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    const synced = await manager.syncNewApi(
      {
        baseUrl: 'https://newapi.example.com/v1',
        relayBaseUrl: 'https://api.custom.example.com/v1',
        username: 'alice',
        password: 'secret'
      },
      { ...options, skipNewApiWrite: true }
    )

    assert.strictEqual(synced.baseUrl, 'https://newapi.example.com')
    assert.strictEqual(synced.relayBaseUrl, 'https://api.custom.example.com/v1')
    assert.strictEqual(synced.tokens.length, 2)
    assert.strictEqual(synced.tokens[0].apiKey, 'sk-newapi-full')
    assert.strictEqual(synced.tokens[1].apiKey, 'sk-fixture-grok')
    assert.deepStrictEqual(synced.tokens[0].models, newApiWorkKeyModels)
    assert.deepStrictEqual(synced.tokens[1].models, ['grok-4.5'])
    assert.ok(!synced.tokens[1].models.includes('gpt-fake-token-limit'))
    const onlineProviders = manager.readStatus(options).providers.filter(provider => provider.keySource === 'newapi')

    assert.strictEqual(onlineProviders.length, 1)
    assert.strictEqual(onlineProviders[0].name, 'NewAPI 渠道')
    assert.strictEqual(onlineProviders[0].newApi.keys.length, 2)
    assert.strictEqual(onlineProviders[0].newApi.keys[0].keyMask, 'sk-new...full')
    assert.strictEqual(process.env[onlineProviders[0].envKey], 'sk-newapi-full')
    const selectedOnlineKey = await manager.selectNewApiKey(onlineProviders[0].id, 8, options)

    assert.deepStrictEqual(selectedOnlineKey.models, ['grok-4.5'])
    assert.strictEqual(
      selectedOnlineKey.status.providers.find(provider => provider.id === onlineProviders[0].id).newApi.selectedTokenId,
      8
    )
    assert.strictEqual(process.env[onlineProviders[0].envKey], 'sk-newapi-full')
    manager.applyRelay(onlineProviders[0].id, 'grok-4.5', options)
    assert.strictEqual(process.env[onlineProviders[0].envKey], 'sk-fixture-grok')
    const switchedBackToWorkKey = await manager.selectNewApiKey(onlineProviders[0].id, 7, options)

    assert.deepStrictEqual(switchedBackToWorkKey.models, newApiWorkKeyModels)
    assert.strictEqual(
      switchedBackToWorkKey.status.providers.find(provider => provider.id === onlineProviders[0].id).newApi.keys.length,
      2
    )
    const switchedAgainToGrokKey = await manager.selectNewApiKey(onlineProviders[0].id, 8, options)

    assert.deepStrictEqual(switchedAgainToGrokKey.models, ['grok-4.5'])
    assert.strictEqual(
      switchedAgainToGrokKey.status.providers.find(provider => provider.id === onlineProviders[0].id).newApi
        .selectedTokenId,
      8
    )
    assert.ok(newApiRequests.some(request => request.init.headers?.authorization === 'Bearer login-access-token'))
    assert.ok(newApiRequests.some(request => request.init.headers?.authorization === 'Bearer sk-newapi-full'))
    assert.ok(newApiRequests.some(request => request.url === 'https://api.custom.example.com/v1/models'))
    assert.ok(
      newApiRequests.some(
        request =>
          request.init.headers?.['New-Api-User'] === '42' &&
          request.init.headers?.authorization === 'Bearer login-access-token'
      )
    )
    assert.ok(
      newApiRequests.some(
        request =>
          request.init.headers?.['New-Api-User'] === '42' &&
          request.init.headers?.authorization === 'Bearer sk-newapi-full'
      )
    )
  } finally {
    global.fetch = originalFetchForNewApi
  }

  const originalFetchForCookieNewApi = global.fetch
  const cookieNewApiRequests = []

  global.fetch = async (url, init = {}) => {
    cookieNewApiRequests.push({ url: String(url), init })

    if (String(url).endsWith('/api/user/login')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: name => (name.toLowerCase() === 'set-cookie' ? 'new-api-session=session-123; Path=/; HttpOnly' : '')
        },
        text: async () => JSON.stringify({ success: true, message: '', data: { user: { id: 84, username: 'bob' } } })
      }
    }

    if (String(url).endsWith('/api/token/batch/keys')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { keys: { 9: 'sk-cookie-full' } } })
      }
    }

    if (String(url).includes('/api/token/')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: 9,
                  name: 'Cookie Key',
                  key: 'sk********9999',
                  status: 1,
                  group: 'default',
                  model_limits_enabled: true,
                  model_limits: 'gpt-5.6,grok-4.5'
                }
              ]
            }
          })
      }
    }

    if (String(url).endsWith('/v1/models')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6' }, { id: 'grok-4.5' }] })
      }
    }

    throw new Error(`Unexpected cookie request: ${url}`)
  }

  try {
    const synced = await manager.syncNewApi(
      { baseUrl: 'https://cookie-newapi.example.com', username: 'bob', password: 'secret' },
      { ...options, skipNewApiWrite: true }
    )

    assert.strictEqual(synced.baseUrl, 'https://cookie-newapi.example.com')
    assert.strictEqual(synced.tokens[0].apiKey, 'sk-cookie-full')
    assert.deepStrictEqual(synced.tokens[0].models, ['gpt-5.6', 'grok-4.5'])
    assert.ok(cookieNewApiRequests.some(request => request.init.headers?.cookie === 'new-api-session=session-123'))
    assert.ok(
      cookieNewApiRequests.some(
        request =>
          request.init.headers?.['New-Api-User'] === '84' &&
          request.init.headers?.cookie === 'new-api-session=session-123'
      )
    )
    assert.ok(
      cookieNewApiRequests.some(
        request =>
          request.init.headers?.['New-Api-User'] === '84' &&
          request.init.headers?.authorization === 'Bearer sk-cookie-full'
      )
    )
  } finally {
    global.fetch = originalFetchForCookieNewApi
  }

  const imported = manager.importSession(externalSessionPath, options)
  assert.ok(imported.status.sessions.some(session => session.location === 'imported'))
  const duplicateImport = manager.importSession(externalSessionPath, options)

  assert.notStrictEqual(duplicateImport.target, imported.target)
  assert.strictEqual(fs.existsSync(duplicateImport.target), true)
  const invalidSessionPath = path.join(externalDir, 'invalid-session.jsonl')

  fs.writeFileSync(invalidSessionPath, 'not jsonl', 'utf8')
  assert.throws(() => manager.importSession(invalidSessionPath, options), /没有有效的 JSONL 记录/)
  const exportedSessionPath = path.join(tempRoot, 'exports', 'conversation.jsonl')

  fs.mkdirSync(path.dirname(exportedSessionPath), { recursive: true })
  fs.writeFileSync(exportedSessionPath, 'stale export', 'utf8')
  const exportedSession = manager.exportSession(imported.target, exportedSessionPath, options)

  assert.strictEqual(exportedSession.kind, 'session')
  assert.strictEqual(exportedSession.target, exportedSessionPath)
  assert.strictEqual(fs.readFileSync(exportedSessionPath, 'utf8'), fs.readFileSync(imported.target, 'utf8'))
  assert.throws(
    () => manager.exportSession(imported.target, path.join(tempRoot, 'exports', 'conversation.txt'), options),
    /必须导出为 .jsonl/
  )
  assert.throws(() => manager.exportSession(imported.target, imported.target, options), /不能覆盖原始文件/)

  const deletedSession = manager.deleteSession('test-session', options)
  assert.strictEqual(deletedSession.deletedPath, sessionPath)
  assert.strictEqual(fs.existsSync(sessionPath), false)
  assert.strictEqual(fs.existsSync(path.join(options.stateDir, 'trash')), false)

  const deletedArchivedSession = manager.deleteSession('archived-test-session', options)

  assert.strictEqual(deletedArchivedSession.deletedPath, archivedSessionPath)
  assert.strictEqual(fs.existsSync(archivedSessionPath), false)

  const withProject = manager.addProject(projectDir, options)
  assert.ok(withProject.projects.some(project => project.path === projectDir.toLowerCase()))
  const nestedProjectDir = path.join(projectDir, 'nested')

  fs.mkdirSync(nestedProjectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.project-settings'), 'include hidden-looking files', 'utf8')
  fs.writeFileSync(path.join(nestedProjectDir, 'source.txt'), 'nested project file', 'utf8')
  const exportedProjectPath = path.join(tempRoot, 'exports', 'project-a.zip')

  fs.writeFileSync(exportedProjectPath, 'stale archive', 'utf8')
  const exportedProject = await manager.exportProject(projectDir, exportedProjectPath, options)
  const exportedProjectArchive = inspectZip(exportedProjectPath)

  assert.strictEqual(exportedProject.kind, 'project')
  assert.strictEqual(exportedProject.target, exportedProjectPath)
  assert.ok(exportedProjectArchive.entryCount >= 2)
  assert.ok(exportedProjectArchive.totalBytes >= 39)
  await assert.rejects(
    manager.exportProject(projectDir, path.join(projectDir, 'inside.zip'), options),
    /不能保存在项目目录内部/
  )
  await assert.rejects(
    manager.exportProject(
      path.join(tempRoot, 'unknown-project'),
      path.join(tempRoot, 'exports', 'unknown.zip'),
      options
    ),
    /未找到要导出的项目/
  )

  const withoutProject = manager.deleteProject(projectDir.toLowerCase(), options)
  assert.strictEqual(
    withoutProject.projects.some(project => project.path === projectDir.toLowerCase()),
    false
  )

  fs.rmSync(tempRoot, { recursive: true, force: true })
  delete process.env.CODEX_MM_ACME_RELAY_API_KEY
  delete process.env.CODEX_MM_MULTI_RELAY_API_KEY

  console.log('codex manager core tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
