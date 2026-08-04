const { createParser } = require('eventsource-parser')
const { MAX_UPSTREAM_BUFFER_BYTES, readResponseTextLimited } = require('./upstreamRequest')

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text

      return ''
    })
    .join('')
}

function safeCallback(callback, value, snapshot) {
  if (typeof callback !== 'function' || !value) return

  try {
    callback(value, snapshot)
  } catch {
    // A disconnected or faulty display callback must not interrupt the agent loop.
  }
}

function assistantFromJson(parsed, options = {}) {
  const message = parsed?.choices?.[0]?.message || {}
  const content = textFromContent(message.content)

  safeCallback(options.onContentDelta, content, content)

  return {
    id: parsed?.id,
    model: parsed?.model,
    content,
    usage: parsed?.usage
  }
}

async function readChatAssistant(upstream, options = {}) {
  const contentType = String(upstream.headers?.get?.('content-type') || '').toLowerCase()

  if (!contentType.includes('text/event-stream')) {
    const raw = await readResponseTextLimited(upstream)
    let parsed

    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }

    if (parsed) return assistantFromJson(parsed, options)

    return { id: '', model: '', content: raw, usage: null }
  }

  let id = ''
  let model = ''
  let content = ''
  let usage = null
  let byteCount = 0
  const parser = createParser({
    onEvent(event) {
      if (!event.data || event.data === '[DONE]') return

      try {
        const chunk = JSON.parse(event.data)

        id ||= String(chunk.id || '')
        model ||= String(chunk.model || '')
        usage ||= chunk.usage || null
        for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
          const delta = textFromContent(choice?.delta?.content)

          if (!delta) continue
          content += delta
          safeCallback(options.onContentDelta, delta, content)
        }
      } catch {
        // Ignore provider-specific SSE metadata while retaining valid text deltas.
      }
    }
  })
  const reader = upstream.body?.getReader?.()
  const decoder = new TextDecoder()

  if (!reader) return { id, model, content, usage }

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    byteCount += value.byteLength
    if (byteCount > MAX_UPSTREAM_BUFFER_BYTES) {
      await reader.cancel('上游响应过大')
      throw new Error(`上游响应超过 ${MAX_UPSTREAM_BUFFER_BYTES} 字节限制`)
    }
    parser.feed(decoder.decode(value, { stream: true }))
  }

  const tail = decoder.decode()

  if (tail) parser.feed(tail)
  parser.reset({ consume: true })

  return { id, model, content, usage }
}

module.exports = { readChatAssistant }
