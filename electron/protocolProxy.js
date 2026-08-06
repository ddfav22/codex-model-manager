const http = require('http')
const { randomUUID } = require('crypto')
const { createParser } = require('eventsource-parser')
const {
  COMPACTION_PREFIX,
  COMPACT_PROMPT,
  DEFAULT_PROTOCOL_PROXY_PORT,
  REASONING_ORDER,
  SUMMARY_PREFIX
} = require('./protocol/constants')
const {
  canonicalModelFor,
  capabilityForModel,
  managedInstructions,
  modelIdentityInstruction,
  modelIdentityLabel,
  normalizeReasoningEffort
} = require('./protocol/modelRouting')
const { annotateDiagnostic, codexRequestContext } = require('./protocol/codexDiagnostics')
const {
  anchorShortContinuation,
  internalAgentSignalCount,
  isSyntheticChatUserMessage,
  recoveryConversationContext,
  sanitizeChatMessage,
  stripAgentControlSignals
} = require('./protocol/contextContinuity')
const {
  AGENT_COMPLETION_SIGNAL,
  agentCompletionResult,
  awaitsExplicitUserInput,
  followsImmediateToolResult,
  followsImmediateResponsesToolResult,
  hasAgentCompletionSignal,
  isMalformedToolRecovery,
  looksLikeStalledToolContinuation,
  requestLikelyRequiresTool,
  requiresAgentCompletionSignal,
  shouldAcceptContinuationRecovery
} = require('./protocol/toolContinuation')
const {
  createUpstreamSignal,
  pipeResponseBodyLimited,
  readResponseBufferLimited,
  readResponseJsonLimited,
  readResponseTextLimited
} = require('./protocol/upstreamRequest')
const { readChatAssistant } = require('./protocol/chatAssistantStream')
const {
  MAX_OPTIONAL_PARAMETER_RETRIES,
  deterministicToolCallId,
  mergeStreamedToolName,
  normalizeToolArguments,
  rejectedOptionalChatParameter,
  sanitizeChatToolHistory,
  uniqueToolCallId,
  withoutRejectedChatParameter
} = require('./protocol/newApiChatCompatibility')
const {
  hasInternalToolResult,
  internalAdapterInstruction,
  internalToolCallsTranscript,
  internalToolResultTranscript,
  stripInternalToolTranscript
} = require('./protocol/internalToolTranscript')
const { emulatedToolSyntaxStart } = require('./protocol/emulatedToolSyntax')
const { parseEncodedToolFrames } = require('./protocol/encodedToolFrames')
const { normalizeVisibleAssistantText, sanitizeVisibleAssistantDelta } = require('./protocol/visibleAssistantText')
const {
  generateNewApiImage,
  handleImageMcpRequest,
  ImageGenerationValidationError
} = require('./protocol/newApiImageGeneration')
const {
  RECOVERY_DECISION,
  parseAgentRecoveryDecision,
  recoveryDecisionContract
} = require('./protocol/agentRecoveryDecision')
const { version: APP_VERSION } = require('../package.json')

const PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS = 60_000
const PROMPT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS = 0
const PROMPT_TOOL_RECOVERY_MAX_TOKENS = 4096
const PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES = 5
const PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES = 5
const UPSTREAM_CAPACITY_MAX_RETRIES = 2
const UPSTREAM_CAPACITY_RETRY_BASE_MS = 750
const UPSTREAM_CAPACITY_RETRY_MAX_MS = 5000
const UPSTREAM_FAILURE_CLASSIFICATION_BYTES = 64 * 1024

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}

function upstreamFailureKind(status, text) {
  const code = Number(status || 0)
  const message = String(text || '').toLowerCase()

  if (
    code === 413 ||
    /context[_ -]?length[_ -]?exceeded|maximum context length|context (?:window|length).{0,40}(?:exceed|limit)|too many (?:input )?tokens|prompt (?:is )?too long|input.{0,30}too long/.test(
      message
    )
  ) {
    return 'context_too_large'
  }
  if (
    /currently experiencing high demand|high demand|selected model is at capacity|model.{0,40}(?:at capacity|overloaded)|server_is_overloaded|service[_ -]?overloaded/.test(
      message
    )
  ) {
    return 'upstream_capacity'
  }
  if (code === 408 || code === 504) return 'upstream_timeout'
  if (code === 429) return 'upstream_rate_limit'
  if (code >= 500) return 'upstream_server_error'
  if (code >= 400) return 'upstream_request_rejected'

  return 'invalid_upstream_response'
}

function retryAfterMilliseconds(response) {
  const value = String(response?.headers?.get?.('retry-after') || '').trim()

  if (!value) return null
  const seconds = Number(value)

  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.round(seconds * 1000), UPSTREAM_CAPACITY_RETRY_MAX_MS)
  const date = Date.parse(value)

  if (!Number.isFinite(date)) return null

  return Math.min(Math.max(0, date - Date.now()), UPSTREAM_CAPACITY_RETRY_MAX_MS)
}

function waitForRetry(delayMs, signal) {
  if (!delayMs) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason || new Error('upstream capacity retry aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delayMs)

    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

async function fetchWithCapacityRetry(fetcher, { signal, maxRetries = UPSTREAM_CAPACITY_MAX_RETRIES } = {}) {
  let retryCount = 0
  let retryDelayMs = 0

  while (true) {
    const response = await fetcher()

    if (response.ok) {
      response.codexRetryDiagnostic = { retryCount, retryDelayMs, failureKind: '' }
      return response
    }
    let errorText = ''

    try {
      errorText = await readResponseTextLimited(response.clone(), UPSTREAM_FAILURE_CLASSIFICATION_BYTES)
    } catch {
      // Oversized or malformed error bodies are forwarded without automatic retries.
    }
    const failureKind = upstreamFailureKind(response.status, errorText)

    if (failureKind !== 'upstream_capacity' || retryCount >= maxRetries) {
      response.codexRetryDiagnostic = { retryCount, retryDelayMs, failureKind }
      return response
    }

    const headerDelay = retryAfterMilliseconds(response)
    const delayMs =
      headerDelay === null
        ? Math.min(UPSTREAM_CAPACITY_RETRY_BASE_MS * 2 ** retryCount, UPSTREAM_CAPACITY_RETRY_MAX_MS)
        : headerDelay

    retryCount += 1
    retryDelayMs += delayMs
    await response.body?.cancel?.()
    await waitForRetry(delayMs, signal)
  }
}

function upstreamDiagnostic(diagnostic, upstream, errorText = '') {
  const retry = upstream?.codexRetryDiagnostic || {}
  const chatCompatibility = upstream?.codexChatCompatibility || {}

  return {
    ...diagnostic,
    upstreamStatus: Number(upstream?.status || 0),
    upstreamFailureKind: retry.failureKind || (upstream?.ok ? '' : upstreamFailureKind(upstream?.status, errorText)),
    upstreamRetryCount: Number(retry.retryCount || 0),
    upstreamRetryDelayMs: Number(retry.retryDelayMs || 0),
    chatCompatibilityRetryCount: Array.isArray(chatCompatibility.removedParameters)
      ? chatCompatibility.removedParameters.length
      : 0,
    chatCompatibilityRemovedParameters: Array.isArray(chatCompatibility.removedParameters)
      ? chatCompatibility.removedParameters
      : [],
    effectiveChatRequestBytes: Number(chatCompatibility.requestBytes || 0)
  }
}

function userFacingUpstreamFailure(kind, retryCount) {
  if (kind === 'upstream_capacity') {
    return `模型渠道当前负载较高，已自动重试 ${retryCount} 次仍未恢复；请稍后回复“继续”，或切换其他模型或渠道。`
  }
  if (kind === 'context_too_large') {
    return '本轮对话上下文过大，模型渠道无法接收；请让 Codex 压缩上下文，或新建任务后继续。'
  }

  return ''
}

function recoveryFailureKindForStatus(status) {
  const code = Number(status || 0)

  if (code === 408 || code === 504) return 'http_timeout'
  if (code === 429) return 'http_rate_limit'
  if (code >= 500) return 'http_server_error'
  if (code >= 400) return 'http_request_rejected'

  return 'invalid_upstream_response'
}

function recoveryFailureKindForError(error) {
  const message = String(error?.message || error || '').toLowerCase()

  if (error?.name === 'AbortError' || /timed?\s*out|timeout|aborted/.test(message)) return 'timeout'

  return 'transport_error'
}

function recoveryFailureMessage(failureKinds) {
  const kinds = Array.isArray(failureKinds) ? failureKinds : []

  if (kinds.includes('timeout') || kinds.includes('http_timeout')) {
    return '模型续接等待 60 秒仍未返回，自动重试已暂停；渠道恢复后回复“继续”即可从当前任务继续。'
  }
  if (kinds.includes('http_rate_limit')) {
    return '模型渠道当前请求过多，自动重试已暂停；稍后回复“继续”即可从当前任务继续。'
  }
  if (kinds.includes('http_server_error')) {
    return '模型渠道服务暂时不可用，自动重试已暂停；服务恢复后回复“继续”即可从当前任务继续。'
  }
  if (kinds.includes('http_request_rejected')) {
    return '模型渠道拒绝了续接请求，请检查渠道与模型配置后回复“继续”。'
  }

  return '模型渠道连续连接失败，自动续接已暂停；网络恢复后回复“继续”即可从当前任务继续。'
}

async function runWithAbortTimeout(parentSignal, timeoutMs, task) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  const timer = setTimeout(() => controller.abort(new Error('prompt tool recovery timed out')), timeoutMs)

  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true })

  try {
    return await task(controller.signal)
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener?.('abort', abortFromParent)
  }
}

function encodeSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(String(summary || ''), 'utf8').toString('base64')
}

function decodeSummary(value) {
  if (typeof value !== 'string' || !value.startsWith(COMPACTION_PREFIX)) return undefined

  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

function responseMessageItem(text, role = 'user') {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(text || '') }]
  }
}

function normalizeCompactionInput(input) {
  if (!Array.isArray(input)) return input

  return input
    .filter(item => item?.type !== 'compaction_trigger')
    .map(item => {
      if (item?.type !== 'compaction') return item
      const summary = decodeSummary(item.encrypted_content)

      return responseMessageItem(
        summary === undefined
          ? '[Earlier conversation history was compacted in a format this local proxy cannot read.]'
          : `${SUMMARY_PREFIX}\n\n${summary}`
      )
    })
}

function normalizedToolItemId(id, prefix) {
  const value = String(id || '')

  if (!value || value.startsWith(prefix)) return value

  const suffix = value.replace(/^[a-z][a-z0-9]*_/i, '')

  return `${prefix}${suffix || value}`
}

function normalizeResponsesToolItemIds(input) {
  if (!Array.isArray(input)) return input

  return input.map(item => {
    const prefix = item?.type === 'custom_tool_call' ? 'ctc_' : item?.type === 'function_call' ? 'fc_' : ''

    if (!prefix || typeof item.id !== 'string') return item

    const id = normalizedToolItemId(item.id, prefix)

    return id === item.id ? item : { ...item, id }
  })
}

function adaptResponsesRequest(body, capability) {
  const normalizedInput = normalizeResponsesToolItemIds(normalizeCompactionInput(body.input))
  const request = {
    ...body,
    input: normalizedInput,
    instructions: managedInstructions(body.instructions, body, body.model)
  }
  const effort = normalizeReasoningEffort(body.reasoning?.effort, capability?.reasoningEfforts)

  if (body.reasoning && typeof body.reasoning === 'object') {
    request.reasoning = { ...body.reasoning }
    if (effort) request.reasoning.effort = effort
    else delete request.reasoning.effort
    if (!capability?.supportsReasoningSummaries) delete request.reasoning.summary
    if (!Object.keys(request.reasoning).length) delete request.reasoning
  }
  if (!capability?.speedModes?.includes('fast')) delete request.service_tier
  if (!capability?.supportsVerbosity && request.text && typeof request.text === 'object') {
    request.text = { ...request.text }
    delete request.text.verbosity
  }

  return request
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content || '')

  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') return part.text || ''

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function combineAssistantContent(target, source) {
  const sourceContent = source.content

  if (sourceContent === undefined || sourceContent === null) return
  if (target.content === undefined || target.content === null || target.content === '') {
    target.content = sourceContent
    return
  }
  if (typeof target.content === 'string' && typeof sourceContent === 'string') {
    target.content = `${target.content}\n${sourceContent}`
    return
  }

  const targetBlocks = Array.isArray(target.content) ? target.content : [target.content]
  const sourceBlocks = Array.isArray(sourceContent) ? sourceContent : [sourceContent]

  target.content = [...targetBlocks, ...sourceBlocks]
}

function coalesceAssistantMessages(messages) {
  const result = []

  for (const message of Array.isArray(messages) ? messages : []) {
    const previous = result[result.length - 1]

    if (
      message?.role === 'assistant' &&
      previous?.role === 'assistant' &&
      (Array.isArray(previous.tool_calls) || Array.isArray(message.tool_calls))
    ) {
      combineAssistantContent(previous, message)
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        previous.tool_calls = [...(previous.tool_calls || []), ...message.tool_calls]
      }
      continue
    }

    result.push(message)
  }

  return result
}

function chatMessagesFromInput(instructions, input, toolNames) {
  const messages = []

  if (instructions) messages.push({ role: 'system', content: String(instructions) })

  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === 'message' || (!item?.type && item?.role)) {
      const role = item.role === 'developer' ? 'system' : item.role || 'user'
      const content = textFromContent(item.content)

      if (content) messages.push({ role, content })
      continue
    }

    if (item?.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: toolNames.toChat(item.name),
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
            }
          }
        ]
      })
      continue
    }

    if (item?.type === 'custom_tool_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: toolNames.toChat(item.name),
              arguments: JSON.stringify({ input: String(item.input || '') })
            }
          }
        ]
      })
      continue
    }

    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      })
    }
  }

  if (!messages.length && typeof input === 'string') messages.push({ role: 'user', content: input })

  return coalesceAssistantMessages(messages)
}

function createToolNameMap() {
  const chatToResponses = new Map()
  const responsesToChat = new Map()
  const customResponseNames = new Set()
  const normalize = value =>
    String(value || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64)
  const register = (responseName, options = {}) => {
    const base = normalize(responseName) || 'tool'
    let chatName = base
    let suffix = 2

    while (chatToResponses.has(chatName) && chatToResponses.get(chatName) !== responseName) {
      chatName = `${base.slice(0, 58)}_${suffix}`
      suffix += 1
    }

    chatToResponses.set(chatName, responseName)
    responsesToChat.set(responseName, chatName)
    if (options.custom) customResponseNames.add(responseName)

    return chatName
  }

  return {
    register,
    toChat: responseName => responsesToChat.get(responseName) || register(responseName),
    toResponses: chatName => chatToResponses.get(chatName) || chatName,
    isCustomChat: chatName => customResponseNames.has(chatToResponses.get(chatName) || chatName)
  }
}

function chatToolsFromResponses(tools, toolNames) {
  const result = []
  const addFunction = (tool, responseName) => {
    result.push({
      type: 'function',
      function: {
        name: toolNames.register(responseName),
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {})
      }
    })
  }

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'function') {
      addFunction(tool, tool.name)
      continue
    }

    if (tool?.type === 'custom') {
      result.push({
        type: 'function',
        function: {
          name: toolNames.register(tool.name, { custom: true }),
          description: `${tool.description || 'Run this tool with free-form input.'}\nPass the complete free-form tool input in the input field.`,
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: 'Complete free-form input for this tool.' }
            },
            required: ['input'],
            additionalProperties: false
          }
        }
      })
      continue
    }

    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) addFunction(nested, `${tool.name}.${nested.name}`)
    }
  }

  return result
}

function responsesRequestToChat(body, capability = null) {
  const toolNames = createToolNameMap()
  const tools = chatToolsFromResponses(body.tools, toolNames)
  const toolHistory = sanitizeChatToolHistory(
    chatMessagesFromInput(
      managedInstructions(body.instructions, body, body.model),
      normalizeCompactionInput(body.input),
      toolNames
    )
  )
  const request = {
    model: body.model,
    messages: toolHistory.messages,
    stream: body.stream !== false
  }

  if (request.stream) request.stream_options = { include_usage: true }

  if (tools.length) request.tools = tools
  if (tools.length && body.tool_choice) {
    if (typeof body.tool_choice === 'string') {
      request.tool_choice = body.tool_choice
    } else if (body.tool_choice?.name) {
      request.tool_choice = {
        type: 'function',
        function: { name: toolNames.toChat(body.tool_choice.name) }
      }
    } else {
      request.tool_choice = 'auto'
    }
  }
  if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls
  const reasoningEffort = normalizeReasoningEffort(
    body.reasoning?.effort,
    capability?.reasoningEfforts || REASONING_ORDER
  )

  if (reasoningEffort) request.reasoning_effort = reasoningEffort
  if (body.temperature !== undefined && body.temperature !== null) request.temperature = body.temperature
  if (body.top_p !== undefined && body.top_p !== null) request.top_p = body.top_p
  if (body.max_output_tokens) request.max_tokens = body.max_output_tokens
  if (
    capability?.adapter === 'gpt-chat' &&
    capability?.speedModes?.includes('fast') &&
    body.service_tier === 'priority'
  ) {
    request.service_tier = 'priority'
  }
  if (capability?.supportsVerbosity && body.text?.verbosity) request.verbosity = body.text.verbosity

  return { request, toolNames, compatibility: toolHistory.diagnostics }
}

function upstreamRejectsNativeTools(text) {
  return /tool calls? (?:are|is) not supported|does not support (?:tool|function) calls?|tools? (?:are|is) not supported/i.test(
    String(text || '')
  )
}

async function sendChatWithCompatibilityFallback(sendRequest, payload) {
  let compatiblePayload = payload
  const removedParameters = []

  for (let attempt = 0; attempt <= MAX_OPTIONAL_PARAMETER_RETRIES; attempt += 1) {
    const upstream = await sendRequest(compatiblePayload)

    if (upstream.ok) {
      upstream.codexChatCompatibility = {
        removedParameters,
        requestBytes: jsonByteLength(compatiblePayload)
      }
      return upstream
    }

    const errorBody = await readResponseTextLimited(upstream)
    const rejectedParameter = rejectedOptionalChatParameter(upstream.status, errorBody, compatiblePayload)

    if (
      !rejectedParameter ||
      removedParameters.includes(rejectedParameter) ||
      attempt >= MAX_OPTIONAL_PARAMETER_RETRIES
    ) {
      upstream.codexChatCompatibility = {
        removedParameters,
        requestBytes: jsonByteLength(compatiblePayload),
        errorBody
      }
      return upstream
    }

    compatiblePayload = withoutRejectedChatParameter(compatiblePayload, rejectedParameter)
    removedParameters.push(rejectedParameter)
  }

  throw new Error('NewAPI 兼容重试状态异常')
}

async function chatUpstreamErrorBody(upstream) {
  if (typeof upstream?.codexChatCompatibility?.errorBody === 'string') {
    return upstream.codexChatCompatibility.errorBody
  }

  return readResponseTextLimited(upstream)
}

function promptToolCatalog(tools, messages = []) {
  const conversationText = (Array.isArray(messages) ? messages : [])
    .slice(-8)
    .map(message => String(message?.content || ''))
    .join('\n')
    .toLowerCase()
  const coreTools = new Set([
    'exec',
    'shell_command',
    'wait',
    'request_user_input',
    'update_plan',
    'view_image',
    'list_mcp_resources',
    'read_mcp_resource'
  ])

  return (Array.isArray(tools) ? tools : [])
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map((tool, index) => {
      const name = String(tool.function.name)
      const nameTerms = name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(term => term.length >= 3)
      const relevance = nameTerms.reduce(
        (score, term) => score + (conversationText.includes(term) ? 20 : 0),
        coreTools.has(name) ? 1000 : 0
      )

      return { tool, index, relevance }
    })
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, 24)
    .map(({ tool }) => ({
      name: tool.function.name,
      description: String(tool.function.description || '').slice(0, 600),
      parameters: tool.function.parameters || { type: 'object', properties: {} }
    }))
}

function managerImageTool(catalog) {
  return catalog.find(
    tool =>
      /generate[_-]?image/i.test(String(tool?.name || '')) &&
      /newapi|images\/generations/i.test(String(tool?.description || ''))
  )
}

function execToolContract(catalog) {
  if (!catalog.some(tool => tool.name === 'exec')) return ''
  const imageTool = managerImageTool(catalog)

  return [
    'Special contract for the exec tool: arguments.input must be valid JavaScript for the Codex tool orchestrator, never raw PowerShell or cmd text.',
    'For Windows shell or GUI actions, call the nested shell tool and return its result, for example:',
    '{"name":"exec","arguments":{"input":"const result = await tools.shell_command({command:\\"Start-Process calc.exe\\"}); text(result);"}}',
    'Current or time-sensitive facts require a tool result. Never answer prices, rates, weather, news, scores, schedules, availability, or other live data from memory.',
    'For live web information, call the nested web tool through exec and return its result, for example:',
    '{"name":"exec","arguments":{"input":"const result = await tools.web__run({search_query:[{q:\\"today gold price\\"}],response_length:\\"short\\"}); text(result);"}}',
    ...(!imageTool
      ? [
          'For an image-generation request, use exec to call the nested image generator and return its image result; do not stop after reading an image skill, for example:',
          '{"name":"exec","arguments":{"input":"const result = await tools.image_gen__imagegen({prompt:\\"the user requested image\\"}); generatedImage(result);"}}'
        ]
      : [])
  ].join('\n')
}

function imageGenerationToolContract(catalog) {
  const imageTool = managerImageTool(catalog)

  if (!imageTool) return ''

  return [
    `For an image-generation request, call the allowed ${imageTool.name} tool; do not stop after reading an image skill.`,
    `Example: <codex_tool_call>{"name":${JSON.stringify(imageTool.name)},"arguments":{"prompt":"the user requested image"}}</codex_tool_call>`
  ].join('\n')
}

function toolEmulationRequest(request) {
  const sourceMessages = Array.isArray(request.messages) ? request.messages : []
  const continuation = anchorShortContinuation(sourceMessages)
  const originalMessages = continuation.messages
  const catalog = promptToolCatalog(request.tools, originalMessages)
  const allowed = new Set(catalog.map(tool => tool.name))
  const messages = []
  const removedControlSignalCount = sourceMessages.reduce(
    (count, message) => count + internalAgentSignalCount(message?.content),
    0
  )

  for (const originalMessage of originalMessages) {
    const message = sanitizeChatMessage(originalMessage)

    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls
        .filter(call => allowed.has(String(call?.function?.name || '')))
        .map(call => ({
          name: call.function.name,
          arguments: call.function.arguments || '{}',
          call_id: call.id || ''
        }))
      const content = [message.content, calls.length ? internalToolCallsTranscript(calls) : '']
        .filter(Boolean)
        .join('\n')

      messages.push({ role: 'assistant', content: content || null })
      continue
    }

    if (message?.role === 'tool') {
      messages.push({
        role: 'user',
        content: internalToolResultTranscript(message.tool_call_id, message.content)
      })
      continue
    }

    messages.push(message)
  }

  const instructions = [
    'You are the selected upstream model operating inside the Codex local agent runtime; retain the managed model identity stated above.',
    'The upstream endpoint cannot accept native tool definitions, but Codex can still execute the tools listed below.',
    'Messages wrapped in codex_internal_tool_history or codex_internal_adapter are private adapter state. Use them for continuity but never quote, reproduce, or mention their tags or payloads in a user-visible answer.',
    'When a tool is needed, output exactly one tool call and no other text using this format:',
    '<codex_tool_call>{"name":"TOOL_NAME","arguments":{}}</codex_tool_call>',
    'TOOL_NAME must exactly match an allowed tool name. arguments must satisfy that tool JSON schema.',
    'Never claim that a computer action succeeded until a matching internal tool-result record is present in the conversation.',
    'A returned tool-result record means the requested action has finished. Continue the same task immediately: call the next required tool, provide the completed answer, or request one genuinely missing user input.',
    'For a request with multiple actions, keep continuing after every local tool result until every requested action has a verified result. A sentence that only announces the next step is visible progress, not a final answer.',
    'Do not stop after saying that you will switch methods, write a script, fetch data, open an app, save a file, run another command, or continue. Emit the next tool call in the same turn.',
    `After every requested action has a verified result, provide the final result and append the exact line ${AGENT_COMPLETION_SIGNAL} as the last line.`,
    `Never emit ${AGENT_COMPLETION_SIGNAL} with a tool call, while work remains, after a plan-only sentence, or when genuine user input is missing.`,
    'Reading a SKILL.md file is an intermediate tool result, not a stopping point. Follow the skill instructions and continue its workflow in the same turn.',
    execToolContract(catalog),
    imageGenerationToolContract(catalog),
    `Allowed tools: ${JSON.stringify(catalog)}`
  ]
    .filter(Boolean)
    .join('\n')
  const firstSystem = messages.find(message => message?.role === 'system')

  if (firstSystem) firstSystem.content = `${String(firstSystem.content || '')}\n\n${instructions}`
  else messages.unshift({ role: 'system', content: instructions })

  const lastUser = [...messages].reverse().find(message => message?.role === 'user')

  if (lastUser) {
    const toolResultReturned = hasInternalToolResult(lastUser.content)
    const adapterInstruction = toolResultReturned
      ? `The returned tool result is available. Continue the original task now. Do not merely say that you will read, inspect, generate, or continue. If the next action is available, emit its codex_tool_call now; if user input is truly missing, call request_user_input when allowed or ask one concrete question. Only after the task is fully complete, end the result with ${AGENT_COMPLETION_SIGNAL}.`
      : 'If this request needs a local action, return the codex_tool_call marker before claiming success.'

    lastUser.content = `${String(lastUser.content || '')}\n\n${internalAdapterInstruction(adapterInstruction)}`
  }

  const payload = { ...request, messages }

  delete payload.tools
  delete payload.tool_choice
  delete payload.parallel_tool_calls

  return {
    payload,
    allowed,
    catalog,
    contextContinuity: {
      sourceMessageCount: originalMessages.length,
      forwardedMessageCount: messages.length,
      actionableUserMessageCount: messages.filter(
        message => message?.role === 'user' && !isSyntheticChatUserMessage(message)
      ).length,
      removedControlSignalCount,
      shortContinuationAnchored: continuation.anchored,
      interruptedContinuationAnchored: continuation.anchored && continuation.interrupted,
      continuationTaskLength: continuation.task.length,
      continuationAssistantStateLength: continuation.assistantState.length,
      continuationToolResultCount: continuation.toolResultCount
    }
  }
}

function normalizeEmulatedToolArguments(name, value) {
  let parsed = value

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = name === 'exec' ? { input: value } : value
    }
  }

  if (name !== 'exec' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof value === 'string' ? value : JSON.stringify(value || {})
  }

  const input = String(parsed.input || '')
  const looksLikeToolJavaScript =
    /\btools\.[a-zA-Z0-9_]+\s*\(|\b(?:const|let|var)\s+[a-zA-Z_$]|\bawait\s+|\btext\s*\(|\bimage\s*\(/.test(input)

  if (!input || looksLikeToolJavaScript) return JSON.stringify(parsed)

  const wrapped = `const result = await tools.shell_command(${JSON.stringify({ command: input })}); ` + 'text(result);'

  return JSON.stringify({ ...parsed, input: wrapped })
}

function firstBalancedJsonObject(text) {
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }

  return ''
}

function parseEmulatedToolCall(content, allowed) {
  const text = String(content || '').slice(0, 1024 * 1024)
  const encodedFrame = parseEncodedToolFrames(text).find(frame => allowed.has(frame.name))

  if (encodedFrame) {
    return {
      id: `call_${randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: {
        name: encodedFrame.name,
        arguments: normalizeEmulatedToolArguments(encodedFrame.name, encodedFrame.arguments).slice(0, 1024 * 1024)
      }
    }
  }
  const marker = text.match(/<codex_tool_call>\s*([\s\S]{1,1048576}?)\s*<\/codex_tool_call>/i)
  const fenced = text.match(/```(?:json)?\s*([\s\S]{1,1048576}?)\s*```/i)
  const candidates = [
    ...new Set([marker?.[1], fenced?.[1], text.trim(), firstBalancedJsonObject(text)].filter(Boolean))
  ]

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw)
      const envelope = parsed?.tool_call || parsed?.function || parsed
      const name = String(envelope?.name || envelope?.tool || envelope?.tool_name || '')

      if (!allowed.has(name)) continue

      let argumentValue = envelope?.arguments ?? envelope?.args

      if (argumentValue === undefined && name === 'exec' && envelope?.input !== undefined) {
        argumentValue = { input: envelope.input }
      }
      if (argumentValue === undefined) argumentValue = {}

      const args = normalizeEmulatedToolArguments(name, argumentValue)

      return {
        id: `call_${randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: { name, arguments: args.slice(0, 1024 * 1024) }
      }
    } catch {
      // Try the next common Grok-compatible tool envelope.
    }
  }

  return null
}

async function synthesizeEmulatedToolResponse(
  upstream,
  request,
  allowed,
  retryAssistant,
  sourceInput = [],
  options = {}
) {
  const synthesisStartedAt = Date.now()
  const progressMessages = []
  const publishedProgressMessages = new Set()
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const onProgressStart = typeof options.onProgressStart === 'function' ? options.onProgressStart : null
  const onProgressDelta = typeof options.onProgressDelta === 'function' ? options.onProgressDelta : null
  const onProgressEnd = typeof options.onProgressEnd === 'function' ? options.onProgressEnd : null
  let firstProgressDeltaMs = -1
  let progressDeltaCount = 0
  const callProgress = (callback, value) => {
    if (!callback) return false

    try {
      callback(value)

      return true
    } catch {
      // Downstream cancellation must not corrupt the bounded recovery state.
      return false
    }
  }
  const publishProgressDelta = delta => {
    if (!delta || !callProgress(onProgressDelta, delta)) return
    if (firstProgressDeltaMs < 0) firstProgressDeltaMs = Date.now() - synthesisStartedAt
    progressDeltaCount += 1
  }
  const convertedFollowsToolResult = followsImmediateToolResult(request?.messages)
  const sourceFollowsToolResult = followsImmediateResponsesToolResult(sourceInput)
  const followsToolResult = convertedFollowsToolResult || sourceFollowsToolResult
  const likelyRequiresTool = requestLikelyRequiresTool(request?.messages, allowed)
  const visibleAssistantText = content =>
    normalizeVisibleAssistantText(stripInternalToolTranscript(stripAgentControlSignals(content)))
  const rememberProgress = content => {
    const text = visibleAssistantText(content)

    if (!text || isMalformedToolRecovery(text) || progressMessages.includes(text)) return ''
    progressMessages.push(text)

    return text
  }
  const createProgressObserver = () => {
    let buffer = ''
    let emittedLength = 0
    let streaming = false
    let closed = false

    const safeText = (includePartial = false) => {
      const syntaxStart = emulatedToolSyntaxStart(buffer, { includePartial })

      return syntaxStart >= 0 ? buffer.slice(0, syntaxStart) : buffer
    }
    const onContentDelta = (_delta, snapshot) => {
      if (closed) return
      buffer = String(snapshot || buffer)
      const visible = normalizeVisibleAssistantText(
        stripAgentControlSignals(stripInternalToolTranscript(safeText(true)))
      )

      if (!streaming) {
        if (!visible) return
        const stalled = looksLikeStalledToolContinuation(visible, { afterToolResult: followsToolResult })

        if (!stalled || !onProgressStart || !onProgressDelta || !onProgressEnd) return
        streaming = true
        callProgress(onProgressStart)
      }
      if (visible.length <= emittedLength) return
      publishProgressDelta(visible.slice(emittedLength))
      emittedLength = visible.length
    }
    const finish = content => {
      if (closed) return false
      closed = true
      buffer = String(content || buffer)
      const visible = visibleAssistantText(safeText())

      if (!streaming) return false
      if (visible.length > emittedLength) publishProgressDelta(visible.slice(emittedLength))
      callProgress(onProgressEnd)
      const remembered = rememberProgress(visible)

      if (remembered) publishedProgressMessages.add(remembered)

      return true
    }

    return { finish, onContentDelta }
  }
  const initialProgressObserver = createProgressObserver()
  let assistant = await readChatAssistant(upstream, { onContentDelta: initialProgressObserver.onContentDelta })

  initialProgressObserver.finish(assistant.content)
  const initialAssistant = assistant
  const initialResponseMs = Date.now() - synthesisStartedAt
  const rawFirstContent = String(assistant.content || '')
  const firstContent = stripInternalToolTranscript(rawFirstContent)
  let toolCall = parseEmulatedToolCall(firstContent, allowed)
  let retryContent = ''
  const toolIntentRequired = !followsToolResult && !toolCall && likelyRequiresTool
  const initialNaturalStall =
    !toolCall && looksLikeStalledToolContinuation(firstContent, { afterToolResult: followsToolResult })
  const initialMissingCompletionSignal =
    !toolCall && requiresAgentCompletionSignal(firstContent, { afterToolResult: followsToolResult })
  const initialToolOmission = toolIntentRequired && !toolCall && !awaitsExplicitUserInput(firstContent)
  const initialStalledContinuation = initialNaturalStall || initialMissingCompletionSignal || initialToolOmission
  const stalledAfterToolResult = followsToolResult && initialStalledContinuation
  const inferredTerminalCandidate = false
  const unlimitedRecovery = initialStalledContinuation
  const maximumRecoveryAttempts = 0
  const maximumRecoveryMs = Math.max(0, Number(options.maximumRecoveryMs || 0)) || Infinity
  const recoveryBudgetStartedAt = Date.now()
  let recoveryAssistant = assistant
  let recoveryAttempts = 0
  let currentStalledContinuation = initialStalledContinuation
  let currentNaturalStall = initialNaturalStall
  let currentMissingCompletionSignal = initialMissingCompletionSignal
  let acceptedRetry = false
  let safetyStopTriggered = false
  const inferredCompletionAccepted = false
  let failedRecoveryAttempts = 0
  let consecutiveRecoveryFailures = 0
  let repeatedRecoveryResponses = 0
  let previousRecoveryFingerprint = ''
  let recoveryCircuitBreaker = ''
  const recoveryRequestMs = []
  const recoveryFailureKinds = []
  const recoveryDecisionKinds = []
  const publishProgress = content => {
    const text = visibleAssistantText(content)

    if (!onProgress || !text || isMalformedToolRecovery(text) || publishedProgressMessages.has(text)) return
    rememberProgress(text)

    try {
      onProgress(text)
      publishedProgressMessages.add(text)
    } catch {
      // A disconnected downstream must not alter the bounded recovery decision.
    }
  }

  if (!toolCall && initialNaturalStall) rememberProgress(firstContent)

  while (
    !toolCall &&
    (unlimitedRecovery || recoveryAttempts < maximumRecoveryAttempts) &&
    Date.now() - recoveryBudgetStartedAt < maximumRecoveryMs &&
    currentStalledContinuation &&
    !recoveryCircuitBreaker &&
    typeof retryAssistant === 'function'
  ) {
    if (currentNaturalStall) publishProgress(recoveryAssistant.content)
    recoveryAttempts += 1
    const recoveryStartedAt = Date.now()
    const failureCountBeforeAttempt = recoveryFailureKinds.length
    const remainingRecoveryMs = Number.isFinite(maximumRecoveryMs)
      ? Math.max(1, maximumRecoveryMs - (recoveryStartedAt - recoveryBudgetStartedAt))
      : 0
    const retryProgressObserver = createProgressObserver()
    const retried = await retryAssistant(recoveryAssistant, {
      followsToolResult,
      stalledAfterToolResult: followsToolResult && currentStalledContinuation,
      stalledContinuation: currentStalledContinuation,
      naturalStall: currentNaturalStall,
      missingCompletionSignal: currentMissingCompletionSignal,
      toolIntentRequired,
      attempt: recoveryAttempts,
      maximumAttempts: maximumRecoveryAttempts,
      unlimitedRecovery,
      consecutiveFailedAttempts: consecutiveRecoveryFailures,
      remainingRecoveryMs,
      recordFailure: kind => {
        const normalized = String(kind || '').trim()

        if (normalized) recoveryFailureKinds.push(normalized)
      },
      onContentDelta: retryProgressObserver.onContentDelta
    })
    retryProgressObserver.finish(retried?.content)
    recoveryRequestMs.push(Date.now() - recoveryStartedAt)

    if (!retried) {
      if (recoveryFailureKinds.length === failureCountBeforeAttempt) recoveryFailureKinds.push('unknown')
      failedRecoveryAttempts += 1
      consecutiveRecoveryFailures += 1
      if (unlimitedRecovery && consecutiveRecoveryFailures >= PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES) {
        recoveryCircuitBreaker = 'consecutive_transport_failures'
      }
      continue
    }
    consecutiveRecoveryFailures = 0

    const visibleRetryContent = stripInternalToolTranscript(retried?.content)
    const recoveryDecision = parseAgentRecoveryDecision(visibleRetryContent)
    let normalizedRetryContent = visibleRetryContent

    recoveryDecisionKinds.push(recoveryDecision?.type || 'legacy')
    if (recoveryDecision?.type === RECOVERY_DECISION.COMPLETE) {
      const decisionAnswer = recoveryDecision.content

      if (!looksLikeStalledToolContinuation(decisionAnswer, { afterToolResult: followsToolResult })) {
        normalizedRetryContent = `${decisionAnswer}\n${AGENT_COMPLETION_SIGNAL}`
      }
    } else if (recoveryDecision?.type === RECOVERY_DECISION.NEEDS_INPUT) {
      normalizedRetryContent = recoveryDecision.content
    }
    const explicitUserInputRequired = recoveryDecision?.type === RECOVERY_DECISION.NEEDS_INPUT
    const retriedToolCall = retried ? parseEmulatedToolCall(visibleRetryContent, allowed) : null

    retryContent = normalizedRetryContent
    const retryNaturalStall =
      !retriedToolCall &&
      !explicitUserInputRequired &&
      looksLikeStalledToolContinuation(retryContent, { afterToolResult: followsToolResult })
    const retryMissingCompletionSignal =
      !retriedToolCall &&
      !explicitUserInputRequired &&
      requiresAgentCompletionSignal(retryContent, { afterToolResult: followsToolResult })
    const retryToolOmission =
      toolIntentRequired && !retriedToolCall && !explicitUserInputRequired && !awaitsExplicitUserInput(retryContent)
    const retryStalledContinuation = retryNaturalStall || retryMissingCompletionSignal || retryToolOmission

    if (retryStalledContinuation) {
      const recoveryFingerprint = String(retryContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

      if (recoveryFingerprint && recoveryFingerprint === previousRecoveryFingerprint) {
        repeatedRecoveryResponses += 1
      } else {
        previousRecoveryFingerprint = recoveryFingerprint
        repeatedRecoveryResponses = recoveryFingerprint ? 1 : 0
      }
      if (unlimitedRecovery && repeatedRecoveryResponses >= PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES) {
        recoveryCircuitBreaker = 'identical_stalled_responses'
      }
    }

    if (!retriedToolCall && retryNaturalStall) rememberProgress(retryContent)

    if (
      !retryToolOmission &&
      shouldAcceptContinuationRecovery({
        afterToolResult: followsToolResult,
        explicitUserInputRequired,
        stalledAfterToolResult: followsToolResult && currentStalledContinuation,
        stalledContinuation: currentStalledContinuation,
        retryContent,
        retryToolCall: retriedToolCall
      })
    ) {
      assistant = { ...retried, content: normalizedRetryContent }
      toolCall = retriedToolCall
      acceptedRetry = true
      break
    }

    if (!retryStalledContinuation || recoveryCircuitBreaker) break

    recoveryAssistant = retried
    currentStalledContinuation = true
    currentNaturalStall = retryNaturalStall
    currentMissingCompletionSignal = retryMissingCompletionSignal
  }
  const recoveryElapsedMs = Date.now() - recoveryBudgetStartedAt
  const recoveryTimeBudgetExhausted =
    initialStalledContinuation &&
    !acceptedRetry &&
    (unlimitedRecovery || recoveryAttempts < maximumRecoveryAttempts) &&
    recoveryElapsedMs >= maximumRecoveryMs
  const exhaustedRecovery =
    initialStalledContinuation &&
    !acceptedRetry &&
    (Boolean(recoveryCircuitBreaker) ||
      (!unlimitedRecovery && recoveryAttempts >= maximumRecoveryAttempts) ||
      recoveryTimeBudgetExhausted)

  if (!toolCall && exhaustedRecovery) {
    const finalText = recoveryCircuitBreaker
      ? recoveryCircuitBreaker === 'consecutive_transport_failures'
        ? recoveryFailureMessage(recoveryFailureKinds)
        : '模型连续返回相同的中间计划，自动续接已暂停；回复“继续”即可从当前任务继续。'
      : isMalformedToolRecovery(initialAssistant.content)
        ? 'The upstream model did not produce a valid Codex tool call.'
        : hasAgentCompletionSignal(initialAssistant.content)
          ? agentCompletionResult(initialAssistant.content)
          : String(initialAssistant.content || '').trim()

    assistant = {
      ...initialAssistant,
      content: publishedProgressMessages.has(finalText) ? '' : finalText
    }
    safetyStopTriggered = !awaitsExplicitUserInput(initialAssistant.content)
  }
  const acceptedCompletionSignal = !toolCall && hasAgentCompletionSignal(assistant.content)

  if (!toolCall) assistant = { ...assistant, content: visibleAssistantText(assistant.content) }
  const visibleProgressMessages =
    toolCall || acceptedRetry || publishedProgressMessages.size
      ? progressMessages.filter(text => toolCall || text !== String(assistant.content || '').trim())
      : []
  const pendingProgressMessages = visibleProgressMessages.filter(text => !publishedProgressMessages.has(text))
  const id = assistant.id || `chatcmpl-${randomUUID()}`
  const model = assistant.model || request.model
  const created = Math.floor(Date.now() / 1000)
  const message = toolCall
    ? { role: 'assistant', content: null, tool_calls: [toolCall] }
    : { role: 'assistant', content: assistant.content }
  const finishReason = toolCall ? 'tool_calls' : 'stop'
  const payload = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: assistant.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  const detail = {
    firstContentLength: firstContent.length,
    internalTranscriptSuppressed: rawFirstContent !== firstContent,
    retryContentLength: retryContent.length,
    initialResponseMs,
    recoveryRequestMs,
    recoveryAttemptTimeoutMs: PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS,
    totalSynthesisMs: Date.now() - synthesisStartedAt,
    retryStartsWithJson: /^\s*{/.test(retryContent),
    toolCallName: toolCall?.function?.name || '',
    toolInputLength: String(toolCall?.function?.arguments || '').length,
    toolCallUsesShellCommand: /tools\.shell_command/.test(String(toolCall?.function?.arguments || '')),
    toolCallUsesWebRun: /tools\.web__run/.test(String(toolCall?.function?.arguments || '')),
    toolCallMentionsCalculator: /\b(?:calc|calculator)(?:\.exe)?\b/i.test(String(toolCall?.function?.arguments || '')),
    continuationRecovery: {
      toolResultPresent: followsToolResult,
      convertedToolResultPresent: convertedFollowsToolResult,
      sourceToolResultPresent: sourceFollowsToolResult,
      stalledContinuation: initialStalledContinuation,
      stalledAfterToolResult,
      naturalStall: initialNaturalStall,
      toolIntentRequired,
      initialToolOmission,
      completionSignalRequired: followsToolResult,
      completionSignalPresent: hasAgentCompletionSignal(firstContent),
      missingCompletionSignal: initialMissingCompletionSignal,
      retryAttempted: recoveryAttempts > 0,
      recoveryAttempts,
      failedRecoveryAttempts,
      recoveryFailureKinds,
      consecutiveRecoveryFailures,
      maximumRecoveryAttempts,
      unlimitedRecovery,
      repeatedRecoveryResponses,
      recoveryCircuitBreaker,
      maximumRecoveryMs: Number.isFinite(maximumRecoveryMs) ? maximumRecoveryMs : 0,
      recoveryElapsedMs,
      recoveryTimeBudgetExhausted,
      acceptedRetry,
      retryProducedToolCall: Boolean(toolCall && acceptedRetry),
      recoveryDecisionKinds,
      acceptedRecoveryDecision: acceptedRetry ? recoveryDecisionKinds.at(-1) || 'legacy' : '',
      visibleProgressCount: visibleProgressMessages.length,
      liveProgressCount: publishedProgressMessages.size,
      firstProgressDeltaMs,
      progressDeltaCount,
      bufferedProgressCount: pendingProgressMessages.length,
      exhausted: exhaustedRecovery,
      safetyStopAppended: false,
      safetyStopTriggered,
      acceptedCompletionSignal,
      inferredTerminalCandidate,
      inferredCompletionAccepted
    }
  }

  if (request.stream === false) {
    const result = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    })

    result.codexToolEmulation = detail
    result.codexProgressMessages = pendingProgressMessages

    return result
  }

  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: toolCall
            ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
            : { role: 'assistant', content: assistant.content },
          finish_reason: null
        }
      ]
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: assistant.usage || undefined
    }
  ]
  const stream = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`

  const result = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })

  result.codexToolEmulation = detail
  result.codexProgressMessages = pendingProgressMessages

  return result
}

function customInputFromChatArguments(value) {
  const raw = String(value || '')

  try {
    const parsed = JSON.parse(raw)

    if (typeof parsed?.input === 'string') return parsed.input
  } catch {
    // Some compatible providers return the free-form input without JSON wrapping.
  }

  return raw
}

function responseUsageFromChat(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens || 0)
  const outputTokens = Number(usage.completion_tokens || 0)

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) },
    total_tokens: Number(usage.total_tokens || inputTokens + outputTokens)
  }
}

function baseResponse(state, status, output, usage = null) {
  return {
    id: state.responseId,
    object: 'response',
    created_at: state.createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: state.model,
    output,
    parallel_tool_calls: state.parallelToolCalls,
    previous_response_id: null,
    reasoning: state.reasoning,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage
  }
}

function writeEvent(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
}

function createStreamState(body, toolNames, response) {
  const state = {
    response,
    toolNames,
    responseId: `resp_${randomUUID().replace(/-/g, '')}`,
    createdAt: Math.floor(Date.now() / 1000),
    model: body.model,
    reasoning: body.reasoning || null,
    parallelToolCalls: body.parallel_tool_calls !== false,
    started: false,
    textStarted: false,
    text: '',
    messageId: `msg_${randomUUID().replace(/-/g, '')}`,
    tools: new Map(),
    announcedToolIds: new Set(),
    usage: null,
    progressOutput: [],
    liveProgress: null,
    outputOffset: 0,
    finished: false
  }

  return state
}

function progressItem(text) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text, annotations: [] }]
  }
}

function startLiveProgress(state) {
  if (state.liveProgress) return
  ensureResponseStarted(state)
  const item = progressItem('')
  const outputIndex = state.progressOutput.length

  state.liveProgress = { item, outputIndex, text: '' }
  writeEvent(state.response, 'response.output_item.added', {
    output_index: outputIndex,
    item: { ...item, status: 'in_progress', content: [] }
  })
  writeEvent(state.response, 'response.content_part.added', {
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  })
}

function appendLiveProgress(state, delta) {
  const text = String(delta || '')

  if (!text) return
  startLiveProgress(state)
  state.liveProgress.text += text
  writeEvent(state.response, 'response.output_text.delta', {
    item_id: state.liveProgress.item.id,
    output_index: state.liveProgress.outputIndex,
    content_index: 0,
    delta: text,
    logprobs: []
  })
}

function finishLiveProgress(state) {
  const live = state.liveProgress

  if (!live) return
  const part = { type: 'output_text', text: live.text, annotations: [] }
  const item = { ...live.item, content: [part] }

  writeEvent(state.response, 'response.output_text.done', {
    item_id: item.id,
    output_index: live.outputIndex,
    content_index: 0,
    text: live.text,
    logprobs: []
  })
  writeEvent(state.response, 'response.content_part.done', {
    item_id: item.id,
    output_index: live.outputIndex,
    content_index: 0,
    part
  })
  writeEvent(state.response, 'response.output_item.done', { output_index: live.outputIndex, item })
  state.progressOutput.push(item)
  state.outputOffset = state.progressOutput.length
  state.liveProgress = null
}

function emitProgressMessages(state, messages) {
  for (const text of Array.isArray(messages) ? messages : []) {
    if (!String(text || '').trim()) continue

    finishLiveProgress(state)
    startLiveProgress(state)
    appendLiveProgress(state, String(text).trim())
    finishLiveProgress(state)
  }
}

function ensureResponseStarted(state) {
  if (state.started) return
  state.started = true
  writeEvent(state.response, 'response.created', { response: baseResponse(state, 'in_progress', []) })
  writeEvent(state.response, 'response.in_progress', { response: baseResponse(state, 'in_progress', []) })
}

function ensureTextStarted(state) {
  ensureResponseStarted(state)
  if (state.textStarted) return
  state.textStarted = true
  writeEvent(state.response, 'response.output_item.added', {
    output_index: state.outputOffset,
    item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  })
  writeEvent(state.response, 'response.content_part.added', {
    item_id: state.messageId,
    output_index: state.outputOffset,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  })
}

function toolStateFor(state, chatTool, fallbackIndex) {
  const parsedIndex = Number(chatTool.index ?? fallbackIndex)
  const index = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : state.tools.size
  let tool = state.tools.get(index)

  if (!tool) {
    tool = {
      index,
      id: '',
      itemId: '',
      name: '',
      arguments: '',
      emittedArgumentsLength: 0,
      announced: false
    }
    state.tools.set(index, tool)
  }

  if (chatTool.id && !tool.announced) tool.id = String(chatTool.id)
  if (chatTool.function?.name) tool.name = mergeStreamedToolName(tool.name, chatTool.function.name)

  return tool
}

function ensureToolCallId(state, tool) {
  if (tool.announced) return tool.id

  const candidate =
    String(tool.id || '').trim() || deterministicToolCallId(tool.name, tool.arguments, Number(tool.index || 0))

  tool.id = uniqueToolCallId(candidate, state.announcedToolIds)
  state.announcedToolIds.add(tool.id)

  return tool.id
}

function ensureToolItemId(state, tool) {
  const custom = state.toolNames.isCustomChat(tool.name)

  tool.itemId ||= `${custom ? 'ctc' : 'fc'}_${randomUUID().replace(/-/g, '')}`
  tool.itemId = normalizedToolItemId(tool.itemId, custom ? 'ctc_' : 'fc_')

  return custom
}

function announceTool(state, tool, options = {}) {
  if (tool.announced || !tool.name || (!tool.id && options.force !== true)) return
  ensureResponseStarted(state)
  ensureToolCallId(state, tool)
  tool.announced = true
  const custom = ensureToolItemId(state, tool)

  writeEvent(state.response, 'response.output_item.added', {
    output_index: state.outputOffset + (state.textStarted ? tool.index + 1 : tool.index),
    item: custom
      ? {
          id: tool.itemId,
          type: 'custom_tool_call',
          status: 'in_progress',
          input: '',
          call_id: tool.id,
          name: state.toolNames.toResponses(tool.name)
        }
      : {
          id: tool.itemId,
          type: 'function_call',
          status: 'in_progress',
          arguments: '',
          call_id: tool.id,
          name: state.toolNames.toResponses(tool.name)
        }
  })
}

function flushToolArgumentDelta(state, tool) {
  if (!tool.announced || state.toolNames.isCustomChat(tool.name)) return

  const delta = tool.arguments.slice(tool.emittedArgumentsLength)

  if (!delta) return
  tool.emittedArgumentsLength = tool.arguments.length
  writeEvent(state.response, 'response.function_call_arguments.delta', {
    item_id: tool.itemId,
    output_index: state.outputOffset + (state.textStarted ? tool.index + 1 : tool.index),
    delta
  })
}

function consumeChatChunk(state, chunk) {
  if (chunk?.id && !state.started) state.responseId = chunk.id.replace(/^chatcmpl-/, 'resp_')
  if (chunk?.model) state.model = chunk.model
  if (chunk?.usage) state.usage = chunk.usage

  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    const delta = choice.delta && Object.keys(choice.delta).length ? choice.delta : choice.message || choice.delta || {}
    const text = typeof delta.content === 'string' ? sanitizeVisibleAssistantDelta(delta.content) : ''

    if (text) {
      ensureTextStarted(state)
      state.text += text
      writeEvent(state.response, 'response.output_text.delta', {
        item_id: state.messageId,
        output_index: state.outputOffset,
        content_index: 0,
        delta: text,
        logprobs: []
      })
    }

    for (const [toolPosition, chatTool] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
      const tool = toolStateFor(state, chatTool, toolPosition)
      const argumentDelta = normalizeToolArguments(chatTool.function?.arguments)

      if (argumentDelta) {
        tool.arguments += argumentDelta
      }
      announceTool(state, tool)
      flushToolArgumentDelta(state, tool)
    }

    if (delta.function_call) {
      const legacyTool = toolStateFor(
        state,
        {
          index: 0,
          id: `call_${state.responseId.replace(/^resp_/, '')}`,
          function: delta.function_call
        },
        0
      )

      announceTool(state, legacyTool)
      const argumentDelta = normalizeToolArguments(delta.function_call.arguments)

      if (argumentDelta) {
        legacyTool.arguments += argumentDelta
      }
      flushToolArgumentDelta(state, legacyTool)
    }
  }
}

function finishResponseStream(state) {
  if (state.finished) return
  state.finished = true
  finishLiveProgress(state)
  ensureResponseStarted(state)
  const output = [...state.progressOutput]

  if (state.textStarted) {
    const part = { type: 'output_text', text: state.text, annotations: [] }
    const item = { id: state.messageId, type: 'message', status: 'completed', role: 'assistant', content: [part] }

    writeEvent(state.response, 'response.output_text.done', {
      item_id: state.messageId,
      output_index: state.outputOffset,
      content_index: 0,
      text: state.text,
      logprobs: []
    })
    writeEvent(state.response, 'response.content_part.done', {
      item_id: state.messageId,
      output_index: state.outputOffset,
      content_index: 0,
      part
    })
    writeEvent(state.response, 'response.output_item.done', { output_index: state.outputOffset, item })
    output.push(item)
  }

  for (const tool of [...state.tools.values()].sort((left, right) => left.index - right.index)) {
    announceTool(state, tool, { force: true })
    if (!tool.announced) continue
    flushToolArgumentDelta(state, tool)
    const outputIndex = state.outputOffset + (state.textStarted ? tool.index + 1 : tool.index)
    const custom = state.toolNames.isCustomChat(tool.name)
    const input = customInputFromChatArguments(tool.arguments)
    const item = custom
      ? {
          id: tool.itemId,
          type: 'custom_tool_call',
          status: 'completed',
          input,
          call_id: tool.id,
          name: state.toolNames.toResponses(tool.name)
        }
      : {
          id: tool.itemId,
          type: 'function_call',
          status: 'completed',
          arguments: tool.arguments,
          call_id: tool.id,
          name: state.toolNames.toResponses(tool.name)
        }

    if (custom) {
      writeEvent(state.response, 'response.custom_tool_call_input.delta', {
        item_id: tool.itemId,
        output_index: outputIndex,
        delta: input
      })
      writeEvent(state.response, 'response.custom_tool_call_input.done', {
        item_id: tool.itemId,
        output_index: outputIndex,
        input
      })
    } else {
      writeEvent(state.response, 'response.function_call_arguments.done', {
        item_id: tool.itemId,
        output_index: outputIndex,
        arguments: tool.arguments
      })
    }

    writeEvent(state.response, 'response.output_item.done', { output_index: outputIndex, item })
    output.push(item)
  }

  writeEvent(state.response, 'response.completed', {
    response: baseResponse(state, 'completed', output, responseUsageFromChat(state.usage || {}))
  })
  state.response.end()
}

function ensureResponsesStreamHeaders(response) {
  if (response.headersSent) return

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
}

function startResponsesStreamHeartbeat(response, intervalMs = 5000) {
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer)
      return
    }

    response.write(': codex-agent-loop keep-alive\n\n')
  }, intervalMs)

  timer.unref?.()

  return () => clearInterval(timer)
}

async function pipeChatStreamToResponses(upstream, body, toolNames, response, preparedState = null) {
  ensureResponsesStreamHeaders(response)
  const state = preparedState || createStreamState(body, toolNames, response)

  emitProgressMessages(state, upstream.codexProgressMessages)
  const parser = createParser({
    onEvent(event) {
      if (event.data === '[DONE]') {
        finishResponseStream(state)
        return
      }

      try {
        consumeChatChunk(state, JSON.parse(event.data))
      } catch {
        // Ignore malformed provider chunks while keeping the stream alive.
      }
    }
  })
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()

  while (!state.finished) {
    const { done, value } = await reader.read()

    if (done) break
    parser.feed(decoder.decode(value, { stream: true }))
  }

  parser.reset({ consume: true })
  finishResponseStream(state)
}

async function sendNonStreamingResponse(upstream, body, toolNames, response) {
  const progressMessages = upstream.codexProgressMessages
  const chat = await readResponseJsonLimited(upstream)
  const state = createStreamState(body, toolNames, response)

  state.progressOutput = (Array.isArray(progressMessages) ? progressMessages : [])
    .map(text => String(text || '').trim())
    .filter(Boolean)
    .map(progressItem)
  state.outputOffset = state.progressOutput.length
  state.responseId = String(chat.id || state.responseId).replace(/^chatcmpl-/, 'resp_')
  state.model = chat.model || state.model
  state.usage = chat.usage || null
  const message = chat.choices?.[0]?.message || {}

  if (message.content) {
    state.text = normalizeVisibleAssistantText(
      typeof message.content === 'string' ? message.content : textFromContent(message.content)
    )
    state.textStarted = Boolean(state.text)
  }
  for (const [toolPosition, chatTool] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
    const tool = toolStateFor(state, chatTool, toolPosition)

    tool.arguments = normalizeToolArguments(chatTool.function?.arguments)
  }
  if (message.function_call) {
    const tool = toolStateFor(
      state,
      {
        index: 0,
        id: `call_${state.responseId.replace(/^resp_/, '')}`,
        function: message.function_call
      },
      0
    )

    tool.arguments = message.function_call.arguments || ''
  }

  const output = [...state.progressOutput]

  if (state.textStarted) {
    output.push({
      id: state.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.text, annotations: [] }]
    })
  }
  for (const tool of state.tools.values()) {
    if (!tool.name) continue
    ensureToolCallId(state, tool)
    const custom = ensureToolItemId(state, tool)

    output.push(
      custom
        ? {
            id: tool.itemId,
            type: 'custom_tool_call',
            status: 'completed',
            input: customInputFromChatArguments(tool.arguments),
            call_id: tool.id,
            name: toolNames.toResponses(tool.name)
          }
        : {
            id: tool.itemId,
            type: 'function_call',
            status: 'completed',
            arguments: tool.arguments,
            call_id: tool.id,
            name: toolNames.toResponses(tool.name)
          }
    )
  }

  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(baseResponse(state, 'completed', output, responseUsageFromChat(state.usage || {}))))
}

function readJsonBody(request, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function upstreamChatUrl(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '')

  if (/\/chat\/completions$/i.test(normalized)) return normalized

  return `${normalized}/chat/completions`
}

function upstreamResponsesUrl(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '')

  if (/\/responses$/i.test(normalized)) return normalized
  if (/\/chat\/completions$/i.test(normalized)) return `${normalized.slice(0, -'/chat/completions'.length)}/responses`

  return `${normalized}/responses`
}

function upstreamModelsUrl(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '')

  if (/\/models$/i.test(normalized)) return normalized
  if (/\/responses$/i.test(normalized)) return `${normalized.slice(0, -'/responses'.length)}/models`
  if (/\/chat\/completions$/i.test(normalized)) return `${normalized.slice(0, -'/chat/completions'.length)}/models`

  return `${normalized}/models`
}

function responseTextFromPayload(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  const parts = []

  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'message') continue
    const text = textFromContent(item.content)

    if (text) parts.push(text)
  }

  return parts.join('\n')
}

async function readResponsesAssistant(upstream) {
  const raw = await readResponseTextLimited(upstream)

  try {
    const payload = JSON.parse(raw)

    return { content: responseTextFromPayload(payload), payload }
  } catch {
    // Some compatible Responses endpoints ignore stream=false and still return SSE.
  }

  let content = ''
  let completedPayload = null
  const parser = createParser({
    onEvent(event) {
      if (!event.data || event.data === '[DONE]') return

      try {
        const chunk = JSON.parse(event.data)

        if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
          content += chunk.delta
        }
        if (chunk.type === 'response.completed' && chunk.response) completedPayload = chunk.response
      } catch {
        // Ignore provider-specific SSE metadata.
      }
    }
  })

  parser.feed(raw)
  parser.reset({ consume: true })
  if (!content && completedPayload) content = responseTextFromPayload(completedPayload)

  return { content, payload: completedPayload }
}

function extractUserMessages(input) {
  const messages = []

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (item.type !== undefined && item.type !== 'message') continue
    if (item.role !== 'user') continue
    const text = textFromContent(item.content)

    if (text.trim()) messages.push(text)
  }

  return messages
}

function compactV1Output(input, summary) {
  const budget = 80000
  const selected = []
  let remaining = budget
  const messages = extractUserMessages(input)

  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const value = messages[index]

    if (value.length <= remaining) {
      selected.push(value)
      remaining -= value.length
    } else {
      selected.push(value.slice(value.length - remaining))
      break
    }
  }
  selected.reverse()

  return [
    ...selected.map(message => responseMessageItem(message)),
    responseMessageItem(String(summary || '').trim() ? `${SUMMARY_PREFIX}\n${summary}` : '(no summary available)')
  ]
}

function compactionItem(summary) {
  return {
    type: 'compaction',
    id: `cmp_${randomUUID().replace(/-/g, '')}`,
    encrypted_content: encodeSummary(String(summary || '').trim() || '(no summary available)')
  }
}

function compactionSnapshot(model, item, status = 'completed') {
  return {
    id: `resp_${randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: item ? [item] : [],
    usage: null
  }
}

function writeCompactionSse(response, model, summary) {
  const item = compactionItem(summary)
  const created = compactionSnapshot(model, null, 'in_progress')
  const completed = { ...created, status: 'completed', output: [item] }
  const events = [
    ['response.created', { response: created }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response: completed }]
  ]

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  events.forEach(([type, data], sequenceNumber) => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...data })}\n\n`)
  })
  response.end('data: [DONE]\n\n')
}

async function requestCompactionSummary(channel, rawBody, capability, preferredWireApi, upstreamSignal) {
  const originalInput = normalizeCompactionInput(rawBody.input)
  const input = Array.isArray(originalInput)
    ? [...originalInput, responseMessageItem(COMPACT_PROMPT)]
    : [responseMessageItem(typeof originalInput === 'string' ? originalInput : ''), responseMessageItem(COMPACT_PROMPT)]
  const summaryBody = adaptResponsesRequest(
    {
      ...rawBody,
      model: rawBody.model,
      stream: true,
      tools: [],
      tool_choice: 'none',
      input
    },
    capability
  )

  delete summaryBody.previous_response_id
  const sendResponses = () =>
    fetch(upstreamResponsesUrl(channel.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(summaryBody),
      signal: upstreamSignal
    })
  const sendChat = () => {
    const converted = responsesRequestToChat(summaryBody, capability).request
    const payload = { ...converted, stream: true }

    delete payload.tools
    delete payload.tool_choice
    delete payload.parallel_tool_calls

    return fetch(upstreamChatUrl(channel.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: upstreamSignal
    })
  }
  let wireApi = preferredWireApi
  let upstream = wireApi === 'responses' ? await sendResponses() : await sendChat()

  if (!upstream.ok) {
    const errorBody = await readResponseTextLimited(upstream)

    if (wireApi === 'responses' && endpointCompatibilityFailure(upstream.status, errorBody)) {
      wireApi = 'chat'
      upstream = await sendChat()
    } else if (wireApi === 'chat' && endpointCompatibilityFailure(upstream.status, errorBody)) {
      wireApi = 'responses'
      upstream = await sendResponses()
    } else {
      return { ok: false, status: upstream.status, errorBody, wireApi }
    }
  }
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      errorBody: await readResponseTextLimited(upstream),
      wireApi
    }
  }

  const assistant = wireApi === 'responses' ? await readResponsesAssistant(upstream) : await readChatAssistant(upstream)

  return {
    ok: true,
    summary: String(assistant.content || '').trim() || '(no summary available)',
    input: originalInput,
    wireApi
  }
}

async function handleCompactionRequest(
  response,
  rawBody,
  channel,
  capability,
  preferredWireApi,
  compactV1,
  onDiagnostic,
  onWireApiResolved,
  upstreamSignal,
  responseModel = rawBody.model
) {
  const startedAt = Date.now()
  const result = await requestCompactionSummary(channel, rawBody, capability, preferredWireApi, upstreamSignal)

  if (!result.ok) {
    response.writeHead(result.status || 502, { 'content-type': 'application/json; charset=utf-8' })
    response.end(
      result.errorBody || JSON.stringify({ error: { type: 'compaction_failed', message: '远程会话压缩失败' } })
    )
    return
  }
  if (typeof onWireApiResolved === 'function') {
    try {
      onWireApiResolved(rawBody.model, result.wireApi)
    } catch {
      // Runtime protocol learning must never interrupt compaction.
    }
  }
  if (typeof onDiagnostic === 'function') {
    try {
      onDiagnostic({
        capturedAt: new Date().toISOString(),
        channelId: String(channel.id || ''),
        operation: 'compaction',
        compactionVersion: compactV1 ? 'v1' : 'v2',
        requestedModel: responseModel,
        model: rawBody.model,
        wireApi: result.wireApi,
        inputItemCount: Array.isArray(result.input) ? result.input.length : 0,
        summaryLength: result.summary.length,
        durationMs: Date.now() - startedAt
      })
    } catch {
      // Diagnostics must never interrupt compaction.
    }
  }
  if (compactV1) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ output: compactV1Output(result.input, result.summary) }))
    return
  }
  if (rawBody.stream === false) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(compactionSnapshot(responseModel, compactionItem(result.summary))))
    return
  }

  writeCompactionSse(response, responseModel, result.summary)
}

function localModelsPayload(channel) {
  const aliases = channel?.modelAliases && typeof channel.modelAliases === 'object' ? channel.modelAliases : {}
  const aliasedModels = Object.keys(aliases)
  const models = Array.from(
    new Set(
      (aliasedModels.length ? aliasedModels : Array.isArray(channel?.models) ? channel.models : [])
        .map(model => String(model || '').trim())
        .filter(Boolean)
    )
  )
  const modelCatalog = Array.isArray(channel?.modelCatalog)
    ? channel.modelCatalog.filter(entry => models.includes(String(entry?.slug || '')))
    : []

  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'newapi'
    })),
    models: modelCatalog
  }
}

function inferredWireApiForModel(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()

  if (!normalized) return ''
  if (/^(gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/.test(normalized)) return 'responses'
  if (/^grok(?:-|$)/.test(normalized)) return 'chat'

  return ''
}

function endpointCompatibilityFailure(status, body) {
  if ([404, 405, 415, 501].includes(Number(status))) return true

  const message = String(body || '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  const endpoint = '(?:chat[ _/-]*completions?|responses?|endpoint|route|path|api)'
  const failure = '(?:not supported|unsupported|not found|unknown|unavailable|not implemented|does not exist|invalid)'

  return new RegExp(`${endpoint}.{0,100}${failure}|${failure}.{0,100}${endpoint}`, 'i').test(message)
}

async function handleModelsRequest(response, channel, onDiagnostic) {
  const fallback = localModelsPayload(channel)

  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(fallback))
  if (typeof onDiagnostic === 'function') {
    onDiagnostic({
      channelId: channel.id,
      operation: 'models',
      source: 'validated-alias-catalog',
      modelCount: fallback.models.length
    })
  }
}

async function handleImagesRequest(request, response, channel, onDiagnostic, options = {}) {
  const rawBody = await readJsonBody(request, 128 * 1024)
  const signal = options.signal || createUpstreamSignal(request, response)
  let releaseImageCall = null

  try {
    releaseImageCall = options.acquireImageCall?.() || null
    if (options.acquireImageCall && !releaseImageCall) {
      response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '2' })
      response.end(
        JSON.stringify({
          error: {
            type: 'image_generation_busy',
            message: '当前渠道已有图片生成任务，请等待它完成后重试'
          }
        })
      )
      return
    }
    const generated = await generateNewApiImage(channel, rawBody, {
      signal,
      onDiagnostic: diagnostic => onDiagnostic?.({ channelId: channel.id, ...diagnostic })
    })

    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(generated.responsePayload))
  } catch (error) {
    if (response.headersSent) throw error
    response.writeHead(error instanceof ImageGenerationValidationError ? 400 : 502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(
      JSON.stringify({
        error: {
          type: 'image_generation_error',
          message: error instanceof Error ? error.message : String(error)
        }
      })
    )
  } finally {
    releaseImageCall?.()
  }
}

function wireApiForModel(channel, model) {
  const modelName = String(model || '').trim()
  const maps = [
    channel?.runtimeModelWireApis,
    channel?.modelWireApis,
    channel?.wireApisByModel,
    channel?.modelTests && typeof channel.modelTests === 'object'
      ? Object.fromEntries(
          Object.entries(channel.modelTests)
            .map(([name, test]) => [name, test?.wireApi])
            .filter(([, wireApi]) => wireApi === 'responses' || wireApi === 'chat')
        )
      : null
  ]

  for (const map of maps) {
    if (!map || typeof map !== 'object') continue

    const direct = map[modelName]
    if (direct === 'responses' || direct === 'chat') return direct

    const matchedKey = Object.keys(map).find(key => key.toLowerCase() === modelName.toLowerCase())
    const matched = matchedKey ? map[matchedKey] : ''

    if (matched === 'responses' || matched === 'chat') return matched
  }

  const capabilityWireApi = capabilityForModel(channel, modelName)?.wireApi

  if (capabilityWireApi === 'responses' || capabilityWireApi === 'chat') return capabilityWireApi
  const inferred = inferredWireApiForModel(modelName)

  if (inferred) return inferred

  return ''
}

function responseToolNames(tools) {
  const names = []

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) names.push(`${tool.name}.${nested?.name || ''}`)
    } else if (tool?.name) {
      names.push(String(tool.name))
    }
  }

  return names.filter(Boolean)
}

async function pipeFetchBody(upstream, response, headers = {}) {
  return pipeResponseBodyLimited(upstream, response, headers)
}

async function handleResponsesRequest(
  request,
  response,
  channel,
  onDiagnostic,
  onWireApiResolved,
  requestOptions = {}
) {
  const rawBody = await readJsonBody(request)
  const requestCodexContext = codexRequestContext(rawBody)

  if (typeof requestOptions.onRequestContext === 'function') requestOptions.onRequestContext(requestCodexContext)
  const upstreamSignal = requestOptions.signal || createUpstreamSignal(request, response)
  const requestedModel = String(rawBody.model || '').trim()
  const canonicalModel = canonicalModelFor(channel, requestedModel)
  const capability = capabilityForModel(channel, canonicalModel)

  if (!capability?.available) {
    response.writeHead(422, { 'content-type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({
        error: {
          type: 'model_adapter_unavailable',
          model: canonicalModel || requestedModel,
          message: `${canonicalModel || requestedModel || '未知模型'}：适配未完成，暂不可用`
        }
      })
    )
    return
  }

  const body = adaptResponsesRequest({ ...rawBody, model: canonicalModel }, capability)
  const preferredWireApi = wireApiForModel(channel, canonicalModel)

  if (!preferredWireApi) {
    response.writeHead(422, { 'content-type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({
        error: {
          type: 'model_adapter_unavailable',
          model: canonicalModel,
          message: `${canonicalModel}：适配未完成，暂不可用`
        }
      })
    )
    return
  }
  const compactV1 = requestOptions.compactV1 === true
  const compactV2 = Array.isArray(rawBody.input) && rawBody.input.at(-1)?.type === 'compaction_trigger'

  if (compactV1 || compactV2) {
    await handleCompactionRequest(
      response,
      { ...rawBody, model: canonicalModel },
      channel,
      capability,
      preferredWireApi,
      compactV1,
      onDiagnostic,
      onWireApiResolved,
      upstreamSignal,
      requestedModel || canonicalModel
    )
    return
  }

  const inputItems = Array.isArray(body.input) ? body.input : []
  const commonDiagnostic = {
    capturedAt: new Date().toISOString(),
    channelId: String(channel.id || ''),
    requestedModel,
    model: canonicalModel,
    adapter: capability.adapter,
    requestedWireApi: preferredWireApi,
    requestedReasoningEffort: String(rawBody.reasoning?.effort || ''),
    forwardedReasoningEffort: String(body.reasoning?.effort || ''),
    requestedServiceTier: String(rawBody.service_tier || ''),
    forwardedServiceTier: String(body.service_tier || ''),
    continuationGuard: Array.isArray(body.tools) && body.tools.length > 0,
    sourceRequestBytes: jsonByteLength(rawBody),
    forwardedResponsesRequestBytes: jsonByteLength(body),
    sourceInputItemCount: inputItems.length,
    sourceInputBytes: jsonByteLength(inputItems),
    sourceToolCallHistoryCount: inputItems.filter(
      item => item?.type === 'function_call' || item?.type === 'custom_tool_call'
    ).length,
    sourceToolOutputCount: inputItems.filter(
      item => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output'
    ).length,
    sourceFollowsToolResult: followsImmediateResponsesToolResult(inputItems),
    ...requestCodexContext,
    sourceInputTailKinds: inputItems.slice(-6).map(item => ({
      type: String(item?.type || (item?.role ? 'message' : '')),
      role: String(item?.role || '')
    }))
  }
  const reportWireApi = wireApi => {
    if (typeof onWireApiResolved !== 'function') return

    try {
      onWireApiResolved(canonicalModel, wireApi)
    } catch {
      // Runtime protocol learning must never interrupt the model request.
    }
  }
  const sendResponsesUpstream = () =>
    fetchWithCapacityRetry(
      () =>
        fetch(upstreamResponsesUrl(channel.baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${channel.apiKey}`,
            'content-type': request.headers['content-type'] || 'application/json',
            accept: body.stream === false ? 'application/json' : 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal: upstreamSignal
        }),
      { signal: upstreamSignal }
    )
  let responsesFallback = null

  if (preferredWireApi === 'responses') {
    const diagnostic = {
      ...commonDiagnostic,
      wireApi: 'responses',
      stream: body.stream !== false,
      sourceToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      forwardedToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      sourceToolTypes: [
        ...new Set((Array.isArray(body.tools) ? body.tools : []).map(tool => String(tool?.type || '')).filter(Boolean))
      ],
      sourceToolNames: responseToolNames(body.tools),
      forwardedToolNames: responseToolNames(body.tools),
      hasShellTool: responseToolNames(body.tools).some(name =>
        /(^|[._-])(shell|shell_command|exec)([._-]|$)/i.test(name)
      ),
      hasComputerUseTool: responseToolNames(body.tools).some(name => /computer.?use/i.test(name)),
      instructionsLength: String(body.instructions || '').length,
      forwardedRequestBytes: jsonByteLength(body)
    }

    const upstream = await sendResponsesUpstream()
    const headers = {
      'content-type':
        upstream.headers.get('content-type') ||
        (body.stream === false ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8')
    }

    if (upstream.ok) {
      reportWireApi('responses')
      if (typeof onDiagnostic === 'function') {
        try {
          onDiagnostic({ ...upstreamDiagnostic(diagnostic, upstream), outcome: 'upstream_accepted' })
        } catch {
          // Diagnostics must never interrupt the model request.
        }
      }
      await pipeFetchBody(upstream, response, headers)
      return
    }
    const buffer = await readResponseBufferLimited(upstream)

    if (!endpointCompatibilityFailure(upstream.status, buffer.toString('utf8'))) {
      if (typeof onDiagnostic === 'function') {
        try {
          onDiagnostic({
            ...upstreamDiagnostic(diagnostic, upstream, buffer.toString('utf8')),
            outcome: 'upstream_error'
          })
        } catch {
          // Diagnostics must never interrupt the model request.
        }
      }
      const failureKind = upstreamFailureKind(upstream.status, buffer.toString('utf8'))
      const userMessage = userFacingUpstreamFailure(failureKind, Number(upstream.codexRetryDiagnostic?.retryCount || 0))

      if (userMessage) {
        response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { type: failureKind, message: userMessage } }))
      } else {
        response.writeHead(upstream.status, headers)
        response.end(buffer)
      }
      return
    }

    responsesFallback = {
      from: 'responses',
      to: 'chat',
      status: upstream.status,
      failureKind: upstreamFailureKind(upstream.status, buffer.toString('utf8'))
    }
  }

  const converted = responsesRequestToChat(body, capability)
  const sourceNames = responseToolNames(body.tools)
  const forwardedNames = Array.isArray(converted.request.tools)
    ? converted.request.tools.map(tool => String(tool?.function?.name || '')).filter(Boolean)
    : []
  const diagnostic = {
    ...commonDiagnostic,
    wireApi: 'chat',
    protocolFallback: responsesFallback,
    stream: converted.request.stream,
    sourceToolCount: sourceNames.length,
    forwardedToolCount: forwardedNames.length,
    sourceToolTypes: [
      ...new Set((Array.isArray(body.tools) ? body.tools : []).map(tool => String(tool?.type || '')).filter(Boolean))
    ],
    sourceToolNames: sourceNames,
    forwardedToolNames: forwardedNames,
    hasShellTool: sourceNames.some(name => /(^|[._-])(shell|shell_command|exec)([._-]|$)/i.test(name)),
    hasComputerUseTool: sourceNames.some(name => /computer.?use/i.test(name)),
    instructionsLength: String(body.instructions || '').length,
    chatHistoryCompatibility: converted.compatibility,
    forwardedRequestBytes: jsonByteLength(converted.request)
  }

  if (typeof onDiagnostic === 'function') {
    try {
      onDiagnostic(diagnostic)
    } catch {
      // Diagnostics must never interrupt the model request.
    }
  }
  const sendUpstream = (payload, signal = upstreamSignal) =>
    sendChatWithCompatibilityFallback(
      compatiblePayload =>
        fetchWithCapacityRetry(
          () =>
            fetch(upstreamChatUrl(channel.baseUrl), {
              method: 'POST',
              headers: {
                authorization: `Bearer ${channel.apiKey}`,
                'content-type': 'application/json',
                accept: compatiblePayload.stream ? 'text/event-stream' : 'application/json'
              },
              body: JSON.stringify(compatiblePayload),
              signal
            }),
          { signal }
        ),
      payload
    )
  const forcePromptToolEmulation = capability.toolTransport === 'prompt-emulated' && forwardedNames.length > 0
  let emulatedStreamState = null
  let upstream = forcePromptToolEmulation
    ? new Response(JSON.stringify({ error: { message: 'tool calls are not supported by the selected adapter' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    : await sendUpstream(converted.request)
  let errorBody = upstream.ok ? '' : await chatUpstreamErrorBody(upstream)

  if (preferredWireApi === 'chat' && !upstream.ok && endpointCompatibilityFailure(upstream.status, errorBody)) {
    const chatFailure = {
      from: 'chat',
      to: 'responses',
      status: upstream.status,
      failureKind: upstreamFailureKind(upstream.status, errorBody)
    }
    const fallbackUpstream = await sendResponsesUpstream()

    if (fallbackUpstream.ok) {
      reportWireApi('responses')
      if (typeof onDiagnostic === 'function') {
        try {
          onDiagnostic({ ...commonDiagnostic, wireApi: 'responses', protocolFallback: chatFailure })
        } catch {
          // Diagnostics must never interrupt the model request.
        }
      }
      await pipeFetchBody(fallbackUpstream, response, {
        'content-type':
          fallbackUpstream.headers.get('content-type') ||
          (body.stream === false ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8')
      })
      return
    }
    await readResponseBufferLimited(fallbackUpstream)
  }

  if (!upstream.ok && forwardedNames.length && upstreamRejectsNativeTools(errorBody)) {
    const nativeToolFailureKind = upstreamFailureKind(upstream.status, errorBody)
    const emulation = toolEmulationRequest(converted.request)
    const emulatedImageTool = managerImageTool(emulation.catalog)
    const imageRecoveryInstruction = emulatedImageTool
      ? `For image generation, call the exact allowed ${emulatedImageTool.name} tool with a prompt argument; reading an image skill is not completion. `
      : 'For image generation, use exec with the nested image_gen__imagegen tool and generatedImage(result); reading an image skill is not completion. '
    const fallbackUpstream = await sendUpstream(emulation.payload)

    if (fallbackUpstream.ok) {
      emulatedStreamState = converted.request.stream ? createStreamState(body, converted.toolNames, response) : null
      let stopHeartbeat = () => {}

      if (emulatedStreamState) {
        ensureResponsesStreamHeaders(response)
        ensureResponseStarted(emulatedStreamState)
        stopHeartbeat = startResponsesStreamHeartbeat(response)
      }

      try {
        let structuredRecoverySupported = true
        let recoveryContextMessageCount = 0

        upstream = await synthesizeEmulatedToolResponse(
          fallbackUpstream,
          converted.request,
          emulation.allowed,
          async (firstAssistant, retryContext = {}) => {
            const strictToolRecovery = Boolean(retryContext.stalledContinuation)
            const decisionContract = recoveryDecisionContract(AGENT_COMPLETION_SIGNAL)
            const recoveryAttemptDescription = retryContext.unlimitedRecovery
              ? `This is bounded recovery attempt ${retryContext.attempt || 1} with no fixed round limit; only duplicate-response and transport-failure circuit breakers remain. `
              : `This is bounded recovery attempt ${retryContext.attempt || 1} of ${retryContext.maximumAttempts || 1}. `
            const recoveryPrompt = retryContext.naturalStall
              ? 'The previous answer stopped at a plan-only sentence instead of executing the next Codex agent step. ' +
                recoveryAttemptDescription +
                'The rejected plan is already visible to the user, so do not repeat, paraphrase, or explain it. Re-check the original user request and returned tool results. ' +
                'If the rejected answer says it will switch methods, turn that stated method into the next executable tool call now; do not announce the switch again. ' +
                'For current or time-sensitive information, use exec with the nested web__run tool. ' +
                imageRecoveryInstruction +
                decisionContract
              : retryContext.missingCompletionSignal
                ? 'The previous answer followed a Codex local tool result but omitted the required completion signal. ' +
                  recoveryAttemptDescription +
                  'Re-check the original user request and every returned tool result. ' +
                  decisionContract
                : retryContext.stalledAfterToolResult
                  ? 'You are recovering a stalled Codex agent turn after a local tool result has already returned. ' +
                    recoveryAttemptDescription +
                    'Re-check every action in the original user request against the returned tool results and continue the original task now. ' +
                    'The rejected answer is already visible to the user as live progress, so do not repeat or rephrase that plan. ' +
                    decisionContract
                  : retryContext.toolIntentRequired
                    ? 'The latest request requires a verified tool result, but the previous answer did not emit a valid Codex tool call. ' +
                      recoveryAttemptDescription +
                      'For current or time-sensitive information, use exec with the nested web__run tool; do not answer from memory. ' +
                      imageRecoveryInstruction +
                      'For local actions, use the matching allowed tool. ' +
                      decisionContract
                    : 'The previous answer stopped at an intermediate promise instead of executing the Codex agent step. ' +
                      recoveryAttemptDescription +
                      'Continue the original user task now. Reading or loading a skill is not a final answer. ' +
                      decisionContract
            const conversation = recoveryConversationContext(emulation.payload.messages)

            recoveryContextMessageCount = conversation.length
            const retryPayload = {
              ...emulation.payload,
              messages: [
                {
                  role: 'system',
                  content: recoveryPrompt
                },
                {
                  role: 'user',
                  content: JSON.stringify({
                    conversation,
                    rejected_answer: stripInternalToolTranscript(firstAssistant.content).slice(0, 3000),
                    allowed_tools: emulation.catalog
                  })
                }
              ],
              max_tokens: strictToolRecovery ? PROMPT_TOOL_RECOVERY_MAX_TOKENS : 1200,
              temperature: 0,
              stream: true,
              ...(strictToolRecovery && structuredRecoverySupported ? { response_format: { type: 'json_object' } } : {})
            }
            try {
              return await runWithAbortTimeout(
                upstreamSignal,
                retryContext.remainingRecoveryMs
                  ? Math.min(PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS, retryContext.remainingRecoveryMs)
                  : PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS,
                async recoverySignal => {
                  const retryUpstream = await sendUpstream(retryPayload, recoverySignal)

                  if (retryUpstream.ok) {
                    return readChatAssistant(retryUpstream, { onContentDelta: retryContext.onContentDelta })
                  }

                  const retryError = await chatUpstreamErrorBody(retryUpstream)
                  const structuredRecoveryRejected =
                    strictToolRecovery &&
                    retryPayload.response_format &&
                    /response[_ -]?format|json.?mode|structured output/i.test(retryError)

                  if (structuredRecoveryRejected) {
                    structuredRecoverySupported = false
                    const compatibleRetryPayload = { ...retryPayload }

                    delete compatibleRetryPayload.response_format
                    const compatibleRetryUpstream = await sendUpstream(compatibleRetryPayload, recoverySignal)

                    if (compatibleRetryUpstream.ok) {
                      return readChatAssistant(compatibleRetryUpstream, {
                        onContentDelta: retryContext.onContentDelta
                      })
                    }
                    retryContext.recordFailure?.(recoveryFailureKindForStatus(compatibleRetryUpstream.status))
                    await chatUpstreamErrorBody(compatibleRetryUpstream)
                  } else {
                    retryContext.recordFailure?.(recoveryFailureKindForStatus(retryUpstream.status))
                  }

                  return null
                }
              )
            } catch (error) {
              if (upstreamSignal.aborted) throw error
              retryContext.recordFailure?.(recoveryFailureKindForError(error))
              return null
            }
          },
          body.input,
          {
            maximumRecoveryMs: PROMPT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS,
            onProgressStart: emulatedStreamState
              ? () => {
                  ensureResponsesStreamHeaders(response)
                  startLiveProgress(emulatedStreamState)
                }
              : null,
            onProgressDelta: emulatedStreamState
              ? delta => {
                  ensureResponsesStreamHeaders(response)
                  appendLiveProgress(emulatedStreamState, delta)
                }
              : null,
            onProgressEnd: emulatedStreamState
              ? () => {
                  ensureResponsesStreamHeaders(response)
                  finishLiveProgress(emulatedStreamState)
                }
              : null,
            onProgress: emulatedStreamState
              ? text => {
                  ensureResponsesStreamHeaders(response)
                  emitProgressMessages(emulatedStreamState, [text])
                }
              : null
          }
        )
        if (upstream.codexToolEmulation) {
          upstream.codexToolEmulation.contextContinuity = {
            ...emulation.contextContinuity,
            recoveryContextMessageCount
          }
        }
      } finally {
        stopHeartbeat()
      }
      if (upstream.codexToolEmulation && emulatedStreamState) {
        upstream.codexToolEmulation.earlyResponseStarted = true
      }
      errorBody = ''
      if (typeof onDiagnostic === 'function') {
        try {
          onDiagnostic({
            ...diagnostic,
            toolTransport: 'prompt-emulated',
            forcedByCompatibilityTest: forcePromptToolEmulation,
            nativeToolFailureKind,
            outcome: 'upstream_accepted',
            emulation: upstream.codexToolEmulation || null
          })
        } catch {
          // Diagnostics must never interrupt the model request.
        }
      }
    } else {
      upstream = fallbackUpstream
      errorBody = await chatUpstreamErrorBody(fallbackUpstream)
    }
  }

  if (!upstream.ok) {
    const failureDiagnostic = {
      ...upstreamDiagnostic(diagnostic, upstream, errorBody),
      outcome: 'upstream_error'
    }

    if (typeof onDiagnostic === 'function') {
      try {
        onDiagnostic(failureDiagnostic)
      } catch {
        // Diagnostics must never interrupt the model request.
      }
    }
    const userMessage = userFacingUpstreamFailure(
      failureDiagnostic.upstreamFailureKind,
      failureDiagnostic.upstreamRetryCount
    )

    if (userMessage) {
      response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { type: failureDiagnostic.upstreamFailureKind, message: userMessage } }))
    } else {
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8'
      })
      response.end(errorBody)
    }
    return
  }

  reportWireApi('chat')
  if (!upstream.codexToolEmulation && typeof onDiagnostic === 'function') {
    try {
      onDiagnostic({ ...upstreamDiagnostic(diagnostic, upstream), outcome: 'upstream_accepted' })
    } catch {
      // Diagnostics must never interrupt the model request.
    }
  }
  if (converted.request.stream) {
    await pipeChatStreamToResponses(upstream, body, converted.toolNames, response, emulatedStreamState)
  } else {
    await sendNonStreamingResponse(upstream, body, converted.toolNames, response)
  }
}

function createProtocolProxy({
  resolveChannel,
  onDiagnostic,
  port = DEFAULT_PROTOCOL_PROXY_PORT,
  accessToken = randomUUID().replace(/-/g, '')
} = {}) {
  if (typeof resolveChannel !== 'function') throw new Error('协议代理缺少渠道解析器')
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(accessToken)) throw new Error('协议代理访问令牌格式无效')

  let lastDiagnostic = null
  const publishDiagnostic = diagnostic => {
    const annotated = annotateDiagnostic(diagnostic)

    lastDiagnostic = annotated
    if (typeof onDiagnostic === 'function') {
      try {
        onDiagnostic(annotated)
      } catch {
        // A diagnostic sink must never interrupt model, image, or MCP traffic.
      }
    }
  }
  const runtimeWireApis = new Map()
  const activeImageChannels = new Set()
  const acquireImageCall = channelId => {
    if (activeImageChannels.has(channelId)) return null
    activeImageChannels.add(channelId)

    return () => activeImageChannels.delete(channelId)
  }
  const routePrefix = `/proxy/${accessToken}`
  const server = http.createServer(async (request, response) => {
    let requestChannelId = ''
    let requestCodexContext = {}

    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')

      if (request.method === 'GET' && url.pathname === `${routePrefix}/health`) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, service: 'chatgpt-model-manager-protocol-proxy', lastDiagnostic }))
        return
      }

      if (request.method === 'GET' && url.pathname === `${routePrefix}/diagnostics`) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, lastDiagnostic }))
        return
      }

      const relativePath = url.pathname.startsWith(routePrefix) ? url.pathname.slice(routePrefix.length) : ''
      const responsesMatch = relativePath.match(/^\/v1\/([^/]+)\/responses(\/compact)?$/)
      const modelsMatch = relativePath.match(/^\/v1\/([^/]+)\/models$/)
      const imagesMatch = relativePath.match(/^\/v1\/([^/]+)\/images\/generations$/)
      const imageMcpMatch = relativePath.match(/^\/v1\/([^/]+)\/mcp\/image$/)

      if (
        (!responsesMatch || request.method !== 'POST') &&
        (!modelsMatch || request.method !== 'GET') &&
        (!imagesMatch || request.method !== 'POST') &&
        !imageMcpMatch
      ) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }

      const channelId = decodeURIComponent((responsesMatch || modelsMatch || imagesMatch || imageMcpMatch)[1])

      requestChannelId = channelId
      const channel = resolveChannel(channelId)
      const learnedWireApis = runtimeWireApis.get(channelId) || {}

      if (!channel?.baseUrl || !channel?.apiKey) throw new Error('渠道或 API Key 不可用，请在管理器中重新保存渠道')
      if (modelsMatch) {
        await handleModelsRequest(response, { ...channel, id: channel.id || channelId }, publishDiagnostic)
        return
      }
      if (imagesMatch) {
        await handleImagesRequest(request, response, { ...channel, id: channel.id || channelId }, publishDiagnostic, {
          acquireImageCall: () => acquireImageCall(channelId)
        })
        return
      }
      if (imageMcpMatch) {
        const signal = createUpstreamSignal(request, response)

        await handleImageMcpRequest(
          request,
          response,
          { ...channel, id: channel.id || channelId },
          {
            acquireImageCall: () => acquireImageCall(channelId),
            onDiagnostic: diagnostic => {
              publishDiagnostic({ channelId, ...diagnostic })
            },
            readJsonBody,
            serverVersion: APP_VERSION,
            signal
          }
        )
        return
      }
      await handleResponsesRequest(
        request,
        response,
        { ...channel, id: channel.id || channelId, runtimeModelWireApis: learnedWireApis },
        publishDiagnostic,
        (model, wireApi) => {
          if (!model || !['responses', 'chat'].includes(wireApi)) return

          const current = runtimeWireApis.get(channelId) || {}
          const matchedKey = Object.keys(current).find(key => key.toLowerCase() === model.toLowerCase())

          runtimeWireApis.set(channelId, { ...current, [matchedKey || model]: wireApi })
        },
        {
          compactV1: responsesMatch[2] === '/compact',
          onRequestContext: context => {
            requestCodexContext = context
          }
        }
      )
    } catch (error) {
      publishDiagnostic({
        capturedAt: new Date().toISOString(),
        channelId: requestChannelId,
        ...requestCodexContext,
        outcome: 'proxy_error',
        errorName: String(error?.name || 'Error'),
        errorCode: String(error?.code || '')
      })
      if (response.headersSent) {
        if (!response.writableEnded) response.end()
        return
      }

      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error), type: 'protocol_proxy_error' }
        })
      )
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', async error => {
      if (error?.code !== 'EADDRINUSE') {
        reject(error)
        return
      }

      try {
        const baseUrl = `http://127.0.0.1:${port}${routePrefix}`
        const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
        const payload = await health.json()

        if (!health.ok || payload?.service !== 'chatgpt-model-manager-protocol-proxy') throw error
        resolve({
          server: null,
          port,
          baseUrl,
          publicBaseUrl: `http://127.0.0.1:${port}/proxy/[redacted]`,
          accessToken,
          reused: true,
          lastDiagnostic: payload?.lastDiagnostic || null
        })
      } catch {
        reject(error)
      }
    })
    server.listen(port, '127.0.0.1', () => {
      const boundPort = server.address().port

      resolve({
        server,
        port: boundPort,
        baseUrl: `http://127.0.0.1:${boundPort}${routePrefix}`,
        publicBaseUrl: `http://127.0.0.1:${boundPort}/proxy/[redacted]`,
        accessToken,
        getLastDiagnostic: () => lastDiagnostic
      })
    })
  })
}

module.exports = {
  DEFAULT_PROTOCOL_PROXY_PORT,
  PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS,
  PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES,
  PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES,
  PROMPT_TOOL_RECOVERY_MAX_TOKENS,
  PROMPT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS,
  UPSTREAM_CAPACITY_MAX_RETRIES,
  adaptResponsesRequest,
  coalesceAssistantMessages,
  createProtocolProxy,
  endpointCompatibilityFailure,
  fetchWithCapacityRetry,
  inferredWireApiForModel,
  modelIdentityLabel,
  modelIdentityInstruction,
  normalizeCompactionInput,
  normalizeResponsesToolItemIds,
  recoveryFailureKindForError,
  recoveryFailureKindForStatus,
  recoveryFailureMessage,
  runWithAbortTimeout,
  upstreamFailureKind,
  upstreamRejectsNativeTools,
  upstreamModelsUrl,
  wireApiForModel,
  responsesRequestToChat
}
