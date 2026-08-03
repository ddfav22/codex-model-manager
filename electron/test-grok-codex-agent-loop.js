const assert = require('assert')

const {
  AGENT_COMPLETION_SIGNAL,
  AGENT_SAFETY_STOP_SIGNAL,
  agentCompletionResult,
  awaitsExplicitUserInput,
  hasAgentCompletionSignal,
  looksLikeStalledToolContinuation,
  requiresAgentCompletionSignal,
  shouldAcceptContinuationRecovery
} = require('./protocol/toolContinuation')
const {
  modelAdapterProfile,
  modelCapabilityMap,
  modelListFromProvider,
  relayTestReady,
  supportedModelsForProvider
} = require('./features/modelAdapters')
const { responsesRequestToChat } = require('./protocolProxy')
const {
  anchorShortContinuation,
  isShortContinuationText,
  recoveryConversationContext,
  stripAgentControlSignals
} = require('./protocol/contextContinuity')

const nativeCompatibility = {
  ok: true,
  chatOk: true,
  streamOk: true,
  agentToolOk: true,
  toolTransport: 'native',
  wireApi: 'chat'
}

const profile = modelAdapterProfile('grok-4.5', nativeCompatibility)

assert.deepStrictEqual(
  {
    available: profile.available,
    adapter: profile.adapter,
    wireApi: profile.wireApi,
    toolTransport: profile.toolTransport,
    agentRuntime: profile.agentRuntime,
    upstreamModel: profile.upstreamModel
  },
  {
    available: true,
    adapter: 'grok-chat',
    wireApi: 'chat',
    toolTransport: 'native',
    agentRuntime: 'codex-native',
    upstreamModel: 'grok-4.5'
  }
)
assert.doesNotMatch(JSON.stringify(profile), /cli/i)

const providerWithLegacyCliData = {
  managed: true,
  model: 'grok-4.5',
  models: ['grok-4.5', 'gpt-5.6-sol'],
  modelTests: {
    'grok-4.5': nativeCompatibility,
    'gpt-5.6-sol': {
      ...nativeCompatibility,
      ok: false,
      chatOk: false,
      streamOk: false,
      agentToolOk: false,
      wireApi: 'responses'
    }
  },
  grokCliProfiles: [
    {
      enabled: true,
      modelAlias: 'grok-cli-legacy-alias',
      compatibility: nativeCompatibility
    }
  ]
}

assert.deepStrictEqual(modelListFromProvider(providerWithLegacyCliData), ['grok-4.5', 'gpt-5.6-sol'])
assert.deepStrictEqual(Object.keys(modelCapabilityMap(providerWithLegacyCliData)), ['grok-4.5', 'gpt-5.6-sol'])
assert.deepStrictEqual(supportedModelsForProvider(providerWithLegacyCliData), ['grok-4.5'])
assert.strictEqual(modelCapabilityMap(providerWithLegacyCliData)['grok-4.5'].agentRuntime, 'codex-native')
assert.strictEqual(relayTestReady(nativeCompatibility), true)
assert.strictEqual(relayTestReady({ ...nativeCompatibility, toolTransport: 'prompt-emulated' }), true)
assert.strictEqual(relayTestReady({ ...nativeCompatibility, toolTransport: 'grok-cli' }), false)

const converted = responsesRequestToChat(
  {
    model: 'grok-4.5',
    instructions: 'Complete the requested task.',
    stream: true,
    reasoning: { effort: 'medium' },
    tool_choice: 'auto',
    parallel_tool_calls: false,
    tools: [
      {
        type: 'function',
        name: 'shell_command',
        description: 'Run a command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false
        }
      }
    ],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the project and finish the task.' }]
      },
      {
        type: 'function_call',
        call_id: 'call_agent_loop',
        name: 'shell_command',
        arguments: '{"command":"Get-ChildItem"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_agent_loop',
        output: 'project files'
      }
    ]
  },
  profile
)

assert.strictEqual(converted.request.model, 'grok-4.5')
assert.strictEqual(converted.request.stream, true)
assert.strictEqual(converted.request.reasoning_effort, 'medium')
assert.strictEqual(converted.request.tool_choice, 'auto')
assert.strictEqual(converted.request.parallel_tool_calls, false)
assert.strictEqual(converted.request.tools[0].function.name, 'shell_command')
assert.ok(
  converted.request.messages.some(
    message =>
      message.role === 'system' &&
      message.content.includes('Codex owns the agent loop') &&
      message.content.includes('function_call_output')
  )
)
assert.ok(
  converted.request.messages.some(
    message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_agent_loop'
  )
)
assert.ok(
  converted.request.messages.some(
    message =>
      message.role === 'tool' && message.tool_call_id === 'call_agent_loop' && message.content === 'project files'
  )
)

const signedResult = `已保存文件并完成全部任务。\n${AGENT_COMPLETION_SIGNAL}`

assert.strictEqual(hasAgentCompletionSignal(signedResult), true)
assert.strictEqual(hasAgentCompletionSignal(`已完成${AGENT_COMPLETION_SIGNAL}`), false)
assert.strictEqual(hasAgentCompletionSignal(`${signedResult}\n附加文字`), false)
assert.strictEqual(agentCompletionResult(signedResult), '已保存文件并完成全部任务。')
assert.strictEqual(agentCompletionResult(`已完成${AGENT_COMPLETION_SIGNAL}`), '')
assert.strictEqual(requiresAgentCompletionSignal('已保存文件并完成全部任务。', { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal(signedResult, { afterToolResult: true }), false)
assert.strictEqual(requiresAgentCompletionSignal(`已完成${AGENT_COMPLETION_SIGNAL}`, { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal(AGENT_COMPLETION_SIGNAL, { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal('请提供要保存的完整路径。', { afterToolResult: true }), false)
assert.strictEqual(
  requiresAgentCompletionSignal(`请提供要保存的完整路径。\n${AGENT_COMPLETION_SIGNAL}`, {
    afterToolResult: true
  }),
  true
)
assert.strictEqual(awaitsExplicitUserInput('请提供要保存的完整路径。'), true)
assert.strictEqual(
  looksLikeStalledToolContinuation(`下一步我会保存文件。\n${AGENT_COMPLETION_SIGNAL}`, {
    afterToolResult: true
  }),
  true
)
assert.strictEqual(looksLikeStalledToolContinuation('我接下来会处理剩余步骤。', { afterToolResult: true }), true)
assert.strictEqual(looksLikeStalledToolContinuation('好的。下一步我将继续。', { afterToolResult: true }), true)
assert.strictEqual(
  looksLikeStalledToolContinuation('Next, I will handle the remaining steps.', { afterToolResult: true }),
  true
)
assert.strictEqual(looksLikeStalledToolContinuation(signedResult, { afterToolResult: true }), false)
assert.strictEqual(
  shouldAcceptContinuationRecovery({
    afterToolResult: true,
    stalledAfterToolResult: true,
    stalledContinuation: true,
    retryContent: signedResult,
    retryToolCall: null
  }),
  true
)
assert.strictEqual(
  shouldAcceptContinuationRecovery({
    afterToolResult: true,
    stalledAfterToolResult: true,
    stalledContinuation: true,
    retryContent: '已保存文件并完成全部任务。',
    retryToolCall: null
  }),
  false
)
assert.strictEqual(
  shouldAcceptContinuationRecovery({
    afterToolResult: true,
    stalledAfterToolResult: true,
    stalledContinuation: true,
    retryContent: '请提供要保存的完整路径。',
    retryToolCall: null
  }),
  true
)
assert.notStrictEqual(AGENT_COMPLETION_SIGNAL, AGENT_SAFETY_STOP_SIGNAL)

const longRecoveryContext = recoveryConversationContext([
  { role: 'system', content: 'internal adapter instructions' },
  { role: 'user', content: '原始任务：检查项目、生成文件，并记住本轮约定。' },
  { role: 'assistant', content: `已完成第一步。\n${AGENT_COMPLETION_SIGNAL}` },
  ...Array.from({ length: 10 }, (_, index) => ({
    role: 'user',
    content: `[Codex local tool result for call_${index}]\nresult ${index}`
  }))
])

assert.ok(longRecoveryContext.some(message => message.content.includes('原始任务：检查项目')))
assert.ok(longRecoveryContext.some(message => message.content.includes('result 9')))
assert.ok(longRecoveryContext.every(message => !message.content.includes(AGENT_COMPLETION_SIGNAL)))
assert.ok(longRecoveryContext.every(message => !message.content.includes(AGENT_SAFETY_STOP_SIGNAL)))
assert.strictEqual(
  stripAgentControlSignals(`最终结果\n${AGENT_COMPLETION_SIGNAL}\n${AGENT_SAFETY_STOP_SIGNAL}`),
  '最终结果'
)
assert.strictEqual(stripAgentControlSignals('正在处理。\n上游模型未能完成剩余步骤，请重试本轮任务。'), '正在处理。')
assert.strictEqual(isShortContinuationText('继续！！！'), true)
assert.strictEqual(isShortContinuationText('继续修复 Projects 显示问题'), false)

const anchoredContinuation = anchorShortContinuation([
  { role: 'user', content: '查询今日金价，并把结果写入桌面文件。' },
  { role: 'assistant', content: '先查询最新金价。\n上游模型未能完成剩余步骤，请重试本轮任务。' },
  { role: 'user', content: '继续' }
])

assert.strictEqual(anchoredContinuation.anchored, true)
assert.match(anchoredContinuation.messages.at(-1).content, /Original task: 查询今日金价/)
assert.match(anchoredContinuation.messages.at(-1).content, /Latest visible assistant state: 先查询最新金价/)
assert.doesNotMatch(anchoredContinuation.messages.at(-1).content, /上游模型未能完成剩余步骤/)

console.log('Grok Codex Agent Loop adapter tests passed')
