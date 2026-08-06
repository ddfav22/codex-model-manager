const { createHash } = require('crypto')

const OPTIONAL_CHAT_PARAMETERS = [
  'stream_options',
  'parallel_tool_calls',
  'tool_choice',
  'reasoning_effort',
  'service_tier',
  'verbosity'
]
const MAX_OPTIONAL_PARAMETER_RETRIES = 3

function normalizeToolArguments(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function deterministicToolCallId(name, argumentsValue, index = 0) {
  const digest = createHash('sha256')
    .update(`${String(name || '')}\0${normalizeToolArguments(argumentsValue)}\0${Number(index) || 0}`)
    .digest('hex')
    .slice(0, 24)

  return `call_${digest}`
}

function uniqueToolCallId(value, usedIds, suffixPrefix = 'd') {
  const used = usedIds instanceof Set ? usedIds : new Set()
  const base =
    String(value || '')
      .trim()
      .slice(0, 64) || 'call_missing'
  let candidate = base
  let suffix = 2

  while (used.has(candidate)) {
    const marker = `_${suffixPrefix}${suffix}`

    candidate = `${base.slice(0, Math.max(1, 64 - marker.length))}${marker}`
    suffix += 1
  }

  return candidate
}

function mergeStreamedToolName(currentValue, incomingValue) {
  const current = String(currentValue || '')
  const incoming = String(incomingValue || '')

  if (!incoming) return current
  if (!current) return incoming
  if (incoming === current || current.endsWith(incoming)) return current
  if (incoming.startsWith(current)) return incoming

  return `${current}${incoming}`
}

function cloneToolCall(toolCall) {
  const source = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const sourceFunction = source.function && typeof source.function === 'object' ? source.function : {}

  return {
    ...source,
    type: 'function',
    function: {
      ...sourceFunction,
      name: String(sourceFunction.name || '').trim(),
      arguments: normalizeToolArguments(sourceFunction.arguments)
    }
  }
}

function sanitizeChatToolHistory(sourceMessages) {
  const diagnostics = {
    droppedEmptyToolCallArrays: 0,
    droppedInvalidToolCalls: 0,
    droppedOrphanToolResults: 0,
    droppedIncompleteToolCalls: 0,
    rewrittenToolCallIds: 0,
    deduplicatedToolCallIds: 0
  }
  const usedIds = new Set()
  const pendingByOriginalId = new Map()
  const normalized = []

  const pendingQueue = originalId => {
    const key = String(originalId || '').trim()
    let queue = pendingByOriginalId.get(key)

    if (!queue) {
      queue = []
      pendingByOriginalId.set(key, queue)
    }

    return queue
  }

  for (const originalMessage of Array.isArray(sourceMessages) ? sourceMessages : []) {
    if (!originalMessage || typeof originalMessage !== 'object') continue

    if (originalMessage.role === 'assistant' && Object.prototype.hasOwnProperty.call(originalMessage, 'tool_calls')) {
      if (!Array.isArray(originalMessage.tool_calls) || !originalMessage.tool_calls.length) {
        diagnostics.droppedEmptyToolCallArrays += 1
        const { tool_calls: _toolCalls, ...messageWithoutEmptyCalls } = originalMessage

        if (messageWithoutEmptyCalls.content) normalized.push(messageWithoutEmptyCalls)
        continue
      }

      const toolCalls = []

      for (const [index, rawToolCall] of originalMessage.tool_calls.entries()) {
        const toolCall = cloneToolCall(rawToolCall)

        if (!toolCall.function.name) {
          diagnostics.droppedInvalidToolCalls += 1
          continue
        }

        const originalId = String(toolCall.id || '').trim()
        const fallbackId = deterministicToolCallId(toolCall.function.name, toolCall.function.arguments, index)
        const canonicalId = uniqueToolCallId(originalId || fallbackId, usedIds)

        if (canonicalId !== originalId) diagnostics.rewrittenToolCallIds += 1
        if (originalId && usedIds.has(originalId)) diagnostics.deduplicatedToolCallIds += 1
        toolCall.id = canonicalId
        usedIds.add(canonicalId)
        pendingQueue(originalId).push(canonicalId)
        toolCalls.push(toolCall)
      }

      if (toolCalls.length) normalized.push({ ...originalMessage, tool_calls: toolCalls })
      else {
        const { tool_calls: _toolCalls, ...messageWithoutInvalidCalls } = originalMessage

        if (messageWithoutInvalidCalls.content) normalized.push(messageWithoutInvalidCalls)
      }
      continue
    }

    if (originalMessage.role === 'tool') {
      const originalId = String(originalMessage.tool_call_id || '').trim()
      const canonicalId = pendingQueue(originalId).shift()

      if (!canonicalId) {
        diagnostics.droppedOrphanToolResults += 1
        continue
      }

      normalized.push({ ...originalMessage, tool_call_id: canonicalId })
      continue
    }

    normalized.push(originalMessage)
  }

  const complete = []

  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index]

    if (message.role === 'tool') {
      diagnostics.droppedOrphanToolResults += 1
      continue
    }

    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      if (message.role === 'assistant' && !message.content) continue
      complete.push(message)
      continue
    }

    const followingResults = []
    let resultIndex = index + 1

    while (normalized[resultIndex]?.role === 'tool') {
      followingResults.push(normalized[resultIndex])
      resultIndex += 1
    }

    const resultIds = new Set(followingResults.map(result => String(result.tool_call_id || '')))
    const completeCalls = message.tool_calls.filter(toolCall => resultIds.has(String(toolCall.id || '')))
    const completeCallIds = new Set(completeCalls.map(toolCall => String(toolCall.id || '')))
    const completeResults = followingResults.filter(result => completeCallIds.has(String(result.tool_call_id || '')))

    diagnostics.droppedIncompleteToolCalls += message.tool_calls.length - completeCalls.length
    diagnostics.droppedOrphanToolResults += followingResults.length - completeResults.length

    if (completeCalls.length) complete.push({ ...message, tool_calls: completeCalls }, ...completeResults)
    else {
      const { tool_calls: _toolCalls, ...messageWithoutIncompleteCalls } = message

      if (messageWithoutIncompleteCalls.content) complete.push(messageWithoutIncompleteCalls)
    }

    index = resultIndex - 1
  }

  return { messages: complete, diagnostics }
}

function rejectedOptionalChatParameter(status, errorText, payload) {
  if (![400, 422].includes(Number(status))) return ''

  const text = String(errorText || '').toLowerCase()
  const rejection =
    /(?:unsupported|not supported|unrecognized|unknown|not allowed|not permitted|unexpected|extra inputs?|invalid (?:argument|parameter|field)|does not accept)/i.test(
      text
    )

  if (!rejection) return ''

  for (const parameter of OPTIONAL_CHAT_PARAMETERS) {
    if (!Object.prototype.hasOwnProperty.call(payload || {}, parameter)) continue
    if (text.includes(parameter) || text.includes(parameter.replace(/_/g, ' '))) return parameter
  }

  if (
    Array.isArray(payload?.tools) &&
    payload.tools.some(tool => typeof tool?.function?.strict === 'boolean') &&
    /(?:function\.)?strict|tools?\[[0-9]+\].*strict/i.test(text)
  ) {
    return 'tool_function_strict'
  }

  return ''
}

function withoutRejectedChatParameter(payload, parameter) {
  const compatible = { ...(payload || {}) }

  if (parameter === 'tool_function_strict') {
    compatible.tools = (Array.isArray(payload?.tools) ? payload.tools : []).map(tool => {
      if (!tool?.function || typeof tool.function.strict !== 'boolean') return tool
      const { strict: _strict, ...compatibleFunction } = tool.function

      return { ...tool, function: compatibleFunction }
    })
  } else {
    delete compatible[parameter]
  }

  return compatible
}

module.exports = {
  MAX_OPTIONAL_PARAMETER_RETRIES,
  OPTIONAL_CHAT_PARAMETERS,
  deterministicToolCallId,
  mergeStreamedToolName,
  normalizeToolArguments,
  rejectedOptionalChatParameter,
  sanitizeChatToolHistory,
  uniqueToolCallId,
  withoutRejectedChatParameter
}
