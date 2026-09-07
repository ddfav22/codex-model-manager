const { createParser } = require('eventsource-parser')

const MAX_PROBE_BYTES = 1024 * 1024
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])

// A terminal SSE event ends a probe; HTTP EOF is not required. This is only
// used by diagnostics and never changes the user's normal response stream.
async function readResponsesProbeText(response, readText, limit = MAX_PROBE_BYTES) {
  if (!response.body?.getReader || !/text\/event-stream/i.test(response.headers?.get('content-type') || '')) {
    return readText(response, limit)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let size = 0
  let terminal = false
  const parser = createParser({
    onEvent(event) {
      if (event.data === '[DONE]') {
        terminal = true
        return
      }
      try {
        if (TERMINAL_EVENTS.has(JSON.parse(event.data)?.type)) terminal = true
      } catch {
        // Non-JSON metadata does not establish success or terminate a probe.
      }
    }
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error(`上游响应超过 ${limit} 字节限制`)
      const text = decoder.decode(value, { stream: true })

      chunks.push(text)
      parser.feed(text)
      if (terminal) break
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    // Do not wait for a provider-specific cancel handshake after completion.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

module.exports = { MAX_PROBE_BYTES, readResponsesProbeText }
