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
const IMAGE_GENERATION_MAX_RETRIES = 1
const IMAGE_GENERATION_MAX_RETRY_DELAY_MS = 5_000
const SUPPORTED_MCP_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const GROK_CLI_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', 'auto'])
const IMAGE_ASPECT_RATIOS = new Set([...GROK_CLI_IMAGE_ASPECT_RATIOS, '9:19.5', '19.5:9', '9:20', '20:9'])
const PREFERRED_IMAGE_MODELS = [
  'grok-imagine-image-quality',
  'grok-imagine-image-2.0',
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

function imageModelLeaf(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()

  return normalized.split(/[/:]/).pop() || normalized
}

function preferredImageGenerationModels(models) {
  const candidates = [
    ...new Set((Array.isArray(models) ? models : []).map(model => String(model || '').trim()))
  ].filter(isImageGenerationModel)
  const ordered = []

  for (const preferred of PREFERRED_IMAGE_MODELS) {
    for (const candidate of candidates) {
      if (imageModelLeaf(candidate) === preferred && !ordered.includes(candidate)) ordered.push(candidate)
    }
  }

  for (const candidate of candidates) {
    if (!ordered.includes(candidate)) ordered.push(candidate)
  }

  return ordered
}

function preferredImageGenerationModel(models) {
  return preferredImageGenerationModels(models)[0] || ''
}

class ImageGenerationUpstreamError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ImageGenerationUpstreamError'
    this.code = 'IMAGE_GENERATION_UPSTREAM'
    this.status = Number(details.status || 0) || 502
    this.upstreamStatus = Number(details.upstreamStatus || details.status || 0) || 0
    this.errorType = String(details.errorType || 'image_generation_upstream_error')
    this.upstreamErrorType = String(details.upstreamErrorType || '')
    this.upstreamCode = String(details.upstreamCode || '')
    this.requestId = String(details.requestId || '')
    this.retryAfterSeconds = Number(details.retryAfterSeconds || 0) || 0
    this.retryAfterProvided = Boolean(details.retryAfterProvided)
    this.retryable = Boolean(details.retryable)
    this.modelAccess = Boolean(details.modelAccess)
  }
}

function imageModelFamily(value) {
  const leaf = imageModelLeaf(value)

  if (leaf === DEFAULT_IMAGE_MODEL) return 'grok-quality'
  if (/^grok-imagine(?:-image)?(?:$|-)/.test(leaf)) return 'grok-imagine'
  if (/^(?:gpt-image|chatgpt-image)(?:$|-)/.test(leaf)) return 'gpt-image'
  if (/^dall-e(?:$|-)/.test(leaf)) return 'dall-e'

  return 'unknown'
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
  const requestedModel = boundedString(argumentsValue.model, 'model', {
    maximum: 128,
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/
  })
  if (requestedModel && options.allowModelOverride === false) {
    throw new ImageGenerationValidationError('generate_image 使用当前渠道已验证的图片模型，不接受 model 覆盖')
  }
  const model = requestedModel || options.defaultModel || DEFAULT_IMAGE_MODEL
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
  const explicitResponseFormat = boundedString(argumentsValue.response_format, 'response_format', {
    maximum: 16,
    pattern: /^(?:url|b64_json)$/
  })
  const defaultResponseFormat = boundedString(options.defaultResponseFormat, 'defaultResponseFormat', {
    maximum: 16,
    pattern: /^(?:url|b64_json)$/
  })
  let responseFormat = explicitResponseFormat || defaultResponseFormat
  const aspectRatio = boundedString(argumentsValue.aspect_ratio, 'aspect_ratio', {
    maximum: 8
  })
  if (aspectRatio && !IMAGE_ASPECT_RATIOS.has(aspectRatio)) {
    throw new ImageGenerationValidationError('aspect_ratio 格式无效')
  }
  const resolution = boundedString(argumentsValue.resolution, 'resolution', {
    maximum: 2,
    pattern: /^(?:1k|2k)$/i
  }).toLowerCase()
  const outputCompressionValue = argumentsValue.output_compression
  let outputCompression = null

  if (outputCompressionValue !== undefined && outputCompressionValue !== null && outputCompressionValue !== '') {
    outputCompression = Number(outputCompressionValue)
    if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
      throw new ImageGenerationValidationError('output_compression 必须是 0 到 100 之间的整数')
    }
  }
  const requestedCount = Number(argumentsValue.n ?? options.defaultCount ?? 1)

  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 4) {
    throw new ImageGenerationValidationError('n 必须是 1 到 4 之间的整数')
  }
  const modelFamily = imageModelFamily(model)
  const grokCliImage = modelFamily === 'grok-quality'
  const grokImagineImage = modelFamily === 'grok-imagine'
  const grokImagine2 = /^grok-imagine-image-2\.0(?:$|-)/.test(imageModelLeaf(model))
  const gptImage = modelFamily === 'gpt-image'
  const dallEImage = modelFamily === 'dall-e'
  const normalizedOutputFormat = outputFormat.toLowerCase() === 'jpg' ? 'jpeg' : outputFormat.toLowerCase()

  if (grokCliImage) {
    if (requestedCount !== 1) {
      throw new ImageGenerationValidationError(`${DEFAULT_IMAGE_MODEL} 当前只支持 n=1`)
    }
    if (resolution && resolution !== '1k') {
      throw new ImageGenerationValidationError(`${DEFAULT_IMAGE_MODEL} 当前只支持 resolution=1k`)
    }
    if (responseFormat && responseFormat !== 'b64_json') {
      throw new ImageGenerationValidationError(`${DEFAULT_IMAGE_MODEL} 当前只支持 response_format=b64_json`)
    }
    if (aspectRatio && !GROK_CLI_IMAGE_ASPECT_RATIOS.has(aspectRatio)) {
      throw new ImageGenerationValidationError(`${DEFAULT_IMAGE_MODEL} 不支持 aspect_ratio=${aspectRatio}`)
    }
    const unsupported = [
      size ? 'size' : '',
      quality ? 'quality' : '',
      style ? 'style' : '',
      outputFormat ? 'output_format' : '',
      outputCompression !== null ? 'output_compression' : ''
    ].filter(Boolean)

    if (unsupported.length) {
      throw new ImageGenerationValidationError(
        `${DEFAULT_IMAGE_MODEL} 不使用 ${unsupported.join('、')}；请改用 aspect_ratio 和 resolution`
      )
    }
  } else if (grokImagineImage) {
    const unsupported = [
      size ? 'size' : '',
      style ? 'style' : '',
      outputFormat ? 'output_format' : '',
      outputCompression !== null ? 'output_compression' : ''
    ].filter(Boolean)

    if (unsupported.length) {
      throw new ImageGenerationValidationError(
        `${model} 不使用 ${unsupported.join('、')}；请改用 aspect_ratio、resolution、quality 和 response_format`
      )
    }
    if (quality && !grokImagine2) {
      throw new ImageGenerationValidationError(`${model} 不使用 quality；仅 grok-imagine-image-2.0 支持 low 或 medium`)
    }
    if (quality && !/^(?:low|medium)$/i.test(quality)) {
      throw new ImageGenerationValidationError(`${model} 的 quality 只支持 low 或 medium`)
    }
  } else if (gptImage) {
    const unsupported = [
      aspectRatio ? 'aspect_ratio' : '',
      resolution ? 'resolution' : '',
      explicitResponseFormat ? 'response_format' : '',
      style ? 'style' : ''
    ].filter(Boolean)

    if (unsupported.length) {
      throw new ImageGenerationValidationError(
        `${model} 不使用 ${unsupported.join('、')}；请改用 size、quality、output_format 和 output_compression`
      )
    }
    if (outputCompression !== null && !['jpeg', 'webp'].includes(normalizedOutputFormat)) {
      throw new ImageGenerationValidationError('output_compression 只可与 output_format=jpeg 或 webp 一起使用')
    }
    responseFormat = ''
  } else if (dallEImage) {
    const unsupported = [
      aspectRatio ? 'aspect_ratio' : '',
      resolution ? 'resolution' : '',
      outputFormat ? 'output_format' : '',
      outputCompression !== null ? 'output_compression' : ''
    ].filter(Boolean)

    if (unsupported.length) {
      throw new ImageGenerationValidationError(`${model} 不使用 ${unsupported.join('、')}`)
    }
  }

  const effectiveResolution = resolution || (grokCliImage ? '1k' : '')
  const effectiveResponseFormat = responseFormat || (grokCliImage ? 'b64_json' : '')

  return {
    model,
    prompt,
    n: requestedCount,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(style ? { style } : {}),
    ...(outputFormat ? { output_format: normalizedOutputFormat } : {}),
    ...(outputCompression !== null ? { output_compression: outputCompression } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
    ...(effectiveResponseFormat ? { response_format: effectiveResponseFormat } : {})
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
  let encoded = String(value || '').trim()
  let declaredMimeType = ''

  if (/^data:/i.test(encoded)) {
    const dataUrl = encoded.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i)

    if (!dataUrl) throw new Error('上游返回了不支持的图片 data URL')
    declaredMimeType = dataUrl[1].toLowerCase()
    encoded = dataUrl[2]
  }
  encoded = encoded.replace(/\s+/g, '')

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
  if (declaredMimeType && declaredMimeType !== mimeType) {
    throw new Error('上游图片 data URL 的 MIME 类型与实际内容不一致')
  }

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

function redactedUpstreamError(text, status, model = '', secrets = []) {
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

  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    const value = String(secret || '').trim()

    if (value) message = message.split(value).join('[redacted]')
  }

  if (/\b(?:has no access|no access|not authorized|permission denied)\b/i.test(message) && /\bmodel\b/i.test(message)) {
    return `当前 NewAPI Token 没有图片模型 ${model || '所选模型'} 的访问权限；请在 NewAPI 控制台为该 Token 开通图片模型后重新同步密钥。`
  }

  return message || `图片生成上游返回 HTTP ${status}`
}

function boundedDiagnosticToken(value, maximum = 160) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .slice(0, maximum)
}

function imageUpstreamError(upstream, responseText, model, secrets) {
  let payload = null

  try {
    payload = JSON.parse(String(responseText || ''))
  } catch {
    payload = null
  }
  const upstreamStatus = Number(upstream?.status || 0) || 0
  const upstreamMessage = String(payload?.error?.message || payload?.message || '')
  const retryable = upstreamStatus === 429 || (upstreamStatus >= 500 && upstreamStatus <= 599)
  const retryAfterHeader = String(upstream?.headers?.get?.('retry-after') || '').trim()
  const retryAfterNumber = Number(retryAfterHeader)
  const retryAfterDate = Date.parse(retryAfterHeader)
  const retryAfterSeconds =
    Number.isFinite(retryAfterNumber) && retryAfterNumber >= 0
      ? retryAfterNumber
      : Number.isFinite(retryAfterDate)
        ? Math.max(0, (retryAfterDate - Date.now()) / 1000)
        : 0
  const upstreamErrorType = boundedDiagnosticToken(payload?.error?.type || payload?.type)
  const upstreamCode = boundedDiagnosticToken(payload?.error?.code || payload?.code)
  const requestId = boundedDiagnosticToken(
    upstream?.headers?.get?.('x-oneapi-request-id') ||
      upstream?.headers?.get?.('x-request-id') ||
      payload?.error?.request_id ||
      payload?.request_id
  )
  const errorType =
    upstreamStatus === 400
      ? 'image_generation_invalid_request'
      : upstreamStatus === 401
        ? 'image_generation_auth_error'
        : upstreamStatus === 403
          ? 'image_generation_permission_error'
          : upstreamStatus === 429
            ? 'image_generation_rate_limit'
            : 'image_generation_upstream_error'

  return new ImageGenerationUpstreamError(redactedUpstreamError(responseText, upstreamStatus, model, secrets), {
    status: upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502,
    upstreamStatus,
    errorType,
    upstreamErrorType,
    upstreamCode,
    requestId,
    retryAfterSeconds,
    retryAfterProvided: Boolean(retryAfterHeader),
    modelAccess: /\b(?:model|access|authoriz|permission|entitlement|available|support)\b/i.test(upstreamMessage),
    retryable
  })
}

function imageCandidateCanFailOver(error) {
  if (!(error instanceof ImageGenerationUpstreamError)) return false
  if (error.upstreamStatus === 401) return true
  if (![400, 403, 404].includes(error.upstreamStatus)) return false

  return error.modelAccess
}

function imageRetryDelayMs(error, retryIndex, options = {}) {
  if (error.retryAfterProvided && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
    return Math.min(IMAGE_GENERATION_MAX_RETRY_DELAY_MS, Math.round(error.retryAfterSeconds * 1000))
  }
  const random = Math.max(0, Math.min(1, Number((options.randomImpl || Math.random)()) || 0))
  const jitter = 0.75 + random * 0.5

  return Math.min(IMAGE_GENERATION_MAX_RETRY_DELAY_MS, Math.round(750 * 2 ** retryIndex * jitter))
}

async function waitForImageRetry(milliseconds, options = {}) {
  if (milliseconds <= 0) return
  if (typeof options.sleepImpl === 'function') {
    await options.sleepImpl(milliseconds, options.signal)
    return
  }
  if (options.signal?.aborted) throw options.signal.reason || new Error('Image generation was cancelled')

  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const onAbort = () => done(options.signal.reason || new Error('Image generation was cancelled'))

    function done(error) {
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    timer.unref?.()
    options.signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function imageGenerationCandidates(channel, argumentsValue, options = {}) {
  const imageRuntime =
    channel?.imageGeneration && typeof channel.imageGeneration === 'object' ? channel.imageGeneration : null

  if (options.requireImageRuntime && !imageRuntime?.defaultModel) {
    throw new ImageGenerationValidationError(
      'No validated image model is available for this channel. Sync the NewAPI keys and model catalog again.'
    )
  }
  const candidates = []
  const add = candidate => {
    const baseUrl = String(candidate?.baseUrl || '').trim()
    const apiKey = String(candidate?.apiKey || '').trim()
    const defaultModel = String(candidate?.defaultModel || '').trim()

    if (!baseUrl || !apiKey || !defaultModel) return
    if (
      candidates.some(item => item.baseUrl === baseUrl && item.apiKey === apiKey && item.defaultModel === defaultModel)
    ) {
      return
    }
    candidates.push({ baseUrl, apiKey, defaultModel })
  }

  for (const candidate of Array.isArray(imageRuntime?.candidates) ? imageRuntime.candidates : []) add(candidate)
  if (imageRuntime) add(imageRuntime)

  const explicitModel = String(argumentsValue?.model || options.defaultModel || '').trim()

  if (explicitModel) {
    const matching = candidates.filter(
      candidate =>
        candidate.defaultModel.toLowerCase() === explicitModel.toLowerCase() ||
        imageModelLeaf(candidate.defaultModel) === imageModelLeaf(explicitModel)
    )

    if (matching.length) return matching
    if (!options.requireImageRuntime) {
      return [{ baseUrl: channel?.baseUrl, apiKey: channel?.apiKey, defaultModel: explicitModel }].filter(
        candidate => candidate.baseUrl && candidate.apiKey
      )
    }
  }

  if (!candidates.length) {
    add({
      baseUrl: channel?.baseUrl,
      apiKey: channel?.apiKey,
      defaultModel: options.defaultModel || DEFAULT_IMAGE_MODEL
    })
  }

  return candidates
}

async function generateNewApiImageSingleCandidate(channel, argumentsValue, options = {}) {
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
    throw imageUpstreamError(upstream, responseText, payload.model, [imageApiKey])
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

  return { payload, responsePayload, result, status: upstream.status }
}

async function generateNewApiImage(channel, argumentsValue, options = {}) {
  const candidates = imageGenerationCandidates(channel, argumentsValue, options)

  if (!candidates.length) throw new Error('Image generation channel or API key is unavailable')
  const startedAt = Date.now()
  let lastError = null

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]
    let payload

    try {
      payload = imageGenerationPayload(argumentsValue, {
        ...options,
        defaultModel: candidate.defaultModel
      })
    } catch (error) {
      if (candidateIndex === 0) throw error
      continue
    }

    for (let retryIndex = 0; retryIndex <= IMAGE_GENERATION_MAX_RETRIES; retryIndex += 1) {
      try {
        const generated = await generateNewApiImageSingleCandidate(
          { baseUrl: candidate.baseUrl, apiKey: candidate.apiKey },
          argumentsValue,
          {
            ...options,
            defaultModel: candidate.defaultModel,
            onDiagnostic: undefined
          }
        )

        options.onDiagnostic?.({
          operation: 'newapi_image_generation',
          outcome: 'success',
          status: generated.status,
          model: generated.payload.model,
          promptLength: generated.payload.prompt.length,
          candidateIndex,
          candidateCount: candidates.length,
          retryCount: retryIndex,
          imageCount: generated.result.structuredContent.images.length,
          responseKinds: generated.result.structuredContent.images.map(image => image.kind),
          durationMs: Date.now() - startedAt
        })

        return generated
      } catch (error) {
        lastError = error
        if (!(error instanceof ImageGenerationUpstreamError)) throw error

        if (error.retryable && retryIndex < IMAGE_GENERATION_MAX_RETRIES) {
          const delayMs = imageRetryDelayMs(error, retryIndex, options)

          options.onDiagnostic?.({
            operation: 'newapi_image_generation',
            outcome: 'retry_scheduled',
            status: error.upstreamStatus,
            errorType: error.upstreamErrorType,
            errorCode: error.upstreamCode,
            requestId: error.requestId,
            model: payload.model,
            promptLength: payload.prompt.length,
            candidateIndex,
            candidateCount: candidates.length,
            retryCount: retryIndex + 1,
            retryDelayMs: delayMs,
            durationMs: Date.now() - startedAt
          })
          await waitForImageRetry(delayMs, options)
          continue
        }

        const failOver = imageCandidateCanFailOver(error) && candidateIndex + 1 < candidates.length

        options.onDiagnostic?.({
          operation: 'newapi_image_generation',
          outcome: failOver ? 'candidate_rejected' : 'upstream_error',
          status: error.upstreamStatus,
          errorType: error.errorType,
          errorCode: error.upstreamCode,
          requestId: error.requestId,
          retryable: error.retryable,
          model: payload.model,
          promptLength: payload.prompt.length,
          candidateIndex,
          candidateCount: candidates.length,
          retryCount: retryIndex,
          durationMs: Date.now() - startedAt
        })
        if (!failOver) throw error
        break
      }
    }
  }

  throw lastError || new Error('No usable image model and NewAPI key combination is available')
}

function imageToolDefinition(options = {}) {
  const defaultModel = String(options.defaultModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL
  const family = imageModelFamily(defaultModel)
  const grokDefault = family === 'grok-quality' || family === 'grok-imagine'
  const qualityDefault = family === 'grok-quality'
  const grokImagine2 = /^grok-imagine-image-2\.0(?:$|-)/.test(imageModelLeaf(defaultModel))
  const properties = {
    prompt: { type: 'string', minLength: 1, maxLength: MAX_IMAGE_PROMPT_LENGTH },
    n: {
      type: 'integer',
      minimum: 1,
      maximum: qualityDefault ? 1 : 4,
      description: qualityDefault
        ? `${defaultModel} currently supports only one image per call.`
        : 'Number of images, limited by the selected NewAPI image model.'
    }
  }

  if (grokDefault) {
    properties.aspect_ratio = {
      type: 'string',
      enum: [...(qualityDefault ? GROK_CLI_IMAGE_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS)],
      description: 'Grok Imagine aspect ratio.'
    }
    properties.resolution = {
      type: 'string',
      enum: qualityDefault ? ['1k'] : ['1k', '2k'],
      description: qualityDefault ? `${defaultModel} currently supports resolution 1k.` : 'Grok Imagine resolution.'
    }
    if (grokImagine2) {
      properties.quality = {
        type: 'string',
        enum: ['low', 'medium'],
        description: 'grok-imagine-image-2.0 generation quality.'
      }
    }
  } else if (family === 'gpt-image') {
    properties.size = { type: 'string', description: 'GPT image size, such as 1024x1024 or auto.' }
    properties.quality = { type: 'string', description: 'GPT image quality.' }
    properties.output_format = {
      type: 'string',
      enum: ['png', 'webp', 'jpeg'],
      description: 'GPT image output format.'
    }
    properties.output_compression = {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'GPT JPEG/WebP compression.'
    }
  } else if (family === 'dall-e') {
    properties.size = { type: 'string', description: 'DALL-E image size.' }
    properties.quality = { type: 'string', description: 'DALL-E image quality.' }
    properties.style = { type: 'string', description: 'DALL-E style.' }
  }

  return {
    name: IMAGE_TOOL_NAME,
    title: 'NewAPI 图片生成',
    description: `Generate an image with the channel-validated ${defaultModel} model through NewAPI POST /v1/images/generations. Use only the parameters present in this schema. The tool returns displayable image data or a renderable image URL.`,
    inputSchema: {
      type: 'object',
      properties,
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
    const defaultModel = String(channel?.imageGeneration?.defaultModel || '').trim()
    jsonRpcResponse(response, id, {
      tools: defaultModel ? [imageToolDefinition({ defaultModel })] : []
    })
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
      allowModelOverride: false,
      requireImageRuntime: true,
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
  imageModelFamily,
  imageToolResult,
  materializeNativeImageGenerationCall,
  materializedImageToolResult,
  nativeImageGenerationBase64,
  ImageGenerationValidationError,
  ImageGenerationUpstreamError,
  isImageGenerationModel,
  isAllowedMcpOrigin,
  preferredImageGenerationModel,
  preferredImageGenerationModels,
  safeImageUrl,
  upstreamImagesUrl
}
