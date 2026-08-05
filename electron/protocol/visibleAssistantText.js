const TOOL_HTML_PATTERN = /(?:globalThis\s*\.\s*tools|\btools\s*\.\s*[a-zA-Z_]|\bshell_command\b|<codex_tool_call\b)/i

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

  text = stripToolHtmlScaffold(text)
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
  normalizeVisibleAssistantText,
  sanitizeVisibleAssistantDelta,
  stripToolHtmlScaffold
}
