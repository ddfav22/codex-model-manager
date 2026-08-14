const TOOL_HTML_PATTERN = /(?:globalThis\s*\.\s*tools|\btools\s*\.\s*[a-zA-Z_]|\bshell_command\b|<codex_tool_call\b)/i

// Grok/NewAPI sometimes serializes the tool protocol as ordinary assistant
// text.  Keep the tag list deliberately narrow: generic HTML/XML must remain
// visible, while the known call/result envelopes are removed before they are
// rendered by Codex.  The matching code below also accepts HTML entities and
// JSON-style unicode escapes because relays commonly escape the angle
// brackets before forwarding a delta.
const TOOL_CONTROL_TAG_NAME_PATTERN =
  '(?:codex_(?:tool_call|no_tool)|(?:grok|newapi|mcp)[_:.-](?:tool|function)(?:[_:.-](?:call|result|output))?|(?:custom_)?(?:tool|function)_(?:call|call_output|result|output))'
const TOOL_CONTROL_TAG_NAME_RE = new RegExp(`^${TOOL_CONTROL_TAG_NAME_PATTERN}$`, 'i')
const TOOL_CONTROL_OPEN_RE = new RegExp(
  `(?:<|&lt;|&#0*60;|&#x0*3c;|\\\\+u003c|\\\\+x3c)(${TOOL_CONTROL_TAG_NAME_PATTERN})(?:\\s[^\\r\\n<>]*?)?(?:>|&gt;|&#0*62;|&#x0*3e;|\\\\+u003e|\\\\+x3e)`,
  'ig'
)
const TOOL_CONTROL_PREFIX_RE = /(?:<|&lt;|&#0*60;|&#x0*3c;|\\+u003c|\\+x3c)[a-z0-9_.:-]*$/i
const TOOL_CONTROL_TAG_PREFIXES = Object.freeze([
  '<codex_tool_call',
  '<codex_no_tool',
  '<tool_call',
  '<function_call',
  '<custom_tool_call',
  '<tool_result',
  '<function_call_output',
  '<custom_tool_call_output'
])
const TOOL_CONTROL_MAX_BUFFER = 512 * 1024
const TOOL_CONTROL_MAX_TAG_PREFIX = 192

// Grok/NewAPI may echo an empty adapter envelope as ordinary assistant text.
// Keep this allowlist narrow so user-authored XML is not removed accidentally.
const INTERNAL_EMPTY_TAG_NAME = /^(?:codex|tool|function|grok|newapi)(?:[_:-].*)?$/i

function stripEmptyXmlMarkdownFence(content) {
  return String(content || '').replace(/(^|\r?\n)```xml[ \t]*\r?\n[\s\uFEFF]*?```(?=$|\r?\n)/gi, '$1')
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeControlMarkup(value) {
  return String(value || '')
    .replace(/&lt;|&#0*60;|&#x0*3c;|\\+u003c|\\+x3c/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;|\\+u003e|\\+x3e/gi, '>')
    .replace(/\\+u0022/gi, '"')
    .replace(/\\+u0027/gi, "'")
}

function controlClosingTag(name) {
  return new RegExp(
    `(?:<|&lt;|&#0*60;|&#x0*3c;|\\\\+u003c|\\\\+x3c)\\/${escapeRegExp(name)}[ \\t]*(?:>|&gt;|&#0*62;|&#x0*3e;|\\\\+u003e|\\\\+x3e)`,
    'i'
  )
}

function controlTagIsLineStart(text, index) {
  const lineStart = Math.max(0, String(text || '').lastIndexOf('\n', Math.max(0, index) - 1) + 1)

  return /^[ \t]*$/u.test(String(text || '').slice(lineStart, Math.max(0, index)))
}

function controlTagHasProtocolMarker(opening, body) {
  const normalizedOpening = decodeControlMarkup(opening)
  const normalizedBody = decodeControlMarkup(body).trim()

  if (/(?:^|[ \t])(?:name|call_id|tool|tool_name|arguments|input|output|result)\s*=/i.test(normalizedOpening)) {
    return true
  }

  if (!/^[{[]/u.test(normalizedBody)) return false

  return /(?:["'](?:name|call_id|tool|tool_name|arguments|input|output|result)["']\s*:|\b(?:name|call_id|tool|tool_name|arguments|input|output|result)\s*:)/i.test(
    normalizedBody
  )
}

function controlTagShouldStrip(name, opening, body, options = {}) {
  if (!TOOL_CONTROL_TAG_NAME_RE.test(String(name || ''))) return false
  if (options.inCodeFence === true) return false

  const normalizedName = String(name || '').toLowerCase()
  const normalizedOpening = decodeControlMarkup(opening)
  const normalizedBody = decodeControlMarkup(body).trim()
  const strongPrefix = /^(?:codex|grok|newapi|mcp)[_:.-]/i.test(normalizedName)
  const outputTag = /(?:_output|_result)$/i.test(normalizedName)
  const callTag = /_call$/i.test(normalizedName)
  const lineStart = options.lineStart === true

  if (strongPrefix || controlTagHasProtocolMarker(normalizedOpening, normalizedBody)) return true
  if (outputTag) return true
  if (callTag && !normalizedBody) return true
  if (lineStart && callTag && (!normalizedBody || /^[{[]/u.test(normalizedBody))) return true

  return options.selfClosing === true
}

function possibleControlTagPrefixLength(text) {
  const source = String(text || '')
  const lower = source.toLowerCase()
  const candidates = [
    source.lastIndexOf('<'),
    lower.lastIndexOf('&lt'),
    lower.lastIndexOf('&#'),
    lower.lastIndexOf('\\u'),
    lower.lastIndexOf('\\x')
  ]
  const start = Math.max(...candidates)

  if (start < 0 || source.length - start > TOOL_CONTROL_MAX_TAG_PREFIX) return 0

  const suffix = source.slice(start)

  if (TOOL_CONTROL_PREFIX_RE.test(suffix)) return suffix.length
  if (/^&lt;[a-z0-9_.:-]*$/i.test(suffix)) return suffix.length
  if (/^&#(?:x?0*[0-9a-f]{0,4});?$/i.test(suffix)) return suffix.length
  if (/^\\+u[0-9a-f]{0,4}$/i.test(suffix) || /^\\+x[0-9a-f]{0,2}$/i.test(suffix)) return suffix.length

  return 0
}

function isKnownToolControlPrefix(value) {
  const normalized = decodeControlMarkup(value).toLowerCase()

  return TOOL_CONTROL_TAG_PREFIXES.some(prefix => prefix.startsWith(normalized) || normalized.startsWith(prefix))
}

function createMarkdownFenceTracker() {
  const state = { character: '', length: 0, line: '' }

  const consumeLine = line => {
    const match = String(line || '').match(/^[ \t]*(`{3,}|~{3,})(?:.*)$/u)

    if (!match) return
    const marker = match[1]

    if (!state.character) {
      state.character = marker[0]
      state.length = marker.length
      return
    }

    if (marker[0] === state.character && marker.length >= state.length) {
      state.character = ''
      state.length = 0
    }
  }

  return {
    get inFence() {
      return Boolean(state.character)
    },
    push(content) {
      state.line += String(content || '')

      for (;;) {
        const newline = state.line.search(/\r?\n/u)

        if (newline < 0) break
        const line = state.line.slice(0, newline)
        state.line = state.line.slice(
          newline + (state.line[newline] === '\r' && state.line[newline + 1] === '\n' ? 2 : 1)
        )
        consumeLine(line)
      }
    },
    finish() {
      if (state.line) consumeLine(state.line)
      state.line = ''
    }
  }
}

function createToolControlStreamSanitizer() {
  let buffer = ''
  let control = null
  const fence = createMarkdownFenceTracker()

  const emit = (parts, value) => {
    const text = String(value || '')

    if (!text) return
    parts.push(text)
    fence.push(text)
  }

  const drain = final => {
    const parts = []

    for (;;) {
      if (control) {
        const closing = controlClosingTag(control.name).exec(buffer)

        if (!closing) {
          if (!final) {
            if (buffer.length <= TOOL_CONTROL_MAX_BUFFER) break

            const block = `${control.opening}${buffer}`
            if (controlTagShouldStrip(control.name, control.opening, buffer, { lineStart: control.lineStart })) {
              buffer = ''
              control = null
              continue
            }

            emit(parts, block)
            buffer = ''
            control = null
            continue
          }

          const block = `${control.opening}${buffer}`
          if (!controlTagShouldStrip(control.name, control.opening, buffer, { lineStart: control.lineStart })) {
            emit(parts, block)
          }
          buffer = ''
          control = null
          continue
        }

        const body = buffer.slice(0, closing.index)
        const block = `${control.opening}${body}${closing[0]}`
        const shouldStrip = controlTagShouldStrip(control.name, control.opening, body, {
          lineStart: control.lineStart
        })

        if (!shouldStrip) emit(parts, block)
        buffer = buffer.slice(closing.index + closing[0].length)
        control = null
        continue
      }

      TOOL_CONTROL_OPEN_RE.lastIndex = 0
      const opening = TOOL_CONTROL_OPEN_RE.exec(buffer)

      if (!opening) {
        if (final) {
          const keep = possibleControlTagPrefixLength(buffer)
          const trailing = keep ? buffer.slice(buffer.length - keep) : ''

          if (!fence.inFence && trailing && isKnownToolControlPrefix(trailing)) {
            emit(parts, buffer.slice(0, buffer.length - keep))
          } else {
            emit(parts, buffer)
          }
          buffer = ''
          break
        }

        const keep = possibleControlTagPrefixLength(buffer)
        const safeLength = Math.max(0, buffer.length - keep)

        emit(parts, buffer.slice(0, safeLength))
        buffer = buffer.slice(safeLength)
        break
      }

      const prefix = buffer.slice(0, opening.index)
      const lineStart = controlTagIsLineStart(buffer, opening.index)
      emit(parts, prefix)
      buffer = buffer.slice(opening.index + opening[0].length)

      if (fence.inFence) {
        emit(parts, opening[0])
        continue
      }

      const name = opening[1]
      const selfClosing = /(?:\/\s*(?:>|&gt;|&#0*62;|&#x0*3e;|\\+u003e|\\+x3e))$/i.test(opening[0])
      const inspect =
        TOOL_CONTROL_TAG_NAME_RE.test(name) ||
        /^(?:codex|grok|newapi|mcp)[_:.-]/i.test(name) ||
        controlTagHasProtocolMarker(opening[0], '') ||
        lineStart

      if (!inspect) {
        emit(parts, opening[0])
        continue
      }

      if (selfClosing) {
        if (!controlTagShouldStrip(name, opening[0], '', { lineStart, selfClosing: true })) {
          emit(parts, opening[0])
        }
        continue
      }

      control = { name, opening: opening[0], lineStart }
    }

    return parts.join('')
  }

  return {
    push(content) {
      buffer += String(content || '')

      return drain(false)
    },
    finish() {
      const output = drain(true)
      fence.finish()
      return output
    }
  }
}

function stripToolControlTags(content) {
  const sanitizer = createToolControlStreamSanitizer()

  return `${sanitizer.push(content)}${sanitizer.finish()}`
}

function createEmptyXmlMarkdownFenceStreamSanitizer() {
  let buffer = ''

  const drain = final => {
    let output = ''

    while (buffer) {
      const opening = /(^|\r?\n)```xml[ \t]*\r?\n/i.exec(buffer)

      if (!opening) {
        const lineStart = buffer.lastIndexOf('\n') + 1
        const candidate = buffer.slice(lineStart)
        const pendingOpening = /^```x(?:m(?:l)?)?[ \t]*\r?$/i.test(candidate)

        if (final) {
          output += pendingOpening ? buffer.slice(0, lineStart) : buffer
          buffer = ''
          break
        }

        const keep = pendingOpening ? candidate.length : 0

        output += buffer.slice(0, buffer.length - keep)
        buffer = buffer.slice(buffer.length - keep)
        break
      }

      const fenceStart = opening.index + opening[1].length
      const openingLength = opening[0].length - opening[1].length

      output += buffer.slice(0, fenceStart)
      buffer = buffer.slice(fenceStart)
      const closingIndex = buffer.indexOf('```', openingLength)

      if (closingIndex < 0) {
        if (!final) break
        buffer = ''
        break
      }

      const inner = buffer.slice(openingLength, closingIndex)
      const fenceEnd = closingIndex + 3

      if (inner.replace(/\uFEFF/g, '').trim()) output += buffer.slice(0, fenceEnd)
      buffer = buffer.slice(fenceEnd)
    }

    return output
  }

  return {
    push(content) {
      buffer += String(content || '')

      return drain(false)
    },
    finish() {
      return drain(true)
    }
  }
}

function createVisibleAssistantStreamSanitizer() {
  const controlSanitizer = createToolControlStreamSanitizer()
  const emptyXmlSanitizer = createEmptyXmlMarkdownFenceStreamSanitizer()

  return {
    push(content) {
      return emptyXmlSanitizer.push(controlSanitizer.push(content))
    },
    finish() {
      const controlTail = controlSanitizer.finish()

      return `${emptyXmlSanitizer.push(controlTail)}${emptyXmlSanitizer.finish()}`
    }
  }
}

function stripEmptyInternalXml(content) {
  return stripEmptyXmlMarkdownFence(content)
    .replace(/<([a-z][\w:.-]*)\b[^>]*>\s*<\/\1\s*>/gi, (match, tagName) => {
      return INTERNAL_EMPTY_TAG_NAME.test(tagName) ? '' : match
    })
    .replace(
      /<(?:codex(?:[_:-][\w:.-]*)?|tool(?:[_:-][\w:.-]*)?|function(?:[_:-][\w:.-]*)?|grok(?:[_:-][\w:.-]*)?|newapi(?:[_:-][\w:.-]*)?)\b[^>]*\/>/gi,
      ''
    )
}

function decodeJsonString(content) {
  const text = String(content || '').trim()

  if (!text.startsWith('"') || !text.endsWith('"')) return String(content || '')

  try {
    const parsed = JSON.parse(text)

    return typeof parsed === 'string' ? parsed : String(content || '')
  } catch {
    return String(content || '')
  }
}

function stripToolHtmlScaffold(content) {
  const text = String(content || '')

  if (!TOOL_HTML_PATTERN.test(text)) return text

  return text
    .replace(/<!doctype\s+html[^>]*>[\s\S]*?<\/html\s*>/gi, '')
    .replace(/<html\b[^>]*>[\s\S]*?<\/html\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
}

function decodeRepeatedEscapedLineBreaks(content) {
  return String(content || '')
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2) return part

      const escapedBreaks = part.match(/\\r\\n|\\n|\\r/g) || []
      const actualBreaks = part.match(/[\r\n]/g) || []

      if (escapedBreaks.length < 2 || actualBreaks.length) return part

      return part.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '\t')
    })
    .join('')
}

function sanitizeVisibleAssistantDelta(content) {
  let text = decodeJsonString(content)

  text = stripEmptyInternalXml(stripToolControlTags(stripToolHtmlScaffold(text)))
    .replace(/(?:0x)?a0a1e\d+[a-zA-Z_][\s\S]*$/gi, '')
    .replace(/<codex_tool_call\b[^>]*>[\s\S]*?<\/codex_tool_call\s*>/gi, '')
    .replace(/<codex_tool_call\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<codex_no_tool\b[^>]*>[\s\S]*?<\/codex_no_tool\s*>/gi, '')
  text = decodeRepeatedEscapedLineBreaks(text)

  if (/\\[rnt]/u.test(text) && /^(?:(?:\\[rnt])+|\s)*$/u.test(text)) return ''
  if (/^(?:[ \t]*\r?\n){3,}[ \t]*$/u.test(text)) return ''

  return text
}

function normalizeVisibleAssistantText(content) {
  const text = sanitizeVisibleAssistantDelta(content)

  if (!text.trim()) return ''

  return text.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n').trim()
}

module.exports = {
  decodeRepeatedEscapedLineBreaks,
  createVisibleAssistantStreamSanitizer,
  normalizeVisibleAssistantText,
  sanitizeVisibleAssistantDelta,
  stripEmptyInternalXml,
  stripEmptyXmlMarkdownFence,
  stripToolControlTags,
  stripToolHtmlScaffold
}
