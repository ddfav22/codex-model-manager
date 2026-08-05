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
const {
  recoveryFailureKindForError,
  recoveryFailureKindForStatus,
  recoveryFailureMessage,
  responsesRequestToChat
} = require('./protocolProxy')
const {
  anchorShortContinuation,
  isInterruptedContinuationText,
  isShortContinuationText,
  recoveryConversationContext,
  stripAgentControlSignals
} = require('./protocol/contextContinuity')
const {
  hasInternalToolResult,
  internalAdapterInstruction,
  internalToolCallsTranscript,
  internalToolResultTranscript,
  isInternalToolCallsOnly,
  stripInternalToolTranscript
} = require('./protocol/internalToolTranscript')
const { emulatedToolSyntaxStart, partialControlMarkerStart } = require('./protocol/emulatedToolSyntax')

const nativeCompatibility = {
  ok: true,
  chatOk: true,
  streamOk: true,
  agentToolOk: true,
  toolTransport: 'native',
  wireApi: 'chat'
}

assert.strictEqual(recoveryFailureKindForStatus(503), 'http_server_error')
assert.strictEqual(recoveryFailureKindForStatus(429), 'http_rate_limit')
assert.strictEqual(recoveryFailureKindForStatus(400), 'http_request_rejected')
assert.strictEqual(recoveryFailureKindForError(new Error('prompt tool recovery timed out')), 'timeout')
assert.match(recoveryFailureMessage(['timeout']), /等待 60 秒仍未返回/)
assert.match(recoveryFailureMessage(['http_server_error']), /服务暂时不可用/)

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
assert.strictEqual(
  looksLikeStalledToolContinuation(
    'Ping 已通，SSH 密码登录刚才超时了。我改用 PowerShell 的 Posh-SSH 做端口探测和登录验证。',
    {
      afterToolResult: true
    }
  ),
  true
)
assert.strictEqual(
  looksLikeStalledToolContinuation('网络和 SSH 端口都通，接下来用更稳妥的脚本方式排查认证。', {
    afterToolResult: true
  }),
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
const internalCalls = internalToolCallsTranscript([{ name: 'exec', arguments: '{}', call_id: 'call_internal' }])
const internalResult = internalToolResultTranscript('call_internal', 'ok')
const internalAdapter = internalAdapterInstruction('continue')

assert.ok(internalCalls.includes('"kind":"tool_calls"'))
assert.ok(!internalCalls.includes('[Codex local tool calls]'))
assert.strictEqual(isInternalToolCallsOnly(internalCalls), true)
assert.strictEqual(hasInternalToolResult(internalResult), true)
assert.strictEqual(
  stripInternalToolTranscript(`${internalCalls}\n${internalResult}\n${internalAdapter}\n用户可见结果`).trim(),
  '用户可见结果'
)
assert.strictEqual(
  stripInternalToolTranscript('[Codex local tool calls]\n[{"name":"exec"}]\n正常结果').trim(),
  '正常结果'
)
assert.strictEqual(
  stripInternalToolTranscript(
    '[Codex local tool calls]\n[\n  {"name":"exec","arguments":{"input":"const paths = [\\"C:\\\\Temp\\\\one.js\\", \\"C:\\\\Temp\\\\two.js\\"]; text(paths);"}}\n]\n正常结果'
  ).trim(),
  '正常结果'
)
assert.strictEqual(isShortContinuationText('继续！！！'), true)
assert.strictEqual(isShortContinuationText('继续修复 Projects 显示问题'), false)
assert.strictEqual(isInterruptedContinuationText('继续安装并验证 Python'), true)
assert.strictEqual(isInterruptedContinuationText('检查另一个新任务'), false)
assert.strictEqual(partialControlMarkerStart('Ping 已通。\n<codex_tool_cal'), 'Ping 已通。\n'.length)
assert.strictEqual(partialControlMarkerStart('仍在处理。\n[CODEX_AGENT_LOOP_COM'), '仍在处理。\n'.length)
assert.strictEqual(
  emulatedToolSyntaxStart(`仍在处理。\n${AGENT_COMPLETION_SIGNAL}`, { includePartial: true }),
  '仍在处理。\n'.length
)
assert.strictEqual(
  emulatedToolSyntaxStart('Ping 已通。\n<codex_tool_call', { includePartial: true }),
  'Ping 已通。\n'.length
)
assert.strictEqual(
  emulatedToolSyntaxStart('Ping 已通。\n<codex_tool_call>{"name":"exec"}', { includePartial: false }),
  'Ping 已通。\n'.length
)

const anchoredContinuation = anchorShortContinuation([
  { role: 'user', content: '查询今日金价，并把结果写入桌面文件。' },
  { role: 'assistant', content: '先查询最新金价。\n上游模型未能完成剩余步骤，请重试本轮任务。' },
  { role: 'user', content: '继续' }
])

assert.strictEqual(anchoredContinuation.anchored, true)
assert.match(anchoredContinuation.messages.at(-1).content, /Original task: 查询今日金价/)
assert.match(anchoredContinuation.messages.at(-1).content, /Latest visible assistant state: 先查询最新金价/)
assert.doesNotMatch(anchoredContinuation.messages.at(-1).content, /上游模型未能完成剩余步骤/)

const interruptedContinuation = anchorShortContinuation([
  { role: 'user', content: '安装 Python，完成后运行 python --version 验证。' },
  { role: 'assistant', content: '正在下载安装程序。' },
  { role: 'tool', tool_call_id: 'call_python_download', content: 'download complete' },
  {
    role: 'system',
    content:
      '<turn_aborted>The user intentionally interrupted the previous turn. Any running tool processes were stopped.</turn_aborted>'
  },
  { role: 'user', content: '继续安装并验证 Python' }
])

assert.strictEqual(interruptedContinuation.anchored, true)
assert.strictEqual(interruptedContinuation.interrupted, true)
assert.strictEqual(interruptedContinuation.toolResultCount, 1)
assert.match(interruptedContinuation.messages.at(-1).content, /prior turn was manually interrupted/)
assert.match(interruptedContinuation.messages.at(-1).content, /Original task: 安装 Python/)
assert.match(interruptedContinuation.messages.at(-1).content, /Completed tool results already preserved.*1/)
assert.ok(interruptedContinuation.messages.every(message => !String(message.content || '').includes('turn_aborted')))

console.log('Grok Codex Agent Loop adapter tests passed')
