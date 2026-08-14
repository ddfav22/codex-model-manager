const assert = require('assert')

const {
  AGENT_COMPLETION_SIGNAL,
  AGENT_SAFETY_STOP_SIGNAL,
  agentCompletionResult,
  awaitsExplicitUserInput,
  hasAgenticToolHistory,
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
  recoveryFailureStopsLoop,
  parseEmulatedToolCall,
  promptToolCatalog,
  requestHasActiveSkillContext,
  requestHasSkillContext,
  responsesRequestToChat,
  shouldForceGrokAgentLoopEmulation
} = require('./protocolProxy')
const {
  anchorShortContinuation,
  isExplicitSessionContinuationText,
  isInterruptedContinuationText,
  isShortContinuationText,
  recoveryConversationContext,
  recoverySystemInstructions,
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
const {
  emulatedToolSyntaxStart,
  markdownToolFenceStart,
  partialControlMarkerStart
} = require('./protocol/emulatedToolSyntax')
const { encodedToolFrameStart, parseEncodedToolFrames } = require('./protocol/encodedToolFrames')
const {
  createVisibleAssistantStreamSanitizer,
  decodeRepeatedEscapedLineBreaks,
  normalizeVisibleAssistantText,
  stripEmptyInternalXml,
  stripEmptyXmlMarkdownFence,
  stripToolControlTags,
  stripToolHtmlScaffold
} = require('./protocol/visibleAssistantText')

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
assert.strictEqual(recoveryFailureStopsLoop('http_rate_limit'), true)
assert.strictEqual(recoveryFailureStopsLoop('http_server_error'), true)
assert.strictEqual(recoveryFailureStopsLoop('transport_error'), true)
assert.strictEqual(recoveryFailureStopsLoop('client_response_closed'), true)
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
assert.strictEqual(requiresAgentCompletionSignal('', { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal('<codex_no_tool>', { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal('x'.repeat(1801), { afterToolResult: true }), true)
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
const skillBody = `---\nname: security-skill\n---\n${'SKILL_BODY_SENTINEL '.repeat(500)}`
const skillRecoveryContext = recoveryConversationContext([
  { role: 'user', content: `Read SKILL.md and follow it.\n${skillBody}` },
  ...Array.from({ length: 12 }, (_, index) => ({ role: 'user', content: `later message ${index}` }))
])

assert.ok(skillRecoveryContext.some(message => message.content.includes('SKILL_BODY_SENTINEL')))
assert.ok(skillRecoveryContext.find(message => message.content.includes('SKILL_BODY_SENTINEL')).content.length > 3500)
assert.deepStrictEqual(
  recoverySystemInstructions([
    { role: 'system', content: '<skills_instructions>SKILL_SYSTEM_SENTINEL</skills_instructions>' },
    { role: 'system', content: '<skills_instructions>SKILL_SYSTEM_SENTINEL</skills_instructions>' }
  ]),
  ['<skills_instructions>SKILL_SYSTEM_SENTINEL</skills_instructions>']
)
const skillTools = Array.from({ length: 30 }, (_, index) => ({
  type: 'function',
  function: {
    name: index === 29 ? 'mcp__security__scan_target' : `noise_tool_${index}`,
    description: '',
    parameters: { type: 'object', properties: {} }
  }
}))
const skillCatalog = promptToolCatalog(skillTools, [
  { role: 'system', content: '<skills_instructions>Use mcp__security__scan_target.</skills_instructions>' }
])

assert.ok(skillCatalog.some(tool => tool.name === 'mcp__security__scan_target'))
const skillResultCatalog = promptToolCatalog(skillTools, [
  { role: 'system', content: 'generic managed instructions' },
  { role: 'user', content: `Read SKILL.md and call mcp__security__scan_target. ${'skill step '.repeat(20)}` },
  ...Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `later non-skill message ${index}` }))
])
assert.ok(skillResultCatalog.some(tool => tool.name === 'mcp__security__scan_target'))
assert.strictEqual(
  requestHasSkillContext({ instructions: '<skills_instructions>Use the skill.</skills_instructions>' }),
  true
)
assert.strictEqual(requestHasSkillContext({ instructions: 'ordinary request', input: 'Read SKILL.md now.' }), true)
assert.strictEqual(requestHasSkillContext({ instructions: 'ordinary request', input: 'ordinary input' }), false)
assert.strictEqual(
  requestHasActiveSkillContext({ metadata: { codex_internal: { active_skill: { name: 'security' } } }, input: [] }),
  true
)
assert.strictEqual(
  requestHasActiveSkillContext({ metadata: { codex_internal: { active_skill: {} } }, input: [] }),
  false
)
assert.strictEqual(requestHasActiveSkillContext({ input: 'What is a skill?' }), false)
assert.strictEqual(
  requestHasActiveSkillContext({
    instructions: '<skills_instructions>security-pentest\nSKILL.md</skills_instructions>',
    input: '/security-pentest\n先读取并执行该技能。'
  }),
  true
)
assert.strictEqual(
  requestHasActiveSkillContext({
    instructions: '<skills_instructions>security-pentest\nSKILL.md</skills_instructions>',
    input: '/plan\n普通计划文本'
  }),
  false
)
assert.strictEqual(requestHasActiveSkillContext({ input: '[[skill:security-pentest]]\n执行检查。' }), true)
assert.strictEqual(
  requestHasActiveSkillContext({
    instructions: '<skills_instructions>security-pentest\nSKILL.md</skills_instructions>',
    input: '$security-pentest\n执行检查。'
  }),
  true
)
assert.strictEqual(
  requestHasActiveSkillContext({
    instructions: '<skills_instructions>generic catalog</skills_instructions>',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '普通回答即可。' }] }]
  }),
  false
)
assert.strictEqual(
  requestHasActiveSkillContext({
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: '<skills_instructions>136 entries include SKILL.md.</skills_instructions>' }
        ]
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '普通回答即可。' }] }
    ]
  }),
  false
)
assert.strictEqual(
  requestHasActiveSkillContext({
    instructions: 'ordinary managed instructions',
    input: [
      {
        type: 'function_call',
        name: 'exec',
        arguments: JSON.stringify({ input: 'Read C:/Users/test/.agents/skills/security/SKILL.md' })
      },
      { type: 'function_call_output', call_id: 'call_skill', output: 'SKILL.md loaded' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查目标。' }] }
    ]
  }),
  true
)
assert.strictEqual(
  shouldForceGrokAgentLoopEmulation(
    { adapter: 'grok-chat' },
    {
      instructions: '<skills_instructions>Use the selected skill.</skills_instructions>',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '按 Skill 执行任务。' }] }]
    },
    { request: { tools: [{ function: { name: 'exec' } }] } }
  ),
  true
)
assert.strictEqual(
  shouldForceGrokAgentLoopEmulation(
    { adapter: 'grok-chat' },
    { instructions: 'ordinary request', input: [] },
    { request: { tools: [{ function: { name: 'exec' } }] } }
  ),
  false
)
assert.strictEqual(
  shouldForceGrokAgentLoopEmulation(
    { adapter: 'grok-chat' },
    { instructions: 'ordinary request', input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }] },
    { request: { tools: [{ function: { name: 'exec' } }] } }
  ),
  false
)
const stringInputConversion = responsesRequestToChat({
  model: 'grok-4.5',
  input: 'STRING_INPUT_SENTINEL',
  tools: [{ type: 'function', name: 'exec', parameters: { type: 'object', properties: {} } }]
})

assert.ok(
  stringInputConversion.request.messages.some(
    message => message.role === 'user' && message.content === 'STRING_INPUT_SENTINEL'
  )
)
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
assert.strictEqual(isExplicitSessionContinuationText('019ff536-a62b-7502-9263-d1bfb6c15241\n继续这个会话任务'), true)
assert.strictEqual(isExplicitSessionContinuationText('继续这个会话任务'), true)
assert.strictEqual(isExplicitSessionContinuationText('继续修复 Projects 显示问题'), false)
const agenticHistoryFixture = [
  { type: 'custom_tool_call', name: 'exec', call_id: 'call_history' },
  { type: 'custom_tool_call_output', call_id: 'call_history', output: 'done' },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '报告当前状态。' }] }
]
assert.strictEqual(hasAgenticToolHistory(agenticHistoryFixture), true)
assert.strictEqual(hasAgenticToolHistory([{ type: 'message', role: 'user', content: '普通问候' }]), false)
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

assert.strictEqual(emulatedToolSyntaxStart('<!DOCTYPE html>\n<html>', { includePartial: true }), 0)
assert.strictEqual(partialControlMarkerStart('prefix\n<tool_cal'), 'prefix\n'.length)
assert.strictEqual(
  emulatedToolSyntaxStart('prefix\n<function_call>{"name":"exec"}', { includePartial: false }),
  'prefix\n'.length
)
const genericToolCall = parseEmulatedToolCall(
  '<tool_call>{"name":"shell_command","arguments":{"command":"ok"}}</tool_call>',
  new Set(['shell_command'])
)
assert.strictEqual(genericToolCall?.function?.name, 'shell_command')
assert.deepStrictEqual(JSON.parse(genericToolCall.function.arguments), { command: 'ok' })
assert.strictEqual(markdownToolFenceStart('prefix html````html repeated tool scaffold'), 'prefix '.length)
assert.strictEqual(
  emulatedToolSyntaxStart('Plan\n```html\n<html>noise</html>', { includeMarkdownFence: true }),
  'Plan\n'.length
)
assert.strictEqual(emulatedToolSyntaxStart('Plan\n```js\nconst value = 1\n```', { includeMarkdownFence: true }), -1)
assert.strictEqual(normalizeVisibleAssistantText('\\n\\n\\n\\n'), '')
assert.strictEqual(normalizeVisibleAssistantText('"\\n\\n\\n\\n"'), '')
assert.strictEqual(normalizeVisibleAssistantText('first\\n\\n\\nsecond'), 'first\n\nsecond')
assert.strictEqual(stripEmptyInternalXml('before<codex_tool_call></codex_tool_call>after'), 'beforeafter')
assert.strictEqual(stripEmptyInternalXml('<tool_result />\n<function_call></function_call>done'), '\ndone')
assert.strictEqual(stripEmptyXmlMarkdownFence('before\n```xml\n\n```\nafter'), 'before\n\nafter')
assert.strictEqual(stripEmptyXmlMarkdownFence('```XML \r\n \t\r\n```'), '')
assert.strictEqual(stripEmptyXmlMarkdownFence('```xml\n<root />\n```'), '```xml\n<root />\n```')
assert.strictEqual(
  stripToolControlTags('before <tool_call>{"name":"exec","arguments":{"input":"text(1)"}}</tool_call> after'),
  'before  after'
)
assert.strictEqual(
  stripToolControlTags(
    '<function_call>{"name":"exec"}</function_call>\n<custom_tool_call_output>{"call_id":"call_1","output":"ok"}</custom_tool_call_output>done'
  ),
  '\ndone'
)
assert.strictEqual(stripToolControlTags('&lt;function_call&gt;{"name":"exec"}&lt;/function_call&gt;visible'), 'visible')
assert.strictEqual(
  stripToolControlTags('\\u003ccustom_tool_call\\u003e{"name":"exec"}\\u003c/custom_tool_call\\u003evisible'),
  'visible'
)
assert.strictEqual(
  stripToolControlTags('\\u003ctool_call\\u003e{\\u0022name\\u0022:\\u0022exec\\u0022}\\u003c/tool_call\\u003evisible'),
  'visible'
)
assert.strictEqual(
  stripToolControlTags('<div><function_call>normal HTML content</function_call></div>'),
  '<div><function_call>normal HTML content</function_call></div>'
)
assert.strictEqual(stripToolControlTags('prefix <tool_call /> suffix'), 'prefix  suffix')
assert.strictEqual(stripToolControlTags('prefix <tool_call></tool_call> suffix'), 'prefix  suffix')
assert.strictEqual(stripToolControlTags('prefix <tool_call'), 'prefix ')
assert.strictEqual(stripToolControlTags('prefix <function_call_output>done</function_call_output> suffix'), 'prefix  suffix')
assert.strictEqual(
  stripToolControlTags('```html\n<function_call>{"name":"exec"}</function_call>\n```'),
  '```html\n<function_call>{"name":"exec"}</function_call>\n```'
)
const emptyXmlStreamSanitizer = createVisibleAssistantStreamSanitizer()
const emptyXmlStreamChunks = [
  emptyXmlStreamSanitizer.push('继续执行。\n```x'),
  emptyXmlStreamSanitizer.push('ml\n'),
  emptyXmlStreamSanitizer.push(' \t\n'),
  emptyXmlStreamSanitizer.push('```\n完成。'),
  emptyXmlStreamSanitizer.finish()
]
const emptyXmlStreamOutput = emptyXmlStreamChunks.join('')

assert.ok(emptyXmlStreamChunks.every(chunk => !chunk.includes('```')))
assert.strictEqual(normalizeVisibleAssistantText(emptyXmlStreamOutput), '继续执行。\n\n完成。')

const splitFenceRegressionCases = [
  {
    name: 'empty-closed-fence',
    chunks: ['```xml\n', '\n', '```'],
    expected: ''
  },
  {
    name: 'half-opening-fence',
    chunks: ['```x', 'ml\n', '\n'],
    expected: ''
  },
  {
    name: 'nonempty-cross-chunk-closed-fence',
    chunks: ['```x', 'ml\n', '<root>', 'ok</root>\n', '```'],
    expected: '```xml\n<root>ok</root>\n```'
  }
]

for (const regressionCase of splitFenceRegressionCases) {
  const sanitizer = createVisibleAssistantStreamSanitizer()
  const emissions = regressionCase.chunks.map(chunk => sanitizer.push(chunk))
  emissions.push(sanitizer.finish())
  const output = emissions.join('')

  assert.strictEqual(output, regressionCase.expected, regressionCase.name)
  if (regressionCase.name === 'nonempty-cross-chunk-closed-fence') {
    assert.deepStrictEqual(emissions.slice(0, -1), ['', '', '', '', regressionCase.expected], regressionCase.name)
  } else {
    assert.ok(
      emissions.every(chunk => !chunk.includes('```')),
      regressionCase.name
    )
  }
}

const plainStreamSanitizer = createVisibleAssistantStreamSanitizer()
assert.strictEqual(plainStreamSanitizer.push('普通正文'), '普通正文')
assert.strictEqual(plainStreamSanitizer.push('\n```js\nconst value = 1\n```'), '\n```js\nconst value = 1\n```')
assert.strictEqual(plainStreamSanitizer.finish(), '')

const toolControlStreamSanitizer = createVisibleAssistantStreamSanitizer()
const toolControlStreamOutput = [
  toolControlStreamSanitizer.push('before\n<custom_tool_'),
  toolControlStreamSanitizer.push('call>{"name":"exec"}'),
  toolControlStreamSanitizer.push('</custom_tool_call>\n'),
  toolControlStreamSanitizer.push('&lt;function_call_output&gt;done'),
  toolControlStreamSanitizer.push('&lt;/function_call_output&gt;after'),
  toolControlStreamSanitizer.finish()
].join('')
assert.strictEqual(toolControlStreamOutput, 'before\n\nafter')

const escapedToolControlStreamSanitizer = createVisibleAssistantStreamSanitizer()
const escapedToolControlStreamOutput = [
  escapedToolControlStreamSanitizer.push('\\u003ctool_'),
  escapedToolControlStreamSanitizer.push('call\\u003e{"name":"exec"}'),
  escapedToolControlStreamSanitizer.push('\\u003c/tool_call\\u003evisible'),
  escapedToolControlStreamSanitizer.finish()
].join('')
assert.strictEqual(escapedToolControlStreamOutput, 'visible')

const partialToolControlStreamSanitizer = createVisibleAssistantStreamSanitizer()
assert.strictEqual(partialToolControlStreamSanitizer.push('before\n<tool_'), 'before\n')
assert.strictEqual(partialToolControlStreamSanitizer.finish(), '')

const mixedStreamSanitizer = createVisibleAssistantStreamSanitizer()
const mixedStreamOutput = [
  mixedStreamSanitizer.push('前文\n```xml\n'),
  mixedStreamSanitizer.push(' \t\n'),
  mixedStreamSanitizer.push('```\n后文'),
  mixedStreamSanitizer.finish()
].join('')
assert.strictEqual(mixedStreamOutput, '前文\n\n后文')
assert.strictEqual(
  stripEmptyInternalXml('<note></note><xml></xml><note>value</note>'),
  '<note></note><xml></xml><note>value</note>'
)
assert.strictEqual(
  normalizeVisibleAssistantText(
    '结果\n<codex_internal_adapter></codex_internal_adapter>\n<grok_tool_call></grok_tool_call>\n完成'
  ),
  '结果\n\n完成'
)
assert.strictEqual(
  decodeRepeatedEscapedLineBreaks('```js\nconst value = "\\n\\n"\n```'),
  '```js\nconst value = "\\n\\n"\n```'
)
const rawHtmlToolScaffold = `<!DOCTYPE html>
<html><head><script>async function run() {
  const tools = globalThis.tools
  return tools.shell_command({ command: 'python --version' })
}</script></head><body></body></html>
VISIBLE_PROGRESS`

assert.strictEqual(stripToolHtmlScaffold(rawHtmlToolScaffold).trim(), 'VISIBLE_PROGRESS')
assert.strictEqual(
  normalizeVisibleAssistantText(
    `${rawHtmlToolScaffold}\n<codex_tool_call>{"name":"exec","arguments":{"input":"text(1)"}}</codex_tool_call>`
  ),
  'VISIBLE_PROGRESS'
)
assert.strictEqual(
  normalizeVisibleAssistantText('<!DOCTYPE html><html><body>NORMAL_HTML_ANSWER</body></html>'),
  '<!DOCTYPE html><html><body>NORMAL_HTML_ANSWER</body></html>'
)
const encodedToolTranscript =
  'Network ready.0xa0a1e0exec0xa1input0xa2const r = await tools.shell_command({command:"python --version"}); text(r);' +
  '0xa0a1e1wait0xa1cell_id0xa22000xa1yield-time-ms0xa215000'
const encodedFrames = parseEncodedToolFrames(encodedToolTranscript)

assert.strictEqual(encodedToolFrameStart(encodedToolTranscript), 'Network ready.'.length)
assert.strictEqual(emulatedToolSyntaxStart(encodedToolTranscript, { includePartial: true }), 'Network ready.'.length)
assert.strictEqual(encodedFrames.length, 2)
assert.deepStrictEqual(encodedFrames[0], {
  name: 'exec',
  arguments: {
    input: 'const r = await tools.shell_command({command:"python --version"}); text(r);'
  }
})
assert.deepStrictEqual(encodedFrames[1], {
  name: 'wait',
  arguments: { cell_id: '200', yield_time_ms: 15000 }
})
assert.deepStrictEqual(parseEncodedToolFrames('0xa0a1e2wait0xa1cell_id0xa23000xa1terminate0xa2true'), [
  { name: 'wait', arguments: { cell_id: '300', terminate: true } }
])
assert.deepStrictEqual(parseEncodedToolFrames('0xa0a1e0exec'), [])
assert.deepStrictEqual(parseEncodedToolFrames('0xa0a1e0bad/name0xa1input0xa2ignored'), [])
assert.strictEqual(normalizeVisibleAssistantText(encodedToolTranscript), 'Network ready.')
assert.strictEqual(partialControlMarkerStart('Network ready.0xa0a1'), 'Network ready.'.length)

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

const explicitSessionContinuation = anchorShortContinuation([
  { role: 'user', content: '完成远端脚本验证并汇总结果。' },
  { role: 'assistant', content: 'I will inspect the session and continue the unfinished task.' },
  { role: 'user', content: '019ff536-a62b-7502-9263-d1bfb6c15241\n继续这个会话任务' }
])

assert.strictEqual(explicitSessionContinuation.anchored, true)
assert.strictEqual(explicitSessionContinuation.interrupted, false)
assert.strictEqual(explicitSessionContinuation.explicitSessionContinuation, true)
assert.match(explicitSessionContinuation.messages.at(-1).content, /Original task: 完成远端脚本验证/)

const nonContinuation = anchorShortContinuation([
  { role: 'user', content: '先完成一次检查。' },
  { role: 'assistant', content: '检查完成。' },
  { role: 'user', content: '继续修复 Projects 显示问题' }
])

assert.strictEqual(nonContinuation.anchored, false)

console.log('Grok Codex Agent Loop adapter tests passed')
