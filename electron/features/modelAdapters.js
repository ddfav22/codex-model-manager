const REASONING_DESCRIPTIONS = {
  low: '较快推理',
  medium: '均衡推理',
  high: '深度推理',
  xhigh: '更深度推理',
  max: '最大推理深度',
  ultra: '超高推理深度'
}

const GPT_REASONING_LEVELS = {
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['low', 'medium', 'high', 'xhigh']
}

const GPT_FAST_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])

function uniqueModelList(input) {
  const values = Array.isArray(input?.models) ? input.models : [input?.model]
  const seen = new Set()
  const models = []

  for (const value of values) {
    const model = String(value || '').trim()
    const key = model.toLowerCase()

    if (!model || seen.has(key)) continue

    seen.add(key)
    models.push(model)
  }

  return models
}

function modelListFromProvider(provider) {
  const models = uniqueModelList(provider)

  if (models.length) return models

  return String(provider?.model || '').trim() ? [String(provider.model).trim()] : []
}

function modelAdapterProfile(model, test = null) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
  const testedWireApi = ['responses', 'chat'].includes(test?.wireApi) ? test.wireApi : ''

  if (/^(gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/.test(normalized)) {
    const reasoningEfforts = GPT_REASONING_LEVELS[normalized] || ['low', 'medium', 'high']
    const wireApi = testedWireApi || 'responses'
    const supportsFast = wireApi === 'responses' && GPT_FAST_MODELS.has(normalized)

    return {
      status: 'supported',
      available: true,
      adapter: wireApi === 'responses' ? 'gpt-responses' : 'gpt-chat',
      wireApi,
      reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.includes('medium') ? 'medium' : reasoningEfforts[0],
      supportsReasoningSummaries: wireApi === 'responses',
      supportsVerbosity: wireApi === 'responses',
      speedModes: supportsFast ? ['standard', 'fast'] : ['standard'],
      serviceTiers: supportsFast
        ? [{ id: 'priority', name: '快速', description: '使用上游 priority 服务等级；计费可能更高' }]
        : [],
      toolTransport: test?.toolTransport || 'native',
      agentRuntime: 'codex-native',
      upstreamModel: String(model || ''),
      reason: ''
    }
  }

  if (/^grok(?:-|$)/.test(normalized)) {
    const wireApi = testedWireApi || 'chat'

    return {
      status: 'supported',
      available: true,
      adapter: wireApi === 'responses' ? 'grok-responses' : 'grok-chat',
      wireApi,
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
      supportsReasoningSummaries: false,
      supportsVerbosity: false,
      speedModes: ['standard'],
      serviceTiers: [],
      toolTransport: test?.toolTransport || 'native',
      agentRuntime: 'codex-native',
      upstreamModel: String(model || ''),
      reason: ''
    }
  }

  return {
    status: 'unsupported',
    available: false,
    adapter: '',
    wireApi: '',
    reasoningEfforts: [],
    defaultReasoningEffort: '',
    supportsReasoningSummaries: false,
    supportsVerbosity: false,
    speedModes: [],
    serviceTiers: [],
    toolTransport: '',
    agentRuntime: 'codex-native',
    upstreamModel: String(model || ''),
    reason: '适配未完成，暂不可用'
  }
}

function testForModel(provider, model) {
  const tests = provider?.modelTests && typeof provider.modelTests === 'object' ? provider.modelTests : {}

  return tests[model] || null
}

function relayTestReady(test) {
  return (
    test?.ok === true &&
    test?.chatOk === true &&
    test?.streamOk === true &&
    test?.agentToolOk === true &&
    ['native', 'prompt-emulated'].includes(test?.toolTransport)
  )
}

function modelCapabilityMap(provider) {
  return Object.fromEntries(
    modelListFromProvider(provider).map(model => [model, modelAdapterProfile(model, testForModel(provider, model))])
  )
}

function supportedModelsForProvider(provider) {
  return modelListFromProvider(provider).filter(model => {
    const test = testForModel(provider, model)
    const profile = modelAdapterProfile(model, test)

    if (!profile.available) return false

    return provider?.managed ? relayTestReady(test) : true
  })
}

function preferredSupportedModel(models, preferred = '') {
  const available = uniqueModelList({ models })
  const requested = String(preferred || '').trim()

  if (requested && available.includes(requested) && modelAdapterProfile(requested).available) return requested

  return available.find(model => modelAdapterProfile(model).available) || available[0] || ''
}

function aggregateModelTests(models, modelTests) {
  const entries = models.map(model => modelTests?.[model]).filter(Boolean)

  if (!models.length || entries.length !== models.length) return null

  const failed = entries.find(test => !relayTestReady(test))
  const totalLatency = entries.reduce((sum, test) => sum + (Number(test.latencyMs) || 0), 0)

  return {
    ok: !failed,
    chatOk: entries.every(test => test.chatOk === true),
    streamOk: entries.every(test => test.streamOk === true),
    agentToolOk: entries.every(test => test.agentToolOk === true),
    toolTransport: entries.every(test => test.toolTransport === entries[0]?.toolTransport)
      ? entries[0]?.toolTransport || ''
      : 'mixed',
    wireApi: entries.every(test => test.wireApi === entries[0]?.wireApi) ? entries[0]?.wireApi || '' : '',
    status: failed?.status || entries[entries.length - 1]?.status || 0,
    latencyMs: totalLatency,
    chatLatencyMs: entries.reduce((sum, test) => sum + (Number(test.chatLatencyMs) || 0), 0),
    streamLatencyMs: entries.reduce((sum, test) => sum + (Number(test.streamLatencyMs) || 0), 0),
    agentToolLatencyMs: entries.reduce((sum, test) => sum + (Number(test.agentToolLatencyMs) || 0), 0),
    actualModel: entries.length === 1 ? entries[0]?.actualModel || '' : '',
    agentToolMessage: failed?.agentToolMessage || '',
    message: failed
      ? `${failed.model || '模型'} 测试失败：${failed.message || '未知错误'}`
      : `全部 ${models.length} 个模型的聊天、流式响应和工具续答测试均通过`
  }
}

function modelWireApiMap(provider) {
  const map = {}

  for (const model of modelListFromProvider(provider)) {
    const profile = modelAdapterProfile(model, testForModel(provider, model))
    const wireApi = profile.available ? profile.wireApi : ''

    if (wireApi === 'responses' || wireApi === 'chat') map[model] = wireApi
  }

  return map
}

module.exports = {
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
}
