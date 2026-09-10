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

const directRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-newapi-direct-'))
const directHome = path.join(directRoot, '.codex')
const directState = path.join(directHome, 'codex-model-manager')
const directOptions = {
  codexHome: directHome,
  stateDir: directState,
  configPath: path.join(directHome, 'config.toml'),
  authPath: path.join(directHome, 'auth.json'),
  modelsCachePath: path.join(directHome, 'models_cache.json'),
  skipEnvWrite: true,
  dryRunRestart: true,
  skipBundledModelCapture: true,
  skipChannelTest: false
}
fs.mkdirSync(directHome, { recursive: true })
fs.writeFileSync(directOptions.configPath, '[features]\nshell_tool = true\n', 'utf8')
fs.writeFileSync(directOptions.authPath, '{"auth_mode":"chatgpt"}\n', 'utf8')
fs.writeFileSync(directOptions.modelsCachePath, '{"models":[{"slug":"gpt-5.6-sol","visibility":"list"}]}\n', 'utf8')
manager._internal.ensureInitialBackup(manager.getPaths(directOptions), fs.readFileSync(directOptions.configPath, 'utf8'))
manager.saveRelay(
  {
    name: 'NewAPI Direct',
    baseUrl: 'https://ainiubi.org/v1',
    apiKey: 'sk-direct-test',
    keySource: 'newapi',
    model: 'gpt-6-astra',
    models: ['gpt-6-astra'],
    wireApi: 'responses'
  },
  directOptions
)
process.env.CODEX_MM_NEWAPI_DIRECT_API_KEY = 'sk-direct-test'
const directApplied = manager.applyRelay('newapi-direct', 'gpt-6-astra', directOptions)
const directConfig = manager._internal.parseConfig(fs.readFileSync(directOptions.configPath, 'utf8'))
assert.strictEqual(directConfig.openai_base_url, 'https://ainiubi.org/v1')
assert.strictEqual(directConfig.model_catalog_json, manager.getPaths(directOptions).directModelsPath)
assert.strictEqual(directConfig.model, 'gpt-6-astra')
assert.strictEqual(directConfig.mcp_servers?.chatgpt_model_manager_image, undefined)
assert.strictEqual(directApplied.status.currentModel, 'gpt-6-astra')
assert.strictEqual(JSON.parse(fs.readFileSync(directOptions.authPath, 'utf8')).OPENAI_API_KEY, 'sk-direct-test')
const directRefresh = manager.refreshManagedProviderProxyBaseUrl({ ...directOptions, proxyBaseUrl: 'http://127.0.0.1:59999' })
assert.strictEqual(directRefresh.baseUrl, 'https://ainiubi.org/v1')
assert.strictEqual(manager._internal.parseConfig(fs.readFileSync(directOptions.configPath, 'utf8')).openai_base_url, 'https://ainiubi.org/v1')
delete process.env.CODEX_MM_NEWAPI_DIRECT_API_KEY

console.log('chatgpt-only/restore/rolling-backup tests passed')
