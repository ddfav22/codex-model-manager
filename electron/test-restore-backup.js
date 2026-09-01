const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const manager = require('./codexManager')

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-restore-${name}-`))
  const codexHome = path.join(root, '.codex')
  const stateDir = path.join(codexHome, 'codex-model-manager')
  const options = {
    codexHome,
    stateDir,
    configPath: path.join(codexHome, 'config.toml'),
    authPath: path.join(codexHome, 'auth.json'),
    modelsCachePath: path.join(codexHome, 'models_cache.json'),
    skipEnvWrite: true,
    dryRunRestart: true
  }

  fs.mkdirSync(codexHome, { recursive: true })
  return options
}

// A normal first-run snapshot must restore config.toml byte for byte,
// including the original project tables, while returning to an unauthenticated
// client state (current auth/model/manager files are cleared).
{
  const options = fixture('exact')
  const initialConfig =
    '# untouched Codex config\nmodel = "gpt-5.6"\n\n[projects."C:/Users/test/project"]\ntrust_level = "trusted"\n'
  const initialAuth = '{"auth_mode":"chatgpt","tokens":{"access_token":"redacted"}}\n'
  const initialModels = '{"models":[{"slug":"gpt-5.6","visibility":"list"}]}\n'

  fs.writeFileSync(options.configPath, initialConfig, 'utf8')
  fs.writeFileSync(options.authPath, initialAuth, 'utf8')
  fs.writeFileSync(options.modelsCachePath, initialModels, 'utf8')
  const paths = manager.getPaths(options)
  const captured = manager._internal.ensureInitialBackup(paths, initialConfig)
  fs.writeFileSync(paths.channelsPath, '[{"id":"managed"}]\n', 'utf8')
  fs.writeFileSync(paths.newApiPath, '{"baseUrl":"https://example.invalid"}\n', 'utf8')
  fs.writeFileSync(paths.modelAliasesPath, '{"version":1,"aliases":{"gpt":"gpt-5.6"}}\n', 'utf8')
  fs.writeFileSync(paths.nativeModelsPath, '{"models":[]}\n', 'utf8')
  fs.writeFileSync(paths.globalStatePath, '{"local-projects":{"stale":{}}}\n', 'utf8')
  const stateDbPath = path.join(options.codexHome, 'state_5.sqlite')
  fs.writeFileSync(stateDbPath, 'sqlite-state-fixture', 'utf8')
  const retainedSessionPath = path.join(options.codexHome, 'sessions', '2026', '09', '01', 'rollout-retained.jsonl')
  fs.mkdirSync(path.dirname(retainedSessionPath), { recursive: true })
  fs.writeFileSync(
    retainedSessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 'retained-session',
        thread_name: 'Retained session',
        cwd: path.dirname(retainedSessionPath)
      }
    })}\n`,
    'utf8'
  )
  process.env.CODEX_MM_FIXTURE_API_KEY = 'fixture-only'

  assert.strictEqual(captured.valid, true)
  fs.writeFileSync(options.configPath, 'model_provider = "managed"\n', 'utf8')
  fs.writeFileSync(options.authPath, '{"auth_mode":"apikey"}\n', 'utf8')
  fs.writeFileSync(options.modelsCachePath, '{"models":[]}\n', 'utf8')
  process.env.CODEX_MM_PROXY_BASE_URL = 'http://127.0.0.1:53124'

  const restored = manager.restoreInitialBackup(options)
  assert.strictEqual(fs.readFileSync(options.configPath, 'utf8'), initialConfig)
  assert.strictEqual(fs.existsSync(options.authPath), false)
  assert.strictEqual(fs.existsSync(options.modelsCachePath), false)
  assert.strictEqual(fs.existsSync(paths.channelsPath), false)
  assert.strictEqual(fs.existsSync(paths.newApiPath), false)
  assert.strictEqual(fs.existsSync(paths.modelAliasesPath), false)
  assert.strictEqual(fs.existsSync(paths.globalStatePath), false)
  assert.strictEqual(fs.existsSync(paths.nativeModelsPath), false)
  assert.strictEqual(fs.existsSync(stateDbPath), false)
  assert.strictEqual(fs.existsSync(retainedSessionPath), true, 'fresh reset preserves conversation JSONL by default')
  assert.strictEqual(
    restored.status.sessions.some(session => session.id === 'retained-session'),
    true
  )
  assert.strictEqual(process.env.CODEX_MM_FIXTURE_API_KEY, undefined)
  assert.strictEqual(process.env.CODEX_MM_PROXY_BASE_URL, undefined)
  assert.strictEqual('snapshots' in restored.freshReset, false)
  assert.doesNotMatch(JSON.stringify(restored), /access_token|fixture-only|auth_mode/)
  assert.ok(fs.existsSync(captured.path), 'immutable config snapshot is retained for a future reset')
}

// Auth/model/file snapshots also use one deterministic rolling file each;
// operation labels remain accepted for compatibility but must not multiply
// credential-bearing files on repeated calls.
{
  const options = fixture('rolling-auth-models')
  const authFirst = '{"auth_mode":"apikey","value":1}\n'
  const authSecond = '{"auth_mode":"apikey","value":2}\n'
  const modelsFirst = '{"models":[1]}\n'
  const modelsSecond = '{"models":[2]}\n'

  fs.writeFileSync(options.authPath, authFirst, 'utf8')
  fs.writeFileSync(options.modelsCachePath, modelsFirst, 'utf8')
  const authSnapshot = manager._internal.backupAuth(options.authPath, 'before-one')
  const modelsSnapshot = manager._internal.backupFile(options.modelsCachePath, 'before-one')

  fs.writeFileSync(options.authPath, authSecond, 'utf8')
  fs.writeFileSync(options.modelsCachePath, modelsSecond, 'utf8')
  const authSnapshotAgain = manager._internal.backupAuth(options.authPath, 'before-two')
  const modelsSnapshotAgain = manager._internal.backupFile(options.modelsCachePath, 'before-two')

  assert.strictEqual(authSnapshot.backupPath, `${options.authPath}.bak-codex-manager`)
  assert.strictEqual(modelsSnapshot.backupPath, `${options.modelsCachePath}.bak-codex-manager`)
  assert.strictEqual(authSnapshotAgain.backupPath, authSnapshot.backupPath)
  assert.strictEqual(modelsSnapshotAgain.backupPath, modelsSnapshot.backupPath)
  assert.strictEqual(
    fs.readdirSync(path.dirname(options.authPath)).filter(name => name.startsWith('auth.json.bak-codex-manager'))
      .length,
    1
  )
  assert.strictEqual(
    fs
      .readdirSync(path.dirname(options.modelsCachePath))
      .filter(name => name.startsWith('models_cache.json.bak-codex-manager')).length,
    1
  )
  assert.strictEqual(fs.readFileSync(authSnapshot.backupPath, 'utf8'), authSecond)
  assert.strictEqual(fs.readFileSync(modelsSnapshot.backupPath, 'utf8'), modelsSecond)
}

// An explicit reset must not mutate anything while the official client is
// still running. The injected stopper keeps this test entirely local and
// proves both the guarded failure and the successful path.
{
  const options = fixture('stop-guard')
  const initialConfig = 'model = "gpt-5.6"\n'
  const initialAuth = '{"auth_mode":"chatgpt"}\n'
  const initialModels = '{"models":[1]}\n'
  const paths = manager.getPaths(options)

  fs.writeFileSync(options.configPath, initialConfig, 'utf8')
  fs.writeFileSync(options.authPath, initialAuth, 'utf8')
  fs.writeFileSync(options.modelsCachePath, initialModels, 'utf8')
  manager._internal.ensureInitialBackup(paths, initialConfig)
  const managedConfig = 'model_provider = "managed"\n'
  const managedAuth = '{"auth_mode":"apikey"}\n'
  fs.writeFileSync(options.configPath, managedConfig, 'utf8')
  fs.writeFileSync(options.authPath, managedAuth, 'utf8')

  let stopCalls = 0
  assert.throws(
    () =>
      manager.restoreInitialBackup({
        ...options,
        stopClientsOnBusy: true,
        stopCodexClients: () => {
          stopCalls += 1
          return { ok: false, remaining: ['ChatGPT.exe:1234'] }
        }
      }),
    /尚未完全关闭/
  )
  assert.strictEqual(stopCalls, 1)
  assert.strictEqual(fs.readFileSync(options.configPath, 'utf8'), managedConfig)
  assert.strictEqual(fs.readFileSync(options.authPath, 'utf8'), managedAuth)

  const restored = manager.restoreInitialBackup({
    ...options,
    stopClientsOnBusy: true,
    stopCodexClients: () => ({ ok: true, stopped: 1, remaining: [] })
  })
  assert.strictEqual(restored.stopResult?.ok, true)
  assert.strictEqual(fs.readFileSync(options.configPath, 'utf8'), initialConfig)
  assert.strictEqual(fs.existsSync(options.authPath), false)
}

// A rolling config backup is deliberately a single stable file.  Repeated
// operations and different suffixes must not create timestamped copies.
{
  const options = fixture('rolling')
  const paths = manager.getPaths(options)
  const first = 'model = "gpt-5.6"\n'
  const second = 'model = "gpt-5.6-mini"\n'

  fs.writeFileSync(options.configPath, first, 'utf8')
  const backupPath = manager._internal.backupConfig(options.configPath, first, 'first')
  assert.strictEqual(manager._internal.backupConfig(options.configPath, first, 'second'), backupPath)
  fs.writeFileSync(options.configPath, second, 'utf8')
  assert.strictEqual(manager._internal.backupConfig(options.configPath, second, 'third'), backupPath)
  assert.strictEqual(
    fs.readdirSync(paths.codexHome).filter(name => name.startsWith('config.toml.bak-codex-manager')).length,
    1
  )
  assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), second)
}

// Metadata and payloads are immutable.  If a snapshot payload is removed,
// startup must report an invalid snapshot and must never replace it with the
// current managed config (which would make “restore initial” a lie).
{
  const options = fixture('stale-config')
  const initialConfig = 'model = "gpt-5.6"\n'
  fs.writeFileSync(options.configPath, initialConfig, 'utf8')
  fs.writeFileSync(options.authPath, '{"auth_mode":"chatgpt"}\n', 'utf8')
  fs.writeFileSync(options.modelsCachePath, '{"models":[]}\n', 'utf8')
  const paths = manager.getPaths(options)
  manager._internal.ensureInitialBackup(paths, initialConfig)
  const metadataBefore = fs.readFileSync(paths.initialBackupMetaPath, 'utf8')
  const snapshotPath = JSON.parse(metadataBefore).path
  fs.rmSync(snapshotPath, { force: true })
  const managedConfig = 'model_provider = "managed"\n'
  fs.writeFileSync(options.configPath, managedConfig, 'utf8')

  const invalid = manager._internal.ensureInitialBackup(paths, managedConfig)
  assert.strictEqual(invalid.valid, false)
  assert.match(invalid.error, /config 快照文件缺失/)
  assert.strictEqual(fs.existsSync(snapshotPath), false)
  assert.strictEqual(fs.readFileSync(paths.initialBackupMetaPath, 'utf8'), metadataBefore)
  assert.throws(() => manager.restoreInitialBackup(options), /首次备份不可恢复/)
  assert.strictEqual(fs.readFileSync(options.configPath, 'utf8'), managedConfig)
}

{
  const options = fixture('stale-auth')
  const initialConfig = 'model = "gpt-5.6"\n'
  fs.writeFileSync(options.configPath, initialConfig, 'utf8')
  fs.writeFileSync(options.authPath, '{"auth_mode":"chatgpt"}\n', 'utf8')
  const paths = manager.getPaths(options)
  manager._internal.ensureInitialBackup(paths, initialConfig)
  const metadataBefore = JSON.parse(fs.readFileSync(paths.initialBackupMetaPath, 'utf8'))
  fs.rmSync(metadataBefore.authPath, { force: true })
  const currentAuth = '{"auth_mode":"apikey"}\n'
  fs.writeFileSync(options.authPath, currentAuth, 'utf8')

  const invalid = manager._internal.ensureInitialBackup(paths, initialConfig)
  assert.strictEqual(invalid.valid, false)
  assert.match(invalid.error, /auth 快照文件缺失/)
  assert.throws(() => manager.restoreInitialBackup(options), /auth 快照文件缺失/)
  assert.strictEqual(fs.readFileSync(options.authPath, 'utf8'), currentAuth)
}

// If an error occurs after config.toml has been removed, rollback must retain
// the original “file did not exist” state rather than creating an empty file.
{
  const options = fixture('rollback-absent-config')
  const initialConfig = 'model = "gpt-5.6"\n'
  fs.writeFileSync(options.configPath, initialConfig, 'utf8')
  fs.writeFileSync(options.authPath, '{"auth_mode":"chatgpt"}\n', 'utf8')
  fs.writeFileSync(options.modelsCachePath, '{"models":[1]}\n', 'utf8')
  const paths = manager.getPaths(options)
  manager._internal.ensureInitialBackup(paths, initialConfig)
  fs.rmSync(options.configPath, { force: true })
  const currentAuth = '{"auth_mode":"apikey"}\n'
  const currentModels = '{"models":[2]}\n'
  fs.writeFileSync(options.authPath, currentAuth, 'utf8')
  fs.writeFileSync(options.modelsCachePath, currentModels, 'utf8')

  const originalRmSync = fs.rmSync
  let failOnce = true
  fs.rmSync = (target, rmOptions) => {
    if (failOnce && path.resolve(String(target)) === path.resolve(options.authPath)) {
      failOnce = false
      throw new Error('simulated restore copy failure')
    }
    return originalRmSync(target, rmOptions)
  }

  try {
    assert.throws(() => manager.restoreInitialBackup(options), /simulated restore copy failure/)
  } finally {
    fs.rmSync = originalRmSync
  }

  assert.strictEqual(fs.existsSync(options.configPath), false)
  assert.strictEqual(fs.readFileSync(options.authPath, 'utf8'), currentAuth)
  assert.strictEqual(fs.readFileSync(options.modelsCachePath, 'utf8'), currentModels)
}

// Deleting a conversation must also prune Codex's desktop project metadata;
// otherwise the next client start can rebuild the deleted row from
// .codex-global-state.json even though the JSONL file is gone.
async function runDeleteReopenTest() {
  const options = fixture('delete-reopen')
  const projectPath = path.join(path.dirname(options.codexHome), 'project')
  const sessionDir = path.join(options.sessionsPath || path.join(options.codexHome, 'sessions'), '2026', '09', '01')
  const sessionPath = path.join(sessionDir, 'rollout-delete-me.jsonl')
  const globalStatePath = manager.getPaths(options).globalStatePath

  fs.mkdirSync(projectPath, { recursive: true })
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    options.configPath,
    `model = "gpt-5.6"\n\n[projects.'${projectPath.toLowerCase()}']\ntrust_level = "trusted"\n`,
    'utf8'
  )
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'delete-me', thread_name: 'Delete me', cwd: projectPath }
    })}\n`,
    'utf8'
  )
  fs.writeFileSync(
    globalStatePath,
    `${JSON.stringify(
      {
        'local-projects': {
          project: { id: 'project', rootPaths: [projectPath], name: 'Project' },
          keep: { id: 'keep', rootPaths: [path.dirname(projectPath)], name: 'Keep' }
        },
        'project-order': ['project', 'keep'],
        'pinned-project-ids': ['project', 'keep'],
        'thread-project-assignments': {
          'delete-me': { projectKind: 'local', projectId: 'project', cwd: projectPath },
          keep: { projectKind: 'local', projectId: 'keep', cwd: path.dirname(projectPath) }
        },
        'projectless-thread-ids': ['delete-me', 'keep'],
        'thread-workspace-root-hints': { 'delete-me': projectPath, keep: path.dirname(projectPath) },
        unrelated: { preserved: true }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const result = await manager.deleteConversationData(
    { scope: 'active', projectPath },
    { ...options, refreshConversationIndex: false }
  )

  assert.strictEqual(result.deletedSessionCount, 1)
  assert.strictEqual(result.deletedProjectCount, 1)
  assert.strictEqual(fs.existsSync(sessionPath), false)
  assert.strictEqual(fs.existsSync(projectPath), true, 'default deletion keeps the working tree')

  const stateAfter = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'))

  assert.strictEqual(stateAfter['local-projects'].project, undefined)
  assert.strictEqual(stateAfter['thread-project-assignments']['delete-me'], undefined)
  assert.deepStrictEqual(stateAfter['projectless-thread-ids'], ['keep'])
  assert.strictEqual(stateAfter['thread-workspace-root-hints']['delete-me'], undefined)
  assert.deepStrictEqual(stateAfter.unrelated, { preserved: true })

  // Simulate reopening the manager/client: no deleted session or project is
  // discoverable from either disk or the persisted desktop state.
  const reopened = manager.readStatus(options)

  assert.strictEqual(
    reopened.sessions.some(session => session.id === 'delete-me'),
    false
  )
  assert.strictEqual(
    reopened.projects.some(project => project.path.toLowerCase() === projectPath.toLowerCase()),
    false
  )
}

async function runSingleDeleteReopenTest() {
  const options = fixture('single-delete-reopen')
  const projectPath = path.join(path.dirname(options.codexHome), 'project')
  const sessionDir = path.join(options.codexHome, 'sessions', '2026', '09', '01')
  const sessionPath = path.join(sessionDir, 'rollout-single-delete.jsonl')
  const globalStatePath = manager.getPaths(options).globalStatePath

  fs.mkdirSync(projectPath, { recursive: true })
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    options.configPath,
    `model = "gpt-5.6"\n\n[projects.'${projectPath.toLowerCase()}']\ntrust_level = "trusted"\n`,
    'utf8'
  )
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'single-delete', thread_name: 'Single delete', cwd: projectPath }
    })}\n`,
    'utf8'
  )
  fs.writeFileSync(
    globalStatePath,
    `${JSON.stringify(
      {
        'local-projects': { project: { id: 'project', rootPaths: [projectPath] } },
        'project-order': ['project'],
        'pinned-project-ids': ['project'],
        'thread-project-assignments': {
          'single-delete': { projectKind: 'local', projectId: 'project', cwd: projectPath }
        },
        'projectless-thread-ids': ['single-delete'],
        'thread-workspace-root-hints': { 'single-delete': projectPath }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const result = await manager.deleteSession('single-delete', { ...options, refreshConversationIndex: false })

  assert.strictEqual(result.indexDelete?.skipped, true)
  assert.strictEqual(result.indexRefresh?.skipped, true)
  assert.strictEqual(result.projectRecordRemoved, true)
  assert.strictEqual(fs.existsSync(sessionPath), false)
  const stateAfter = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'))

  assert.strictEqual(stateAfter['local-projects'].project, undefined)
  assert.strictEqual(stateAfter['thread-project-assignments']['single-delete'], undefined)
  assert.deepStrictEqual(stateAfter['projectless-thread-ids'], [])
  assert.strictEqual(stateAfter['thread-workspace-root-hints']['single-delete'], undefined)
  assert.strictEqual(manager.readStatus(options).projects.length, 0)
}

async function runIndexFallbackDeleteTest() {
  const options = fixture('index-fallback-delete')
  const projectPath = path.join(path.dirname(options.codexHome), 'project')
  const sessionPath = path.join(options.codexHome, 'sessions', '2026', '09', '01', 'rollout-index-fallback.jsonl')
  const stateDbPath = path.join(options.codexHome, 'state_5.sqlite')
  const stateWalPath = `${stateDbPath}-wal`
  const globalStatePath = manager.getPaths(options).globalStatePath

  fs.mkdirSync(projectPath, { recursive: true })
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(
    options.configPath,
    `model = "gpt-5.6"\n\n[projects.'${projectPath.toLowerCase()}']\ntrust_level = "trusted"\n`,
    'utf8'
  )
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'index-fallback', thread_name: 'Index fallback', cwd: projectPath }
    })}\n`,
    'utf8'
  )
  fs.writeFileSync(stateDbPath, 'stale-index', 'utf8')
  fs.writeFileSync(stateWalPath, 'stale-wal', 'utf8')
  fs.writeFileSync(
    globalStatePath,
    `${JSON.stringify(
      {
        'local-projects': { project: { id: 'project', rootPaths: [projectPath] } },
        'thread-project-assignments': { 'index-fallback': { projectId: 'project', cwd: projectPath } }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const beforeConfig = fs.readFileSync(options.configPath, 'utf8')
  const beforeSession = fs.readFileSync(sessionPath, 'utf8')
  await assert.rejects(
    manager.deleteSession('index-fallback', {
      ...options,
      refreshConversationIndex: true,
      stopClientsOnBusy: true,
      stopCodexClients: () => ({ ok: false, remaining: ['ChatGPT.exe:99'] })
    }),
    /尚未完全关闭/
  )
  assert.strictEqual(fs.readFileSync(options.configPath, 'utf8'), beforeConfig)
  assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), beforeSession)
  assert.strictEqual(fs.existsSync(stateDbPath), true)

  const result = await manager.deleteSession('index-fallback', {
    ...options,
    refreshConversationIndex: true,
    stopClientsOnBusy: true,
    stopCodexClients: () => ({ ok: true, stopped: 1, remaining: [] }),
    codexCliPath: 'fixture-codex.exe',
    runAppServerRequest: async () => {
      throw new Error('fixture app-server unavailable')
    }
  })

  assert.strictEqual(result.indexDelete.ok, false)
  assert.ok(result.indexDelete.errors?.length)
  assert.strictEqual(result.stateIndexPrune.ok, true)
  assert.strictEqual(result.stateIndexPrune.skipped, false)
  assert.strictEqual(fs.existsSync(sessionPath), false)
  assert.strictEqual(fs.existsSync(stateDbPath), false)
  assert.strictEqual(fs.existsSync(stateWalPath), false)
  assert.strictEqual(manager.readStatus(options).projects.length, 0)
}

runDeleteReopenTest()
  .then(runSingleDeleteReopenTest)
  .then(runIndexFallbackDeleteTest)
  .then(() => console.log('restore/initial-backup invariants passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
