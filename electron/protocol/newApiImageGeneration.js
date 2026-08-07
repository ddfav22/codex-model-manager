const fs = require('fs')
const dns = require('dns')
const net = require('net')
const path = require('path')
const { randomUUID } = require('crypto')
const { readResponseTextLimited } = require('./upstreamRequest')

const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-quality'
const IMAGE_TOOL_NAME = 'generate_image'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_ERROR_BYTES = 64 * 1024
const MAX_IMAGE_PROMPT_LENGTH = 8000
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000
const SUPPORTED_MCP_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const PREFERRED_IMAGE_MODELS = [
  'grok-imagine-image-quality',
  'grok-imagine-image',
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'dall-e-3'
]

class ImageGenerationValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImageGenerationValidationError'
    this.code = 'IMAGE_GENERATION_VALIDATION'
  }
}

function upstreamImagesUrl(baseUrl) {
  const url = new URL(String(baseUrl || '').trim())
  const segments = url.pathname.split('/').filter(Boolean)
  const versionIndex = segments.findIndex(segment => /^v\d+(?:beta)?$/i.test(segment))

  if (versionIndex >= 0) {
    url.pathname = `/${[...segments.slice(0, versionIndex + 1), 'images', 'generations'].join('/')}`
  } else {
    url.pathname = `/${[...segments, 'v1', 'images', 'generations'].join('/')}`
  }
  url.search = ''
  url.hash = ''

  return url.toString()
}

function isImageGenerationModel(value) {
  const model = String(value || '').trim()

  return Boolean(
    model &&
    (/(?:^|[-_.:/])(?:image|imagine|imagen|flux|sdxl)(?:$|[-_.:/])/i.test(model) ||
      /^dall-e(?:$|-)/i.test(model) ||
      /^gpt-image(?:$|-)/i.test(model))
  )
}

function preferredImageGenerationModel(models) {
  const candidates = [
    ...new Set((Array.isArray(models) ? models : []).map(model => String(model || '').trim()))
  ].filter(isImageGenerationModel)

  for (const preferred of PREFERRED_IMAGE_MODELS) {
    const matched = candidates.find(model => model.toLowerCase() === preferred)

    if (matched) return matched
  }

  return candidates[0] || ''
}

function boundedString(value, field, { maximum, pattern } = {}) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new ImageGenerationValidationError(`${field} 必须是字符串`)

  const normalized = value.trim()

  if (!normalized) throw new ImageGenerationValidationError(`${field} 不能为空`)
  if (maximum && normalized.length > maximum) {
    throw new ImageGenerationValidationError(`${field} 超过 ${maximum} 个字符限制`)
  }
  if (pattern && !pattern.test(normalized)) throw new ImageGenerationValidationError(`${field} 格式无效`)

  return normalized
}

function imageGenerationPayload(argumentsValue = {}, options = {}) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new ImageGenerationValidationError('图片生成参数必须是对象')
  }

  const prompt = boundedString(argumentsValue.prompt, 'prompt', { maximum: MAX_IMAGE_PROMPT_LENGTH })

  if (!prompt) throw new ImageGenerationValidationError('prompt 不能为空')
  const model =
    boundedString(argumentsValue.model, 'model', {
      maximum: 128,
      pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/
    }) ||
    options.defaultModel ||
    DEFAULT_IMAGE_MODEL
  const size = boundedString(argumentsValue.size, 'size', {
    maximum: 32,
    pattern: /^(?:auto|\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}(?:_[a-zA-Z0-9]+)?)$/i
  })
  const quality = boundedString(argumentsValue.quality, 'quality', {
    maximum: 24,
    pattern: /^[a-zA-Z0-9_-]+$/
  })
  const style = boundedString(argumentsValue.style, 'style', {
    maximum: 32,
    pattern: /^[a-zA-Z0-9_-]+$/
  })
  const outputFormat = boundedString(argumentsValue.output_format, 'output_format', {
    maximum: 8,
    pattern: /^(?:png|webp|jpeg|jpg)$/i
  })
  const responseFormat =
    boundedString(argumentsValue.response_format, 'response_format', {
      maximum: 16,
      pattern: /^(?:url|b64_json)$/
    }) ||
    boundedString(options.defaultResponseFormat, 'defaultResponseFormat', {
      maximum: 16,
      pattern: /^(?:url|b64_json)$/
    })
  const requestedCount = Number(argumentsValue.n ?? options.defaultCount ?? 1)

  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 4) {
    throw new ImageGenerationValidationError('n 必须是 1 到 4 之间的整数')
  }

  return {
    model,
    prompt,
    n: requestedCount,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(style ? { style } : {}),
    ...(outputFormat ? { output_format: outputFormat.toLowerCase() } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {})
  }
}

function imageMimeType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }

  return ''
}

function decodeImageBase64(value) {
  const encoded = String(value || '').replace(/\s+/g, '')

  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error('上游返回的 base64 图片为空或过大')
  }
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('上游返回了无效的 base64 图片')
  }

  const buffer = Buffer.from(encoded, 'base64')
  const mimeType = imageMimeType(buffer)

  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('上游返回的图片超过 20 MiB 限制')
  if (!mimeType) throw new Error('上游返回了不支持的图片格式')

  return { data: buffer.toString('base64'), mimeType, bytes: buffer.length }
}

function safeImageUrl(value) {
  if (String(value || '').length > 8192) return ''

  try {
    const url = new URL(String(value || ''))

    if (url.protocol !== 'https:') return ''
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

    if (
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      privateIpAddress(hostname)
    ) {
      return ''
    }

    return url.toString()
  } catch {
    return ''
  }
}

function privateIpAddress(hostname) {
  if (net.isIPv4(hostname)) {
    const octets = hostname.split('.').map(Number)

    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 192 && octets[1] === 0) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51)) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      octets[0] >= 224
    )
  }
  if (net.isIPv6(hostname)) {
    const normalized = hostname.toLowerCase()

    if (normalized.startsWith('::ffff:')) return true

    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('ff')
    )
  }

  return false
}

async function downloadImageUrl(url, options = {}) {
  const safeUrl = safeImageUrl(url)

  if (!safeUrl) throw new Error('上游返回了不安全的图片 URL')
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, IMAGE_DOWNLOAD_TIMEOUT_MS)

  options.signal?.addEventListener?.('abort', abort, { once: true })
  try {
    let currentUrl = safeUrl
    let response = null

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicImageHostname(currentUrl, options.resolveImageHostnameImpl)
      response = await (options.fetchImageImpl || fetch)(currentUrl, {
        method: 'GET',
        headers: { accept: 'image/png,image/jpeg,image/webp' },
        redirect: 'manual',
        signal: controller.signal
      })
      if (![301, 302, 303, 307, 308].includes(response?.status)) break
      if (redirects === 3) throw new Error('图片 URL 重定向次数过多')
      const location = response.headers?.get?.('location')
      const nextUrl = safeImageUrl(location ? new URL(location, currentUrl).toString() : '')

      response.body?.cancel?.().catch?.(() => {})
      if (!nextUrl) throw new Error('图片 URL 重定向到了不安全的地址')
      currentUrl = nextUrl
    }

    if (!response?.ok || !response.body) throw new Error(`图片 URL 下载失败（HTTP ${response?.status || 0}）`)
    const declaredBytes = Number(response.headers?.get?.('content-length') || 0)

    if (declaredBytes > MAX_IMAGE_BYTES) throw new Error('图片 URL 返回内容超过 20 MiB 限制')
    const chunks = []
    let bytes = 0

    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)

      bytes += buffer.length
      if (bytes > MAX_IMAGE_BYTES) throw new Error('图片 URL 返回内容超过 20 MiB 限制')
      chunks.push(buffer)
    }
    const buffer = Buffer.concat(chunks)
    const mimeType = imageMimeType(buffer)

    if (!buffer.length) throw new Error('图片 URL 返回了空内容')
    if (!mimeType) throw new Error('图片 URL 返回了不支持的图片格式')

    return { data: buffer.toString('base64'), mimeType, bytes: buffer.length }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', abort)
  }
}

async function assertPublicImageHostname(urlValue, resolveHostnameImpl = dns.promises.lookup) {
  const hostname = new URL(urlValue).hostname.replace(/^\[|\]$/g, '')

  if (privateIpAddress(hostname)) throw new Error('图片 URL 指向了本地或私有网络地址')
  if (net.isIP(hostname)) return
  const resolved = await resolveHostnameImpl(hostname, { all: true, verbatim: true })
  const addresses = Array.isArray(resolved) ? resolved : [resolved]

  if (!addresses.length || addresses.some(item => !item?.address || privateIpAddress(String(item.address)))) {
    throw new Error('图片 URL 域名解析到了本地或私有网络地址')
  }
}

function persistGeneratedImage(image, generatedImagesRoot, index, fsModule = fs) {
  const root = path.resolve(String(generatedImagesRoot || ''))

  if (!generatedImagesRoot || root === path.parse(root).root) throw new Error('生成图片保存目录无效')
  const extension = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/webp' ? 'webp' : 'jpg'
  const filename = `generated-${Date.now()}-${randomUUID()}-${index + 1}.${extension}`
  const filePath = path.join(root, filename)
  const partialPath = `${filePath}.part`

  fsModule.mkdirSync(root, { recursive: true })
  try {
    fsModule.writeFileSync(partialPath, Buffer.from(image.data, 'base64'), { flag: 'wx' })
    fsModule.renameSync(partialPath, filePath)
  } catch (error) {
    fsModule.rmSync(partialPath, { force: true })
    throw error
  }

  return filePath
}

function localImageMarkdown(filePath, index) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/')

  return `![Generated image ${index + 1}](<${normalizedPath}>)`
}

function nativeImageGenerationBase64(item) {
  if (String(item?.type || '') !== 'image_generation_call') return ''
  if (typeof item?.result === 'string') return item.result
  if (typeof item?.result?.b64_json === 'string') return item.result.b64_json
  if (typeof item?.b64_json === 'string') return item.b64_json

  return ''
}

function materializeNativeImageGenerationCall(item, options = {}) {
  const encoded = nativeImageGenerationBase64(item)

  if (!encoded) return null
  const decoded = decodeImageBase64(encoded)
  const filePath = persistGeneratedImage(
    decoded,
    options.generatedImagesRoot,
    Number(options.index || 0),
    options.fsModule || fs
  )

  return {
    filePath,
    markdown: localImageMarkdown(filePath, Number(options.index || 0)),
    mimeType: decoded.mimeType,
    bytes: decoded.bytes
  }
}

function imageToolResult(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : []

  if (!items.length || items.length > 4) throw new Error('上游图片响应缺少有效的 data 数组')

  const content = []
  const images = []

  for (const item of items) {
    const revisedPrompt = typeof item?.revised_prompt === 'string' ? item.revised_prompt.slice(0, 2000) : ''
    const url = safeImageUrl(item?.url)

    if (url) {
      content.push({
        type: 'resource_link',
        uri: url,
        name: `generated-image-${images.length + 1}`,
        description: 'Image generated by the selected NewAPI channel.'
      })
      content.push({
        type: 'text',
        text: `Image generated successfully. Embed it in the final response exactly as: ![Generated image ${
          images.length + 1
        }](<${url}>)`
      })
      images.push({ kind: 'url', url, ...(revisedPrompt ? { revisedPrompt } : {}) })
      continue
    }
    if (typeof item?.b64_json === 'string') {
      const decoded = decodeImageBase64(item.b64_json)

      content.push({ type: 'image', data: decoded.data, mimeType: decoded.mimeType })
      content.push({ type: 'text', text: `Generated inline ${decoded.mimeType} image (${decoded.bytes} bytes).` })
      images.push({
        kind: 'inline',
        mimeType: decoded.mimeType,
        bytes: decoded.bytes,
        ...(revisedPrompt ? { revisedPrompt } : {})
      })
      continue
    }

    throw new Error('上游图片响应既没有 url，也没有 b64_json')
  }

  return {
    content,
    structuredContent: {
      created: Number(payload?.created || 0) || 0,
      images
    },
    isError: false
  }
}

async function materializedImageToolResult(payload, options = {}) {
  const items = Array.isArray(payload?.data) ? payload.data : []

  if (!items.length || items.length > 4) throw new Error('上游图片响应缺少有效的 data 数组')
  const content = []
  const images = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const revisedPrompt = typeof item?.revised_prompt === 'string' ? item.revised_prompt.slice(0, 2000) : ''
    const url = safeImageUrl(item?.url)
    let decoded = null
    let sourceKind = 'inline'

    if (typeof item?.b64_json === 'string') {
      decoded = decodeImageBase64(item.b64_json)
    } else if (url) {
      sourceKind = 'url'
      try {
        decoded = await downloadImageUrl(url, options)
      } catch {
        content.push({
          type: 'resource_link',
          uri: url,
          name: `generated-image-${index + 1}`,
          description: 'Image generated by the selected NewAPI channel.'
        })
        content.push({
          type: 'text',
          text: `Image generated successfully. Embed it in the final response exactly as: ![Generated image ${
            index + 1
          }](<${url}>)`
        })
        images.push({ kind: 'url', url, materialized: false, ...(revisedPrompt ? { revisedPrompt } : {}) })
        continue
      }
    } else {
      throw new Error('上游图片响应既没有安全 url，也没有 b64_json')
    }

    let filePath = ''

    if (options.generatedImagesRoot) {
      try {
        filePath = persistGeneratedImage(decoded, options.generatedImagesRoot, index, options.fsModule || fs)
      } catch {
        filePath = ''
      }
    }

    content.push({ type: 'image', data: decoded.data, mimeType: decoded.mimeType })
    content.push({
      type: 'text',
      text: filePath
        ? `Image generated and saved locally. Embed it in the final response exactly as: ${localImageMarkdown(
            filePath,
            index
          )}`
        : `Generated inline ${decoded.mimeType} image (${decoded.bytes} bytes).`
    })
    images.push({
      kind: sourceKind === 'url' ? 'downloaded' : 'inline',
      mimeType: decoded.mimeType,
      bytes: decoded.bytes,
      ...(filePath ? { filePath } : {}),
      ...(revisedPrompt ? { revisedPrompt } : {})
    })
  }

  return {
    content,
    structuredContent: {
      created: Number(payload?.created || 0) || 0,
      images
    },
    isError: false
  }
}

function redactedUpstreamError(text, status, model = '') {
  let message = ''

  try {
    const payload = JSON.parse(String(text || ''))

    message = String(payload?.error?.message || payload?.message || '')
  } catch {
    message = ''
  }
  message = message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1000)

  if (/\b(?:has no access|no access|not authorized|permission denied)\b/i.test(message) && /\bmodel\b/i.test(message)) {
    return `当前 NewAPI Token 没有图片模型 ${model || '所选模型'} 的访问权限；请在 NewAPI 控制台为该 Token 开通图片模型后重新同步密钥。`
  }

  return message || `图片生成上游返回 HTTP ${status}`
}

async function generateNewApiImage(channel, argumentsValue, options = {}) {
  if (!channel?.baseUrl || !channel?.apiKey) throw new Error('图片生成渠道或 API Key 不可用')

  const imageRuntime =
    channel.imageGeneration && typeof channel.imageGeneration === 'object' ? channel.imageGeneration : {}
  const imageBaseUrl = imageRuntime.baseUrl || channel.baseUrl
  const imageApiKey = imageRuntime.apiKey || channel.apiKey
  const payload = imageGenerationPayload(argumentsValue, {
    ...options,
    defaultModel: options.defaultModel || imageRuntime.defaultModel || DEFAULT_IMAGE_MODEL
  })
  const startedAt = Date.now()
  let upstream

  try {
    upstream = await (options.fetchImpl || fetch)(upstreamImagesUrl(imageBaseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${imageApiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: options.signal
    })
  } catch (error) {
    options.onDiagnostic?.({
      operation: 'newapi_image_generation',
      outcome: 'transport_error',
      model: payload.model,
      promptLength: payload.prompt.length,
      durationMs: Date.now() - startedAt
    })
    throw error
  }

  const responseText = await readResponseTextLimited(
    upstream,
    upstream.ok ? MAX_IMAGE_RESPONSE_BYTES : MAX_IMAGE_ERROR_BYTES
  )

  if (!upstream.ok) {
    options.onDiagnostic?.({
      operation: 'newapi_image_generation',
      outcome: 'upstream_error',
      status: upstream.status,
      model: payload.model,
      promptLength: payload.prompt.length,
      durationMs: Date.now() - startedAt
    })
    throw new Error(redactedUpstreamError(responseText, upstream.status, payload.model))
  }

  let responsePayload

  try {
    responsePayload = JSON.parse(responseText || '{}')
  } catch {
    throw new Error('图片生成上游返回了非 JSON 响应')
  }

  const result = options.materializeImages
    ? await materializedImageToolResult(responsePayload, options)
    : imageToolResult(responsePayload)

  options.onDiagnostic?.({
    operation: 'newapi_image_generation',
    outcome: 'success',
    status: upstream.status,
    model: payload.model,
    promptLength: payload.prompt.length,
    imageCount: result.structuredContent.images.length,
    responseKinds: result.structuredContent.images.map(image => image.kind),
    durationMs: Date.now() - startedAt
  })

  return { payload, responsePayload, result }
}

function imageToolDefinition() {
  return {
    name: IMAGE_TOOL_NAME,
    title: 'NewAPI 图片生成',
    description:
      'Generate an image through the selected NewAPI channel using POST /v1/images/generations. Use this when the user asks to create or generate an image. The tool returns either displayable image data or a renderable image URL.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: MAX_IMAGE_PROMPT_LENGTH },
        model: {
          type: 'string',
          description: `Image model ID. Defaults to ${DEFAULT_IMAGE_MODEL}; override it when the channel uses another image model.`
        },
        size: { type: 'string', description: 'Optional provider-compatible image size, such as 1024x1024 or auto.' },
        quality: { type: 'string', description: 'Optional provider-compatible quality value.' },
        style: { type: 'string', description: 'Optional provider-compatible style value.' },
        output_format: { type: 'string', enum: ['png', 'webp', 'jpeg'] }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    annotations: {
      title: '通过 NewAPI 生成图片',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }
}

function jsonRpcResponse(response, id, result) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function jsonRpcError(response, id, code, message, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }))
}

function isAllowedMcpOrigin(origin) {
  if (!origin) return true

  try {
    const url = new URL(origin)

    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

async function handleImageMcpRequest(request, response, channel, options = {}) {
  if (!isAllowedMcpOrigin(request.headers.origin)) {
    jsonRpcError(response, null, -32000, 'Origin is not allowed', 403)
    return
  }
  if (request.method === 'GET' || request.method === 'DELETE') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }

  let body

  try {
    body = await options.readJsonBody(request, 128 * 1024)
  } catch (error) {
    jsonRpcError(response, null, -32700, error instanceof Error ? error.message : 'Invalid JSON', 400)
    return
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') {
    jsonRpcError(response, body?.id, -32600, 'Invalid JSON-RPC request', 400)
    return
  }

  const { id, method } = body

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    response.writeHead(202)
    response.end()
    return
  }
  if (method === 'initialize') {
    const requestedVersion = String(body.params?.protocolVersion || '')
    const protocolVersion = SUPPORTED_MCP_PROTOCOLS.has(requestedVersion) ? requestedVersion : '2025-06-18'

    jsonRpcResponse(response, id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'chatgpt-model-manager-newapi-image', version: String(options.serverVersion || '1.0.0') }
    })
    return
  }
  if (method === 'ping') {
    jsonRpcResponse(response, id, {})
    return
  }
  if (method === 'tools/list') {
    jsonRpcResponse(response, id, { tools: [imageToolDefinition()] })
    return
  }
  if (method !== 'tools/call') {
    jsonRpcError(response, id, -32601, `Method not found: ${String(method || '')}`)
    return
  }
  if (body.params?.name !== IMAGE_TOOL_NAME) {
    jsonRpcError(response, id, -32602, `Unknown tool: ${String(body.params?.name || '')}`)
    return
  }

  let releaseImageCall = null

  try {
    releaseImageCall = options.acquireImageCall?.() || null
    if (options.acquireImageCall && !releaseImageCall) throw new Error('当前渠道已有图片生成任务，请等待它完成后重试')
    const generated = await generateNewApiImage(channel, body.params?.arguments || {}, {
      ...options,
      defaultResponseFormat: 'b64_json',
      materializeImages: true
    })

    jsonRpcResponse(response, id, generated.result)
  } catch (error) {
    jsonRpcResponse(response, id, {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true
    })
  } finally {
    releaseImageCall?.()
  }
}

module.exports = {
  DEFAULT_IMAGE_MODEL,
  IMAGE_TOOL_NAME,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_LENGTH,
  downloadImageUrl,
  assertPublicImageHostname,
  generateNewApiImage,
  handleImageMcpRequest,
  imageGenerationPayload,
  imageToolDefinition,
  imageToolResult,
  materializeNativeImageGenerationCall,
  materializedImageToolResult,
  nativeImageGenerationBase64,
  ImageGenerationValidationError,
  isImageGenerationModel,
  isAllowedMcpOrigin,
  preferredImageGenerationModel,
  safeImageUrl,
  upstreamImagesUrl
}
