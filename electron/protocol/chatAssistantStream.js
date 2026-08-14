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

const MAX_SEEN_CHAT_SNAPSHOTS = 128

function looksLikeRepeatedMarkupFence(value) {
  const compact = String(value || '').replace(/[\s\uFEFF]+/g, '')

  if (!compact || compact.length > 256) return false

  return /^(?:(?:`{1,3})?(?:html?|xml|json)(?:`{1,3})?){2,}$/i.test(compact)
}

/**
 * NewAPI-compatible Grok channels are seen in the wild sending a complete
 * assistant snapshot in `delta.content` for every SSE event.  Codex expects
 * deltas, so blindly appending those snapshots renders `html````html...` and
 * duplicates tool envelopes.  This small, provider-safe normalizer starts in
 * incremental mode and switches to snapshot mode only after an incoming value
 * grows the already assembled prefix.  Ordinary repeated prose remains
 * untouched.
 */
function createChatDeltaNormalizer({ allowCumulativeSnapshots = false } = {}) {
  let aggregate = ''
  let snapshotMode = false
  let lastInput = ''
  const seenInputs = new Set()

  const rememberInput = input => {
    if (!input) return

    seenInputs.add(input)
    if (seenInputs.size <= MAX_SEEN_CHAT_SNAPSHOTS) return

    const oldest = seenInputs.values().next().value

    if (oldest !== undefined) seenInputs.delete(oldest)
  }

  return {
    push(value, { snapshot = false } = {}) {
      const incoming = String(value || '')

      if (!incoming) return { delta: '', snapshot: aggregate }

      const snapshotInput = allowCumulativeSnapshots || snapshot

      if (incoming === aggregate && (snapshotMode || snapshotInput || looksLikeRepeatedMarkupFence(incoming))) {
        snapshotMode = true
        rememberInput(incoming)

        return { delta: '', snapshot: aggregate }
      }

      if (snapshotInput && aggregate && incoming.length > aggregate.length && incoming.startsWith(aggregate)) {
        snapshotMode = true
      }

      if (snapshotMode && aggregate && incoming.startsWith(aggregate)) {
        const extension = incoming.slice(aggregate.length)

        if (!extension) {
          lastInput = incoming
          rememberInput(incoming)

          return { delta: '', snapshot: aggregate }
        }

        aggregate = incoming
        lastInput = incoming
        rememberInput(incoming)

        return { delta: extension, snapshot: aggregate }
      }

      if (snapshotMode) {
        const replayedMarkup =
          seenInputs.has(incoming) ||
          (incoming.length < aggregate.length &&
            (aggregate.startsWith(incoming) || aggregate.endsWith(incoming)) &&
            looksLikeRepeatedMarkupFence(incoming))

        if (replayedMarkup || incoming === lastInput) {
          lastInput = incoming
          rememberInput(incoming)

          return { delta: '', snapshot: aggregate }
        }
      }

      aggregate += incoming
      lastInput = incoming
      rememberInput(incoming)

      return { delta: incoming, snapshot: aggregate }
    },
    get snapshot() {
      return aggregate
    }
  }
}

function assistantFromJson(parsed, options = {}) {
  const message = parsed?.choices?.[0]?.message || {}
  const content = textFromContent(message.content)
  const normalizer = createChatDeltaNormalizer({ allowCumulativeSnapshots: true })
  const normalized = normalizer.push(content, { snapshot: true })

  safeCallback(options.onContentDelta, normalized.delta, normalized.snapshot)

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
  const deltaNormalizer = createChatDeltaNormalizer({
    allowCumulativeSnapshots: options.allowCumulativeSnapshots === true
  })
  const parser = createParser({
    onEvent(event) {
      if (!event.data || event.data === '[DONE]') return

      try {
        const chunk = JSON.parse(event.data)

        id ||= String(chunk.id || '')
        model ||= String(chunk.model || '')
        usage ||= chunk.usage || null
        for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
          const hasMessageSnapshot = choice?.message && choice.message.content !== undefined
          const rawContent = hasMessageSnapshot
            ? textFromContent(choice.message.content)
            : textFromContent(choice?.delta?.content)
          const normalized = deltaNormalizer.push(rawContent, { snapshot: hasMessageSnapshot })
          const delta = normalized.delta

          if (!delta) continue
          content = normalized.snapshot
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

module.exports = { createChatDeltaNormalizer, readChatAssistant }
