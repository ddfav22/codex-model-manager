function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => {
      if (typeof part === 'string') return part

      return String(part?.text || part?.output_text || part?.refusal || '')
    })
    .filter(Boolean)
    .join('')
}

function parseJsonPayload(text) {
  try {
    return String(text || '').trim() ? JSON.parse(String(text).trim()) : null
  } catch {
    return null
  }
}

function parseSsePayloads(text) {
  const events = []
  let sawDone = false

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed.startsWith('data:')) continue
    const raw = trimmed.slice(5).trim()

    if (!raw) continue
    if (raw === '[DONE]') {
      sawDone = true
      continue
    }

    try {
      events.push(JSON.parse(raw))
    } catch {
      // Ignore provider comments and malformed compatibility metadata.
    }
  }

  return { events, sawDone }
}

function parseResponsesProbePayload(text) {
  const json = parseJsonPayload(text)
  const { events, sawDone } = parseSsePayloads(text)
  const terminalEvent = [...events]
    .reverse()
    .find(event => ['response.completed', 'response.failed', 'response.incomplete'].includes(event?.type))
  const jsonIsResponse = Boolean(json?.object === 'response' || Array.isArray(json?.output))
  const jsonFailed = Boolean(['failed', 'incomplete'].includes(json?.status) || json?.error)
  const completed =
    terminalEvent?.type === 'response.completed'
      ? terminalEvent
      : jsonIsResponse && !jsonFailed
        ? { response: json }
        : null
  const errorEvent = [...events].reverse().find(event => event?.type === 'error')
  const failedResponse =
    terminalEvent && ['response.failed', 'response.incomplete'].includes(terminalEvent.type)
      ? terminalEvent.response
      : jsonFailed
        ? json
        : null
  const error = errorEvent?.error || failedResponse?.error || json?.error || errorEvent || null
  const failure =
    failedResponse || errorEvent
      ? {
          terminalType: terminalEvent?.type || (json?.status ? `response.${json.status}` : 'error'),
          status: String(failedResponse?.status || json?.status || '').trim(),
          reason: String(failedResponse?.incomplete_details?.reason || json?.incomplete_details?.reason || '').trim(),
          code: String(error?.code || '').trim(),
          type: String(error?.type || '').trim(),
          message: String(error?.message || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500)
        }
      : null
  const items = [
    ...(Array.isArray(json?.output) ? json.output : []),
    ...events.filter(event => event?.type === 'response.output_item.done' && event.item).map(event => event.item),
    ...(Array.isArray(completed?.response?.output) ? completed.response.output : [])
  ]
  const terminalTexts = events.flatMap(event => {
    if (event?.type === 'response.output_text.done') return [event.text]
    if (event?.type === 'response.content_part.done') {
      return [event.part?.text, event.part?.output_text, event.part?.refusal]
    }

    return []
  })
  const itemTexts = items.flatMap(item => {
    if (item?.type !== 'message') return []

    return [textFromContent(item.content)]
  })
  const deltaText = events
    .filter(event => event?.type === 'response.output_text.delta')
    .map(event => String(event?.delta || ''))
    .join('')
  const outputText = [json?.output_text, ...terminalTexts, ...itemTexts, deltaText]
    .map(value => String(value || '').trim())
    .find(Boolean)
  const hasSuccessfulTerminal = Boolean(completed || (sawDone && !failure))

  return {
    json,
    events,
    items,
    outputText: outputText || '',
    completed: Boolean(outputText && hasSuccessfulTerminal && !failure),
    sawDone,
    terminalType: terminalEvent?.type || (json?.status ? `response.${json.status}` : ''),
    failure,
    actualModel: String(
      json?.model ||
        terminalEvent?.response?.model ||
        completed?.response?.model ||
        events.find(event => event?.response?.model)?.response?.model ||
        events.find(event => event?.model)?.model ||
        ''
    ).trim()
  }
}

module.exports = {
  parseResponsesProbePayload,
  parseSsePayloads,
  textFromContent
}
