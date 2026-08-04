const INTERNAL_TOOL_HISTORY_TAG = 'codex_internal_tool_history'
const INTERNAL_ADAPTER_TAG = 'codex_internal_adapter'

function balancedJsonEnd(content, startIndex) {
  const text = String(content || '')
  let cursor = startIndex

  while (/\s/u.test(text[cursor] || '')) cursor += 1
  if (text[cursor] !== '[' && text[cursor] !== '{') return -1

  const stack = []
  let quoted = false
  let escaped = false

  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor]

    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '[' || character === '{') stack.push(character)
    else if (character === ']' || character === '}') {
      const expected = character === ']' ? '[' : '{'

      if (stack.pop() !== expected) return -1
      if (!stack.length) return cursor + 1
    }
  }

  return -1
}

function stripLegacyToolCallsTranscript(content) {
  const text = String(content || '')
  const markerPattern = /\[Codex local tool calls\]/gi
  let visible = ''
  let cursor = 0

  for (let match = markerPattern.exec(text); match; match = markerPattern.exec(text)) {
    visible += text.slice(cursor, match.index)
    const payloadStart = match.index + match[0].length
    const payloadEnd = balancedJsonEnd(text, payloadStart)

    if (payloadEnd < 0) return visible
    cursor = payloadEnd
    while (text[cursor] === '\r' || text[cursor] === '\n') cursor += 1
    markerPattern.lastIndex = cursor
  }

  return visible + text.slice(cursor)
}

function internalToolTranscriptStart(content) {
  const text = String(content || '')
  const candidates = [
    text.search(/<codex_internal_(?:tool_history|adapter)>/i),
    text.search(/\[Codex local tool calls\]/i),
    text.search(/\[Codex local tool result\b/i),
    text.search(/\[Codex tool adapter:/i)
  ].filter(index => index >= 0)

  return candidates.length ? Math.min(...candidates) : -1
}

function internalBlock(tag, payload) {
  return `<${tag}>${JSON.stringify(payload)}</${tag}>`
}

function internalToolCallsTranscript(calls) {
  return internalBlock(INTERNAL_TOOL_HISTORY_TAG, { kind: 'tool_calls', calls: Array.isArray(calls) ? calls : [] })
}

function internalToolResultTranscript(callId, output) {
  return internalBlock(INTERNAL_TOOL_HISTORY_TAG, {
    kind: 'tool_result',
    call_id: String(callId || 'unknown'),
    output: typeof output === 'string' ? output : JSON.stringify(output ?? '')
  })
}

function internalAdapterInstruction(content) {
  return internalBlock(INTERNAL_ADAPTER_TAG, { instruction: String(content || '') })
}

function hasInternalToolResult(content) {
  const text = String(content || '')

  return (
    new RegExp(`<${INTERNAL_TOOL_HISTORY_TAG}>[^\r\n]*"kind":"tool_result"`, 'i').test(text) ||
    /\[Codex local tool result\b/i.test(text)
  )
}

function isInternalToolCallsOnly(content) {
  const text = String(content || '').trim()

  return (
    new RegExp(
      `^<${INTERNAL_TOOL_HISTORY_TAG}>[^\r\n]*"kind":"tool_calls"[^\r\n]*<\/${INTERNAL_TOOL_HISTORY_TAG}>$`,
      'i'
    ).test(text) || /^\[Codex local tool calls\][\s\S]*$/i.test(text)
  )
}

function stripInternalToolTranscript(content) {
  return stripLegacyToolCallsTranscript(content)
    .replace(/<codex_internal_(?:tool_history|adapter)>[\s\S]*?<\/codex_internal_(?:tool_history|adapter)>/gi, '')
    .replace(/<codex_internal_(?:tool_history|adapter)>[\s\S]*$/gi, '')
    .replace(/\[Codex local tool result(?: for [^\]]*)?\][ \t]*/gi, '')
    .replace(/\[Codex tool adapter:[^\]]*\]/gi, '')
}

module.exports = {
  INTERNAL_ADAPTER_TAG,
  INTERNAL_TOOL_HISTORY_TAG,
  hasInternalToolResult,
  internalAdapterInstruction,
  internalToolCallsTranscript,
  internalToolResultTranscript,
  internalToolTranscriptStart,
  isInternalToolCallsOnly,
  stripInternalToolTranscript
}
