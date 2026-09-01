const assert = require('assert')

const {
  modelAdapterProfile,
  filterChatGptModels,
  preferredSupportedModel,
  relayTestReady
} = require('./features/modelAdapters')
const { inferredWireApiForModel, parseEmulatedToolCall, responsesRequestToChat } = require('./protocolProxy')
const {
  AGENT_COMPLETION_SIGNAL,
  agentCompletionResult,
  hasAgentCompletionSignal,
  requiresAgentCompletionSignal
} = require('./protocol/toolContinuation')
const { stripToolControlTags } = require('./protocol/visibleAssistantText')
const {
  DEFAULT_IMAGE_MODEL,
  imageGenerationPayload,
  imageToolDefinition,
  isImageGenerationModel
} = require('./protocol/newApiImageGeneration')

const nativeChatTest = {
  ok: true,
  chatOk: true,
  streamOk: true,
  agentToolOk: true,
  toolTransport: 'native',
  wireApi: 'chat'
}

const profile = modelAdapterProfile('gpt-5.6', nativeChatTest)

assert.strictEqual(profile.available, true)
assert.strictEqual(profile.adapter, 'gpt-chat')
assert.strictEqual(profile.wireApi, 'chat')
assert.strictEqual(modelAdapterProfile('grok-4.5').available, false)
assert.strictEqual(modelAdapterProfile('claude-sonnet').available, false)
assert.deepStrictEqual(filterChatGptModels(['grok-4.5', 'gpt-5.6', 'dall-e-3']), ['gpt-5.6'])
assert.strictEqual(preferredSupportedModel(['grok-4.5', 'claude-sonnet']), '')
assert.strictEqual(relayTestReady(nativeChatTest), true)

assert.strictEqual(inferredWireApiForModel('gpt-5.6'), 'responses')
assert.strictEqual(inferredWireApiForModel('grok-4.5'), '')

const converted = responsesRequestToChat(
  {
    model: 'gpt-5.6',
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

assert.strictEqual(converted.request.model, 'gpt-5.6')
assert.strictEqual(converted.request.stream, true)
assert.strictEqual(converted.request.reasoning_effort, 'medium')
assert.strictEqual(converted.request.tools[0].function.name, 'shell_command')
assert.ok(converted.request.messages.some(message => message.role === 'assistant' && message.tool_calls?.length === 1))
assert.ok(
  converted.request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_agent_loop')
)

const parsedTool = parseEmulatedToolCall(
  '<tool_call>{"name":"shell_command","arguments":{"command":"Get-ChildItem"}}</tool_call>',
  new Set(['shell_command'])
)
assert.strictEqual(parsedTool.function.name, 'shell_command')
assert.deepStrictEqual(JSON.parse(parsedTool.function.arguments), { command: 'Get-ChildItem' })
assert.strictEqual(parseEmulatedToolCall('<tool_call>{"name":"other"}</tool_call>', new Set(['shell_command'])), null)
assert.strictEqual(stripToolControlTags('<tool_call>{"name":"shell_command"}</tool_call>done'), 'done')

const signed = `已完成全部任务。\n${AGENT_COMPLETION_SIGNAL}`
assert.strictEqual(hasAgentCompletionSignal(signed), true)
assert.strictEqual(agentCompletionResult(signed), '已完成全部任务。')
assert.strictEqual(requiresAgentCompletionSignal('已完成全部任务。', { afterToolResult: true }), true)
assert.strictEqual(requiresAgentCompletionSignal(signed, { afterToolResult: true }), false)

assert.strictEqual(DEFAULT_IMAGE_MODEL, 'gpt-image-2')
assert.strictEqual(isImageGenerationModel('gpt-image-1'), true)
assert.strictEqual(isImageGenerationModel('dall-e-3'), true)
assert.strictEqual(isImageGenerationModel('grok-imagine-image-quality'), false)
assert.deepStrictEqual(imageGenerationPayload({ prompt: 'sunrise' }), {
  model: DEFAULT_IMAGE_MODEL,
  prompt: 'sunrise',
  n: 1
})
assert.deepStrictEqual(imageGenerationPayload({ model: 'gpt-image-1', prompt: 'poster', size: '1024x1024' }), {
  model: 'gpt-image-1',
  prompt: 'poster',
  n: 1,
  size: '1024x1024'
})
assert.throws(
  () => imageGenerationPayload({ model: 'grok-imagine-image-quality', prompt: 'x' }),
  /仅支持 ChatGPT\/OpenAI 图片模型/
)
assert.throws(
  () => imageGenerationPayload({ model: 'gpt-image-1', prompt: 'x', aspect_ratio: '1:1' }),
  /不支持 aspect_ratio/
)
assert.ok(imageToolDefinition({ defaultModel: 'dall-e-3' }).inputSchema.properties.response_format)

console.log('ChatGPT-only adapter and agent-loop tests passed')
