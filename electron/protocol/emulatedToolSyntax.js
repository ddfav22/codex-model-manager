const { internalToolTranscriptStart } = require('./internalToolTranscript')
const { AGENT_COMPLETION_SIGNAL, AGENT_SAFETY_STOP_SIGNAL } = require('./toolContinuation')
const { ENCODED_TOOL_FRAME_MARKERS, encodedToolFrameStart } = require('./encodedToolFrames')

const STREAM_CONTROL_MARKERS = Object.freeze([
  ...ENCODED_TOOL_FRAME_MARKERS,
  '<!doctype html',
  '<html',
  '<script',
  '<codex_tool_call>',
  '<codex_no_tool>',
  '<codex_internal_tool_history>',
  '<codex_internal_adapter>',
  '[Codex local tool calls]',
  '[Codex local tool result',
  '[Codex tool adapter:',
  AGENT_COMPLETION_SIGNAL,
  AGENT_SAFETY_STOP_SIGNAL
])

function partialControlMarkerStart(content) {
  const text = String(content || '')
  const lowerText = text.toLowerCase()
  let earliest = -1

  for (const marker of STREAM_CONTROL_MARKERS) {
    const lowerMarker = marker.toLowerCase()
    const maximumPrefixLength = Math.min(lowerMarker.length - 1, lowerText.length)

    for (let length = maximumPrefixLength; length > 0; length -= 1) {
      const start = lowerText.length - length

      if (lowerMarker.startsWith(lowerText.slice(start))) {
        earliest = earliest < 0 ? start : Math.min(earliest, start)
        break
      }
    }
  }

  return earliest
}

function emulatedToolSyntaxStart(content, options = {}) {
  const text = String(content || '')
  const lowerText = text.toLowerCase()
  const candidates = [
    encodedToolFrameStart(text),
    internalToolTranscriptStart(text),
    ...STREAM_CONTROL_MARKERS.map(marker => lowerText.indexOf(marker.toLowerCase())),
    text.search(/<codex_(?:tool_call|no_tool)\b/i),
    text.search(/```(?:json)?\s*\{/i),
    text.search(/(?:^|\n)\s*\{\s*"?(?:tool_call|function|name|tool|tool_name)"?\s*:/i)
  ].filter(index => index >= 0)

  if (options.includePartial) {
    const partialStart = partialControlMarkerStart(text)

    if (partialStart >= 0) candidates.push(partialStart)
  }

  return candidates.length ? Math.min(...candidates) : -1
}

module.exports = {
  STREAM_CONTROL_MARKERS,
  emulatedToolSyntaxStart,
  partialControlMarkerStart
}
