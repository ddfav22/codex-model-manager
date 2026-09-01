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
  // Compatible routes may fall back to generic XML names. Treat them as
  // control syntax for visible-progress truncation; the actual tool parser
  // still validates the name against the active allowlist.
  '<tool_call',
  '<function_call',
  '<custom_tool_call',
  '<tool_result',
  '<function_call_output',
  '<custom_tool_call_output',
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

  const fencedJsonPrefix = text.match(
    /(?:^|\r?\n)([ \t]*`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?[ \t]*(?:\r?\n[ \t]*)?)$/i
  )

  if (fencedJsonPrefix) {
    const prefixStart = Number(fencedJsonPrefix.index || 0) + fencedJsonPrefix[0].length - fencedJsonPrefix[1].length

    earliest = earliest < 0 ? prefixStart : Math.min(earliest, prefixStart)
  }

  return earliest
}

function markdownToolFenceStart(content, { includeSingleFence = false } = {}) {
  const text = String(content || '')
  const singleFence = includeSingleFence ? text.search(/```(?:html?|xml)\b/i) : -1

  if (singleFence >= 0) return singleFence

  const repeatedFence = text.match(/```(?:html?|xml|json)\b[\s\S]{0,160}?```(?:html?|xml|json)\b/i)
  const compactRepeatedLabel = text.match(/\b(?:html?|xml|json)\b\s*`{2,}\s*(?:html?|xml|json)\b/i)
  const match = repeatedFence || compactRepeatedLabel

  if (!match) return -1

  return Number(match.index || 0)
}

function emulatedToolSyntaxStart(content, options = {}) {
  const text = String(content || '')
  const lowerText = text.toLowerCase()
  const candidates = [
    encodedToolFrameStart(text),
    internalToolTranscriptStart(text),
    options.includeMarkdownFence ? markdownToolFenceStart(text, { includeSingleFence: true }) : -1,
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
  markdownToolFenceStart,
  partialControlMarkerStart
}
