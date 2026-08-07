const { randomUUID } = require('crypto')
const { materializeNativeImageGenerationCall, nativeImageGenerationBase64 } = require('./newApiImageGeneration')

function clonedResponse(upstream, body) {
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers
  })
}

function sseBoundary(value) {
  const match = /\r?\n\r?\n/.exec(value)

  return match ? { index: match.index, length: match[0].length } : null
}

function ssePayload(block) {
  const data = String(block || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n')

  if (!data || data === '[DONE]') return null

  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function encodeSseEvent(payload) {
  const type = String(payload?.type || 'message')

  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function terminalResponsesEvent(type) {
  return ['response.completed', 'response.incomplete', 'response.failed'].includes(String(type || ''))
}

function imageMessage(markdown) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: markdown, annotations: [], logprobs: [] }]
  }
}

function imageMessageEvents(message, outputIndex) {
  const text = String(message.content?.[0]?.text || '')
  const pending = { ...message, status: 'in_progress', content: [] }
  const part = { type: 'output_text', text, annotations: [], logprobs: [] }

  return [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: pending
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      part: { ...part, text: '' }
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      delta: text
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      text
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      part
    },
    {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: message
    }
  ]
}

function appendImageMessage(payload, message) {
  const response = payload?.response

  if (!response || typeof response !== 'object') return payload
  const output = Array.isArray(response.output) ? response.output : []
  const outputText = String(response.output_text || '')
  const markdown = String(message.content?.[0]?.text || '')

  return {
    ...payload,
    response: {
      ...response,
      output: [...output, message],
      output_text: [outputText, markdown].filter(Boolean).join('\n\n')
    }
  }
}

function nativeResponseImageDelivery(upstream, options = {}) {
  const contentType = String(upstream?.headers?.get?.('content-type') || '')
  const isSse = /text\/event-stream/i.test(contentType)
  const stats = {
    observed: true,
    imageCount: 0,
    materializedCount: 0,
    failedCount: 0,
    injected: false
  }

  if (!upstream?.body) return { delivery: upstream, completion: Promise.resolve(stats) }
  let resolveCompletion
  const completion = new Promise(resolve => {
    resolveCompletion = resolve
  })
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let textBuffer = ''
  let maxOutputIndex = -1
  let terminalDelivered = false
  const materialized = []
  const seenItems = new Set()

  const finish = () => {
    if (!resolveCompletion) return
    const resolve = resolveCompletion

    resolveCompletion = null
    resolve({ ...stats })
  }
  const processImageItem = (item, outputIndex) => {
    const encoded = nativeImageGenerationBase64(item)

    if (!encoded) return
    const index = Number.isInteger(outputIndex) && outputIndex >= 0 ? outputIndex : maxOutputIndex + 1
    const key = String(item?.id || `output-${index}-bytes-${encoded.length}`)

    if (seenItems.has(key)) return
    seenItems.add(key)
    stats.imageCount += 1
    try {
      const image = materializeNativeImageGenerationCall(item, {
        generatedImagesRoot: options.generatedImagesRoot,
        fsModule: options.fsModule,
        index: materialized.length
      })

      if (image) {
        materialized.push(image)
        stats.materializedCount += 1
      }
    } catch {
      stats.failedCount += 1
    }
  }
  const observePayloadImages = async payload => {
    const outputIndex = Number(payload?.output_index)

    if (Number.isInteger(outputIndex) && outputIndex >= 0) maxOutputIndex = Math.max(maxOutputIndex, outputIndex)
    if (['response.output_item.added', 'response.output_item.done'].includes(String(payload?.type || ''))) {
      processImageItem(payload.item, outputIndex)
    }
    if (terminalResponsesEvent(payload?.type)) {
      const output = Array.isArray(payload?.response?.output) ? payload.response.output : []

      for (let index = 0; index < output.length; index += 1) {
        maxOutputIndex = Math.max(maxOutputIndex, index)
        processImageItem(output[index], index)
      }
    }
  }
  const transformSseBlock = async block => {
    const payload = ssePayload(block)

    if (!payload) return `${block}\n\n`
    await observePayloadImages(payload)
    if (!terminalResponsesEvent(payload.type) || !materialized.length || terminalDelivered) {
      return `${block}\n\n`
    }

    terminalDelivered = true
    stats.injected = true
    const markdown = materialized.map(image => image.markdown).join('\n\n')
    const message = imageMessage(markdown)
    const outputIndex = maxOutputIndex + 1
    const events = imageMessageEvents(message, outputIndex).map(encodeSseEvent).join('')

    return `${events}${encodeSseEvent(appendImageMessage(payload, message))}`
  }
  const transform = new TransformStream({
    async transform(chunk, controller) {
      textBuffer += decoder.decode(chunk, { stream: true })
      if (!isSse) return

      for (;;) {
        const boundary = sseBoundary(textBuffer)

        if (!boundary) break
        const block = textBuffer.slice(0, boundary.index)

        textBuffer = textBuffer.slice(boundary.index + boundary.length)
        controller.enqueue(encoder.encode(await transformSseBlock(block)))
      }
    },
    async flush(controller) {
      textBuffer += decoder.decode()
      if (isSse) {
        if (textBuffer)
          controller.enqueue(encoder.encode(await transformSseBlock(textBuffer.replace(/\r?\n\r?\n$/, ''))))
      } else {
        try {
          const payload = JSON.parse(textBuffer || '{}')

          for (let index = 0; index < (Array.isArray(payload.output) ? payload.output.length : 0); index += 1) {
            maxOutputIndex = Math.max(maxOutputIndex, index)
            processImageItem(payload.output[index], index)
          }
          if (materialized.length) {
            const message = imageMessage(materialized.map(image => image.markdown).join('\n\n'))
            const output = Array.isArray(payload.output) ? payload.output : []
            const markdown = String(message.content[0].text || '')

            payload.output = [...output, message]
            payload.output_text = [String(payload.output_text || ''), markdown].filter(Boolean).join('\n\n')
            stats.injected = true
          }
          controller.enqueue(encoder.encode(JSON.stringify(payload)))
        } catch {
          stats.observed = false
          controller.enqueue(encoder.encode(textBuffer))
        }
      }
      finish()
    }
  })

  return {
    delivery: clonedResponse(upstream, upstream.body.pipeThrough(transform)),
    completion
  }
}

module.exports = {
  appendImageMessage,
  imageMessageEvents,
  nativeResponseImageDelivery,
  ssePayload
}
