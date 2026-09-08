const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const manager = require('./codexManager')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chatgpt-only-'))
const codexHome = path.join(root, '.codex')
const stateDir = path.join(codexHome, 'codex-model-manager')
const configPath = path.join(codexHome, 'config.toml')
const authPath = path.join(codexHome, 'auth.json')
const modelsCachePath = path.join(codexHome, 'models_cache.json')
const options = { codexHome, stateDir, configPath, authPath, modelsCachePath, skipEnvWrite: true, dryRunRestart: true }

fs.mkdirSync(codexHome, { recursive: true })
const initialConfig = '[features]\nweb_search = true\n\n[projects."C:/Users/test/project"]\ntrust_level = "trusted"\n'
fs.writeFileSync(configPath, initialConfig, 'utf8')
fs.writeFileSync(authPath, '{"auth_mode":"chatgpt"}\n', 'utf8')
fs.writeFileSync(modelsCachePath, '{"models":[{"slug":"gpt-5.6","visibility":"list"}]}\n', 'utf8')

const paths = manager.getPaths(options)
manager._internal.ensureInitialBackup(paths, initialConfig)
fs.writeFileSync(configPath, 'model_provider = "managed"\n\n[projects."C:/Users/other"]\ntrust_level = "trusted"\n', 'utf8')

const rollingBackup = manager._internal.backupConfig(configPath, fs.readFileSync(configPath, 'utf8'), 'first')
const rollingBackupAgain = manager._internal.backupConfig(configPath, fs.readFileSync(configPath, 'utf8'), 'second')
assert.strictEqual(rollingBackupAgain, rollingBackup)
assert.strictEqual(fs.readdirSync(codexHome).filter(name => name.includes('bak-codex-manager')).length, 1)

manager.restoreInitialBackup(options)
assert.strictEqual(fs.readFileSync(configPath, 'utf8'), initialConfig)
assert.match(fs.readFileSync(configPath, 'utf8'), /projects\./)

const adapters = require('./features/modelAdapters')
const protocolProxy = require('./protocolProxy')
assert.strictEqual(adapters.isChatGptModel('gpt-5.6'), true)
assert.strictEqual(adapters.isChatGptModel('o4-mini'), true)
assert.strictEqual(adapters.isChatGptModel('gpt-image-1'), false)
assert.strictEqual(adapters.isChatGptModel('dall-e-3'), false)
assert.strictEqual(adapters.isChatGptModel('grok-4.5'), false)
assert.deepStrictEqual(adapters.filterChatGptModels(['grok-4.5', 'gpt-5.6', 'claude-sonnet-5']), ['gpt-5.6'])
assert.strictEqual(adapters.preferredSupportedModel(['grok-4.5', 'claude-sonnet-5']), '')
assert.deepStrictEqual(
  adapters.supportedModelsForProvider({
    managed: true,
    keySource: 'newapi',
    models: ['gpt-6-astra', 'gpt-5.6-sol'],
    modelTests: {}
  }),
  ['gpt-6-astra', 'gpt-5.6-sol']
)
assert.deepStrictEqual(
  adapters.supportedModelsForProvider({
    managed: true,
    keySource: 'manual',
    models: ['gpt-5.6-sol'],
    modelTests: {}
  }),
  []
)
const normalizedNewApi = manager._internal.normalizeRelayInput({
  name: 'NewAPI',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  keySource: 'newapi',
  model: 'grok-4.5',
  models: ['grok-4.5', 'gpt-5.6', 'dall-e-3', 'gpt-image-1']
})
assert.deepStrictEqual(normalizedNewApi.models, ['gpt-5.6'])
assert.strictEqual(normalizedNewApi.model, 'gpt-5.6')
assert.strictEqual(protocolProxy.inferredWireApiForModel('gpt-5.6'), 'responses')
assert.strictEqual(protocolProxy.inferredWireApiForModel('grok-4.5'), '')
assert.strictEqual('shouldForceGrokAgentLoopEmulation' in protocolProxy, false)

console.log('chatgpt-only/restore/rolling-backup tests passed')
