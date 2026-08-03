const { once } = require('events')

const DEFAULT_UPSTREAM_TIMEOUT_MS = 180000
const MAX_UPSTREAM_BUFFER_BYTES = 32 * 1024 * 1024

function createUpstreamSignal(request, response, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController()
  const abort = message => {
    if (!controller.signal.aborted) controller.abort(new Error(message))
  }
  const onRequestAborted = () => {
    abort('Codex 已取消请求')
    cleanup()
  }
  const onResponseClose = () => {
    if (!response.writableEnded) abort('Codex 已关闭响应连接')
    cleanup()
  }
  const timer = setTimeout(() => abort('上游模型请求超时'), timeoutMs)
  const cleanup = () => {
    clearTimeout(timer)
    request.off('aborted', onRequestAborted)
    response.off('close', onResponseClose)
  }

  timer.unref?.()
  request.once('aborted', onRequestAborted)
  response.once('close', onResponseClose)
  response.once('finish', cleanup)

  return controller.signal
}

async function readResponseBufferLimited(response, limit = MAX_UPSTREAM_BUFFER_BYTES) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel('上游响应过大')
      throw new Error(`上游响应超过 ${limit} 字节限制`)
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, size)
}

async function readResponseTextLimited(response, limit = MAX_UPSTREAM_BUFFER_BYTES) {
  return (await readResponseBufferLimited(response, limit)).toString('utf8')
}

async function readResponseJsonLimited(response, limit = MAX_UPSTREAM_BUFFER_BYTES) {
  return JSON.parse((await readResponseTextLimited(response, limit)) || '{}')
}

async function pipeResponseBodyLimited(upstream, response, headers = {}, limit = MAX_UPSTREAM_BUFFER_BYTES) {
  response.writeHead(upstream.status, headers)

  if (!upstream.body) {
    response.end()
    return
  }

  const reader = upstream.body.getReader()
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel('上游响应过大')
      throw new Error(`上游响应超过 ${limit} 字节限制`)
    }
    if (!response.write(Buffer.from(value))) await once(response, 'drain')
  }
  response.end()
}

module.exports = {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_BUFFER_BYTES,
  createUpstreamSignal,
  pipeResponseBodyLimited,
  readResponseBufferLimited,
  readResponseJsonLimited,
  readResponseTextLimited
}
