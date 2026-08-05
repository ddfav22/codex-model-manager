const ENCODED_TOOL_FRAME_MARKERS = Object.freeze(['0xa0a1e', 'a0a1e'])
const FRAME_START_PATTERN = /(?:0x)?a0a1e\d+/gi
const FIELD_PATTERN = /(?:0x)?a1([a-zA-Z_][a-zA-Z0-9_-]*?)(?:0x)?a2/gi

function encodedToolFrameStart(content) {
  return String(content || '').search(FRAME_START_PATTERN)
}

function normalizeFieldValue(name, value) {
  const text = String(value || '').trim()

  if (/^(?:yield[-_]time[-_]ms|max[-_]tokens|timeout[-_]ms)$/i.test(name) && /^\d+$/.test(text)) {
    return Number(text)
  }
  if (/^terminate$/i.test(name) && /^(?:true|false)$/i.test(text)) return text.toLowerCase() === 'true'

  return text
}

function fieldsFromFrame(content) {
  const text = String(content || '')
  const matches = [...text.matchAll(FIELD_PATTERN)]
  const fields = {}

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const name = match[1].replace(/-/g, '_')
    const valueStart = match.index + match[0].length
    const valueEnd = matches[index + 1]?.index ?? text.length

    fields[name] = normalizeFieldValue(name, text.slice(valueStart, valueEnd))
  }

  return fields
}

function parseEncodedToolFrames(content) {
  const text = String(content || '').slice(0, 1024 * 1024)
  const starts = [...text.matchAll(FRAME_START_PATTERN)]
  const frames = []

  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]
    const frameEnd = starts[index + 1]?.index ?? text.length
    const frame = text.slice(match.index + match[0].length, frameEnd)
    const firstField = frame.search(/(?:0x)?a1[a-zA-Z_][a-zA-Z0-9_-]*?(?:0x)?a2/i)

    if (firstField <= 0) continue
    const name = frame.slice(0, firstField).trim()
    const args = fieldsFromFrame(frame.slice(firstField))

    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name) || !Object.keys(args).length) continue
    frames.push({ name, arguments: args })
  }

  return frames
}

module.exports = {
  ENCODED_TOOL_FRAME_MARKERS,
  encodedToolFrameStart,
  parseEncodedToolFrames
}
