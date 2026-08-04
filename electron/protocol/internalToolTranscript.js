const INTERNAL_TOOL_HISTORY_TAG = 'codex_internal_tool_history'
const INTERNAL_ADAPTER_TAG = 'codex_internal_adapter'

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
  return String(content || '')
    .replace(/<codex_internal_(?:tool_history|adapter)>[\s\S]*?<\/codex_internal_(?:tool_history|adapter)>/gi, '')
    .replace(/<codex_internal_(?:tool_history|adapter)>[\s\S]*$/gi, '')
    .replace(/\[Codex local tool calls\][ \t]*(?:\r?\n[^\r\n]*)?/gi, '')
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
  isInternalToolCallsOnly,
  stripInternalToolTranscript
}
