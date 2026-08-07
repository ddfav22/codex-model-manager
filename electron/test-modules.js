const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { PassThrough, Writable } = require('stream')
const packageMetadata = require('../package.json')

const manager = require('./codexManager')
const {
  PROMPT_TOOL_RECOVERY_MAX_TOKENS,
  UPSTREAM_CAPACITY_MAX_RETRIES,
  adaptResponsesRequest,
  fetchWithCapacityRetry,
  normalizeResponsesToolItemIds,
  responsesRequestToChat,
  runWithAbortTimeout,
  upstreamFailureKind,
  upstreamRejectsNativeTools
} = require('./protocolProxy')
const { RECOVERY_DECISION, parseAgentRecoveryDecision } = require('./protocol/agentRecoveryDecision')
const {
  annotateDiagnostic,
  codexRequestContext,
  diagnosticClassification,
  publicDiagnosticSummary
} = require('./protocol/codexDiagnostics')
const runtimeLogger = require('./runtimeLogger')
const { allowedGithubDownloadHost, safePackageName } = require('./features/packageArchive')
const {
  TASK_RECOVERY_PROMPT,
  normalizeTaskId,
  recoveryFailureCategory,
  redactedTaskId,
  shouldForkAfterFailure,
  startCodexExecRecovery,
  taskRecoveryWorkspaceSnapshot
} = require('./features/taskRecovery')
const { canonicalModelFor, modelIdentityInstruction, normalizeReasoningEffort } = require('./protocol/modelRouting')
const {
  followsImmediateToolResult,
  followsImmediateResponsesToolResult,
  isMalformedToolRecovery,
  looksLikePendingMultiStepAction,
  looksLikeStalledToolContinuation,
  requestLikelyRequiresTool,
  shouldAcceptContinuationRecovery
} = require('./protocol/toolContinuation')
const {
  createUpstreamSignal,
  readResponseBufferLimited,
  readResponseJsonLimited,
  transportFailureKind,
  upstreamAbortKind
} = require('./protocol/upstreamRequest')
const { readChatAssistant } = require('./protocol/chatAssistantStream')
const {
  deterministicToolCallId,
  mergeStreamedToolName,
  normalizeToolArguments,
  rejectedOptionalChatParameter,
  sanitizeChatToolHistory,
  withoutRejectedChatParameter
} = require('./protocol/newApiChatCompatibility')
const {
  DEFAULT_IMAGE_MODEL,
  assertPublicImageHostname,
  downloadImageUrl,
  generateNewApiImage,
  imageGenerationPayload,
  imageToolResult,
  isImageGenerationModel,
  isAllowedMcpOrigin,
  materializeNativeImageGenerationCall,
  materializedImageToolResult,
  nativeImageGenerationBase64,
  preferredImageGenerationModel,
  safeImageUrl,
  upstreamImagesUrl
} = require('./protocol/newApiImageGeneration')
const { nativeResponseImageDelivery, ssePayload } = require('./protocol/nativeResponseImages')
const {
  legacyCleanupCommand,
  legacyScanDecision,
  rememberManagerExecutable,
  rememberManagerExecutableAfterScan,
  stopLegacyManagerInstances
} = require('./runtime/legacyInstanceGuard')
const {
  configurePortableStorage,
  legacyDataMigrationEnabled,
  migratePortableData,
  parseCompleteReleaseVersion,
  portableStoragePaths,
  previousPortableDataRoots
} = require('./runtime/portableStorage')
const { startupCompatibility, windowsDriveType } = require('./runtime/startupCompatibility')
const {
  cacheControlForTarget,
  isPathInsideRoot,
  resolveStaticTarget,
  startStaticUiServer
} = require('./runtime/staticUiServer')
const {
  CLOSE_ACTION,
  actionFromResponse,
  closePromptOptions,
  createWindowCloseHandler
} = require('./runtime/windowClose')
const { sameOrigin } = require('./runtime/windowSecurity')

function rawHttpRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let response = ''

    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
    })
    socket.once('end', () => resolve(response))
    socket.once('connect', () => socket.end(requestText))
  })
}

async function main() {
  const recoveryTaskId = '019fb755-76b9-7603-bfd6-555e987e9f08'

  assert.strictEqual(normalizeTaskId(recoveryTaskId.toUpperCase()), recoveryTaskId)
  assert.strictEqual(redactedTaskId(recoveryTaskId), '019fb755…9f08')
  assert.throws(() => normalizeTaskId('not-a-task'), /任务 ID 格式无效/)
  assert.strictEqual(recoveryFailureCategory('HTTP 401 unauthorized'), 'authentication')
  assert.strictEqual(recoveryFailureCategory('high demand, retry later'), 'capacity')
  assert.strictEqual(recoveryFailureCategory('approval required by sandbox policy'), 'permission')
  assert.strictEqual(recoveryFailureCategory('fetch failed ECONNRESET'), 'network')
  assert.strictEqual(recoveryFailureCategory('rollout history is corrupted'), 'session')
  assert.strictEqual(
    shouldForkAfterFailure({ ok: false, failureCategory: 'session', turnStarted: false, workStarted: false }),
    true
  )
  assert.strictEqual(
    shouldForkAfterFailure({ ok: false, failureCategory: 'session', turnStarted: true, workStarted: false }),
    false
  )
  assert.strictEqual(
    shouldForkAfterFailure({ ok: false, failureCategory: 'authentication', turnStarted: false, workStarted: false }),
    false
  )

  const recoveryWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-recovery-workspace-'))

  try {
    const snapshot = taskRecoveryWorkspaceSnapshot(
      { cwd: recoveryWorkspace, size: 1234, updatedAt: '2026-08-06T00:00:00.000Z' },
      { execFileSync: () => ' M tracked-a.js\nM  tracked-b.js\n' }
    )

    assert.deepStrictEqual(snapshot, {
      cwdExists: true,
      gitRepository: true,
      dirtyEntryCount: 2,
      sessionBytes: 1234,
      sessionUpdatedAt: '2026-08-06T00:00:00.000Z'
    })
  } finally {
    fs.rmSync(recoveryWorkspace, { recursive: true, force: true })
  }

  const fakeRecoverySpawn = ({ events = [], stderr = '', exitCode = 0 }) => {
    let capturedArgs = null
    let capturedPrompt = ''
    const spawnProcess = (_executable, args) => {
      capturedArgs = args
      const child = new EventEmitter()

      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.killed = false
      child.kill = () => {
        child.killed = true
      }
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          capturedPrompt += chunk.toString('utf8')
          callback()
        },
        final(callback) {
          callback()
          setImmediate(() => {
            events.forEach(event => child.stdout.write(`${JSON.stringify(event)}\n`))
            if (stderr) child.stderr.write(stderr)
            child.emit('exit', exitCode, null)
          })
        }
      })

      return child
    }

    return {
      spawnProcess,
      captured: () => ({ args: capturedArgs, prompt: capturedPrompt })
    }
  }
  const successfulRecoverySpawn = fakeRecoverySpawn({
    events: [
      { type: 'thread.started' },
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'turn.completed', turn: { status: 'completed' } }
    ]
  })
  const successfulRecovery = startCodexExecRecovery({
    codexPath: 'codex.exe',
    taskId: recoveryTaskId,
    cwd: process.cwd(),
    spawnProcess: successfulRecoverySpawn.spawnProcess,
    timeoutMs: 1000
  })
  const successfulRecoveryResult = await successfulRecovery.completion
  const successfulRecoveryInput = successfulRecoverySpawn.captured()

  assert.strictEqual(successfulRecoveryResult.ok, true)
  assert.strictEqual(successfulRecoveryResult.turnStarted, true)
  assert.strictEqual(successfulRecoveryResult.workStarted, true)
  assert.deepStrictEqual(successfulRecoveryInput.args, [
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    'resume',
    recoveryTaskId,
    '-'
  ])
  assert.strictEqual(successfulRecoveryInput.prompt, TASK_RECOVERY_PROMPT)
  assert.ok(!successfulRecoveryInput.args.includes(TASK_RECOVERY_PROMPT))

  const failedRecoverySpawn = fakeRecoverySpawn({ stderr: 'rollout history is corrupted', exitCode: 1 })
  const failedRecovery = startCodexExecRecovery({
    codexPath: 'codex.exe',
    taskId: recoveryTaskId,
    cwd: process.cwd(),
    spawnProcess: failedRecoverySpawn.spawnProcess,
    timeoutMs: 1000
  })
  const failedRecoveryResult = await failedRecovery.completion

  assert.strictEqual(failedRecoveryResult.ok, false)
  assert.strictEqual(failedRecoveryResult.failureCategory, 'session')
  assert.strictEqual(failedRecoveryResult.turnStarted, false)
  assert.strictEqual(shouldForkAfterFailure(failedRecoveryResult), true)

  const codexContext = codexRequestContext({
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: '019fd600-8202-7ff0-91b7-6eb858a9f684',
        turn_id: '019fd601-1111-7222-8333-444444444444',
        session_id: '019fd602-aaaa-7bbb-8ccc-dddddddddddd',
        user_text: 'must-not-enter-diagnostics'
      })
    }
  })

  assert.deepStrictEqual(codexContext, {
    codexThreadId: '019fd600-8202-7ff0-91b7-6eb858a9f684',
    codexTurnId: '019fd601-1111-7222-8333-444444444444',
    codexSessionId: '019fd602-aaaa-7bbb-8ccc-dddddddddddd'
  })
  assert.doesNotMatch(JSON.stringify(codexContext), /must-not-enter-diagnostics/)
  assert.deepStrictEqual(codexRequestContext({ client_metadata: { 'x-codex-turn-metadata': '{malformed-secret' } }), {
    codexThreadId: '',
    codexTurnId: '',
    codexSessionId: ''
  })
  assert.deepStrictEqual(
    diagnosticClassification({
      emulation: {
        continuationRecovery: { exhausted: true, recoveryCircuitBreaker: 'identical_stalled_responses' }
      }
    }),
    { diagnosticKind: 'agent_loop_repeated_stall', diagnosticSeverity: 'warn' }
  )
  assert.deepStrictEqual(annotateDiagnostic({ outcome: 'upstream_error', upstreamFailureKind: 'upstream_capacity' }), {
    outcome: 'upstream_error',
    upstreamFailureKind: 'upstream_capacity',
    diagnosticKind: 'upstream_capacity',
    diagnosticSeverity: 'warn'
  })
  assert.deepStrictEqual(
    diagnosticClassification({ outcome: 'upstream_error', upstreamFailureKind: 'upstream_timeout' }),
    { diagnosticKind: 'upstream_timeout', diagnosticSeverity: 'warn' }
  )
  assert.deepStrictEqual(diagnosticClassification({ taskTermination: { shouldContinue: true, kind: 'refusal' } }), {
    diagnosticKind: 'task_terminated',
    diagnosticSeverity: 'warn'
  })
  assert.deepStrictEqual(diagnosticClassification({ outcome: 'proxy_error', transportFailureKind: 'network_error' }), {
    diagnosticKind: 'proxy_transport_error',
    diagnosticSeverity: 'warn'
  })
  assert.deepStrictEqual(
    diagnosticClassification({ outcome: 'proxy_error', transportFailureKind: 'proxy_internal_error' }),
    { diagnosticKind: 'proxy_internal_error', diagnosticSeverity: 'error' }
  )
  assert.deepStrictEqual(diagnosticClassification({ outcome: 'client_cancelled' }), {
    diagnosticKind: 'client_cancelled',
    diagnosticSeverity: 'info'
  })
  assert.strictEqual(
    transportFailureKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })),
    'network_error'
  )
  assert.strictEqual(transportFailureKind(new Error('response format invariant failed')), 'proxy_internal_error')
  const abortedRequest = new EventEmitter()
  const abortedResponse = new EventEmitter()

  abortedResponse.writableEnded = false
  const abortedSignal = createUpstreamSignal(abortedRequest, abortedResponse, 60000)

  abortedRequest.emit('aborted')
  assert.strictEqual(abortedSignal.aborted, true)
  assert.strictEqual(upstreamAbortKind(abortedSignal), 'client_request_aborted')
  assert.strictEqual(transportFailureKind(abortedSignal.reason, abortedSignal), 'client_request_aborted')
  assert.deepStrictEqual(
    diagnosticClassification({
      emulation: {
        continuationRecovery: { exhausted: true, recoveryCircuitBreaker: 'consecutive_transport_failures' }
      }
    }),
    { diagnosticKind: 'agent_loop_transport_stalled', diagnosticSeverity: 'warn' }
  )
  const publicDiagnostic = publicDiagnosticSummary({
    capturedAt: '2026-08-06T00:00:00.000Z',
    diagnosticSeverity: 'warn',
    diagnosticKind: 'upstream_capacity',
    channelId: 'test-channel',
    model: 'grok-test',
    codexThreadId: '019fd600-8202-7ff0-91b7-6eb858a9f684',
    codexTurnId: '019fd601-1111-7222-8333-444444444444',
    upstreamStatus: 503,
    upstreamRetryCount: 2,
    privatePrompt: 'must-not-enter-public-diagnostics'
  })

  assert.strictEqual(publicDiagnostic.kind, 'upstream_capacity')
  assert.strictEqual(publicDiagnostic.upstreamRetryCount, 2)
  assert.doesNotMatch(JSON.stringify(publicDiagnostic), /must-not-enter-public-diagnostics/)
  const transportPublicDiagnostic = publicDiagnosticSummary(
    annotateDiagnostic({
      capturedAt: '2026-08-07T06:21:40.000Z',
      outcome: 'proxy_error',
      transportFailureKind: 'network_error',
      codexThreadId: '019fda1e-e700-79b3-a9c1-2046deca8557'
    })
  )

  assert.match(transportPublicDiagnostic.message, /自动发送“继续”/)
  assert.doesNotMatch(transportPublicDiagnostic.message, /日志/)
  assert.strictEqual(publicDiagnosticSummary({ diagnosticSeverity: 'info' }), null)
  assert.strictEqual(upstreamImagesUrl('https://ainiubi.org'), 'https://ainiubi.org/v1/images/generations')
  assert.strictEqual(upstreamImagesUrl('https://ainiubi.org/v1'), 'https://ainiubi.org/v1/images/generations')
  assert.strictEqual(
    upstreamImagesUrl('https://ainiubi.org/v1/chat/completions?ignored=1'),
    'https://ainiubi.org/v1/images/generations'
  )
  assert.deepStrictEqual(imageGenerationPayload({ prompt: 'sunrise' }), {
    model: DEFAULT_IMAGE_MODEL,
    prompt: 'sunrise',
    n: 1
  })
  assert.deepStrictEqual(imageGenerationPayload({ prompt: 'sunrise' }, { defaultResponseFormat: 'b64_json' }), {
    model: DEFAULT_IMAGE_MODEL,
    prompt: 'sunrise',
    n: 1,
    response_format: 'b64_json'
  })
  assert.strictEqual(DEFAULT_IMAGE_MODEL, 'grok-imagine-image-quality')
  assert.strictEqual(isImageGenerationModel('grok-imagine-image-quality'), true)
  assert.strictEqual(isImageGenerationModel('grok-4.5'), false)
  assert.strictEqual(
    preferredImageGenerationModel(['grok-4.5', 'gpt-image-1', 'grok-imagine-image-quality']),
    'grok-imagine-image-quality'
  )
  assert.deepStrictEqual(
    imageGenerationPayload({
      prompt: 'poster',
      model: 'gpt-image-1',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      output_format: 'JPEG'
    }),
    {
      model: 'gpt-image-1',
      prompt: 'poster',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      output_format: 'jpeg'
    }
  )
  assert.throws(() => imageGenerationPayload({ prompt: '' }), /prompt/)
  assert.throws(() => imageGenerationPayload({ prompt: 'x', n: 5 }), /n/)
  assert.strictEqual(isAllowedMcpOrigin(''), true)
  assert.strictEqual(isAllowedMcpOrigin('http://127.0.0.1:1234'), true)
  assert.strictEqual(isAllowedMcpOrigin('https://evil.example.com'), false)
  const inlinePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0YAAAAASUVORK5CYII='
  const inlineResult = imageToolResult({ created: 123, data: [{ b64_json: inlinePng }] })

  assert.strictEqual(inlineResult.content[0].type, 'image')
  assert.strictEqual(inlineResult.content[0].mimeType, 'image/png')
  assert.strictEqual(inlineResult.structuredContent.images[0].kind, 'inline')
  const urlResult = imageToolResult({ data: [{ url: 'https://cdn.example.com/generated.png' }] })

  assert.strictEqual(urlResult.content[0].type, 'resource_link')
  assert.strictEqual(urlResult.structuredContent.images[0].url, 'https://cdn.example.com/generated.png')
  assert.match(urlResult.content[1].text, /!\[Generated image 1\]\(<https:\/\/cdn\.example\.com\/generated\.png>\)/)
  assert.throws(() => imageToolResult({ data: [{ url: 'file:///private/image.png' }] }), /url.*b64_json/)
  assert.throws(() => imageToolResult({ data: [{ url: 'http://127.0.0.1/private.png' }] }), /url.*b64_json/)
  assert.strictEqual(safeImageUrl('https://127.0.0.1/private.png'), '')
  assert.strictEqual(safeImageUrl('https://[::1]/private.png'), '')
  assert.strictEqual(safeImageUrl('https://[::ffff:127.0.0.1]/private.png'), '')
  await assert.rejects(downloadImageUrl('https://localhost/private.png'), /不安全/)
  await assert.rejects(
    downloadImageUrl('https://cdn.example.com/not-an-image.png', {
      resolveImageHostnameImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImageImpl: async () => new Response('<html>not an image</html>', { status: 200 })
    }),
    /不支持的图片格式/
  )
  await assert.rejects(
    assertPublicImageHostname('https://cdn.example.com/private.png', async () => [{ address: '127.0.0.1', family: 4 }]),
    /私有网络/
  )
  const generatedImagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-generated-images-'))

  try {
    const nativeItem = {
      id: 'ig_module_base64',
      type: 'image_generation_call',
      status: 'completed',
      result: inlinePng
    }
    const nativeMaterialized = materializeNativeImageGenerationCall(nativeItem, { generatedImagesRoot })

    assert.strictEqual(nativeImageGenerationBase64(nativeItem), inlinePng)
    assert.strictEqual(nativeMaterialized.mimeType, 'image/png')
    assert.strictEqual(fs.existsSync(nativeMaterialized.filePath), true)
    assert.match(nativeMaterialized.markdown, /!\[Generated image 1\]\(<.*generated-.*\.png>\)/)
    assert.strictEqual(nativeImageGenerationBase64({ type: 'message', result: inlinePng }), '')
    const nativeSse = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: nativeItem
      },
      {
        type: 'response.completed',
        response: { id: 'resp_module_image', status: 'completed', output: [nativeItem] }
      }
    ]
      .map(payload => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
      .join('')
    const nativeDelivery = nativeResponseImageDelivery(
      new Response(nativeSse, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
      { generatedImagesRoot }
    )
    const nativeDeliveredText = await nativeDelivery.delivery.text()
    const nativeDeliveryStats = await nativeDelivery.completion

    assert.strictEqual(nativeDeliveryStats.imageCount, 1)
    assert.strictEqual(nativeDeliveryStats.materializedCount, 1)
    assert.strictEqual(nativeDeliveryStats.failedCount, 0)
    assert.strictEqual(nativeDeliveryStats.injected, true)
    assert.match(nativeDeliveredText, /response\.output_text\.delta/)
    assert.match(nativeDeliveredText, /!\[Generated image 1\]\(<.*generated-.*\.png>\)/)
    assert.strictEqual(ssePayload('data: [DONE]'), null)
    const invalidNativeSse = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'ig_invalid', type: 'image_generation_call', result: 'not-base64-image' }
      },
      { type: 'response.completed', response: { status: 'completed', output: [] } }
    ]
      .map(payload => `data: ${JSON.stringify(payload)}\n\n`)
      .join('')
    const invalidNativeDelivery = nativeResponseImageDelivery(
      new Response(invalidNativeSse, { headers: { 'content-type': 'text/event-stream' } }),
      { generatedImagesRoot }
    )

    assert.match(await invalidNativeDelivery.delivery.text(), /ig_invalid/)
    assert.deepStrictEqual(await invalidNativeDelivery.completion, {
      observed: true,
      imageCount: 1,
      materializedCount: 0,
      failedCount: 1,
      injected: false
    })
    const materialized = await materializedImageToolResult(
      { created: 124, data: [{ url: 'https://cdn.example.com/generated.png' }] },
      {
        generatedImagesRoot,
        resolveImageHostnameImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImageImpl: async () =>
          new Response(Buffer.from(inlinePng, 'base64'), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
      }
    )

    assert.strictEqual(materialized.content[0].type, 'image')
    assert.strictEqual(materialized.content[0].mimeType, 'image/png')
    assert.strictEqual(materialized.structuredContent.images[0].kind, 'downloaded')
    assert.strictEqual(fs.existsSync(materialized.structuredContent.images[0].filePath), true)
    assert.match(materialized.content[1].text, /!\[Generated image 1\]\(<.*generated-.*\.png>\)/)
    const fallback = await materializedImageToolResult(
      { data: [{ url: 'https://cdn.example.com/generated.png' }] },
      {
        generatedImagesRoot,
        resolveImageHostnameImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImageImpl: async () => new Response('', { status: 503 })
      }
    )

    assert.strictEqual(fallback.content[0].type, 'resource_link')
    assert.strictEqual(fallback.structuredContent.images[0].materialized, false)
    assert.match(fallback.content[1].text, /Embed it in the final response exactly as/)
  } finally {
    fs.rmSync(generatedImagesRoot, { recursive: true, force: true })
  }
  const imageDiagnostics = []
  let observedImageRequest = null
  const generatedImage = await generateNewApiImage(
    { baseUrl: 'https://ainiubi.org/v1', apiKey: 'sk-module-secret' },
    { prompt: 'module prompt', size: '1024x1024' },
    {
      fetchImpl: async (url, request) => {
        observedImageRequest = { url, request, body: JSON.parse(request.body) }

        return new Response(JSON.stringify({ created: 456, data: [{ b64_json: inlinePng }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      onDiagnostic: diagnostic => imageDiagnostics.push(diagnostic)
    }
  )

  assert.strictEqual(observedImageRequest.url, 'https://ainiubi.org/v1/images/generations')
  assert.strictEqual(observedImageRequest.request.headers.authorization, 'Bearer sk-module-secret')
  assert.strictEqual(observedImageRequest.body.prompt, 'module prompt')
  assert.strictEqual(generatedImage.result.content[0].type, 'image')
  assert.strictEqual(imageDiagnostics[0].promptLength, 'module prompt'.length)
  assert.doesNotMatch(JSON.stringify(imageDiagnostics), /module prompt|sk-module-secret/)
  let observedDedicatedImageRequest = null

  await generateNewApiImage(
    {
      baseUrl: 'https://ainiubi.org/v1',
      apiKey: 'sk-chat-secret',
      imageGeneration: {
        baseUrl: 'https://ainiubi.org/v1',
        apiKey: 'sk-image-secret',
        defaultModel: 'grok-imagine-image-quality'
      }
    },
    { prompt: 'dedicated image token' },
    {
      fetchImpl: async (url, request) => {
        observedDedicatedImageRequest = { url, request, body: JSON.parse(request.body) }

        return new Response(JSON.stringify({ data: [{ b64_json: inlinePng }] }), { status: 200 })
      }
    }
  )
  assert.strictEqual(observedDedicatedImageRequest.request.headers.authorization, 'Bearer sk-image-secret')
  assert.strictEqual(observedDedicatedImageRequest.body.model, 'grok-imagine-image-quality')
  await assert.rejects(
    generateNewApiImage(
      { baseUrl: 'https://ainiubi.org/v1', apiKey: 'sk-module-secret' },
      { prompt: 'private prompt' },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid token sk-upstream-secret' } }), { status: 401 })
      }
    ),
    error => /\[redacted\]/.test(error.message) && !/sk-upstream-secret|private prompt/.test(error.message)
  )
  await assert.rejects(
    generateNewApiImage(
      { baseUrl: 'https://ainiubi.org/v1', apiKey: 'sk-module-secret' },
      { prompt: 'permission check' },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                message: 'This token has no access to model grok-imagine-image-quality (request id: private-request-id)'
              }
            }),
            { status: 403 }
          )
      }
    ),
    error =>
      /没有图片模型 grok-imagine-image-quality 的访问权限/.test(error.message) &&
      !/private-request-id/.test(error.message)
  )

  assert.strictEqual(normalizeToolArguments({ command: 'echo ok' }), '{"command":"echo ok"}')
  assert.strictEqual(mergeStreamedToolName('shell_', 'command'), 'shell_command')
  assert.strictEqual(mergeStreamedToolName('shell_command', 'shell_command'), 'shell_command')
  assert.strictEqual(mergeStreamedToolName('shell_', 'shell_command'), 'shell_command')
  assert.strictEqual(
    deterministicToolCallId('shell_command', '{"command":"echo ok"}', 0),
    deterministicToolCallId('shell_command', '{"command":"echo ok"}', 0),
    'missing provider call ids must be stable across retries'
  )

  const strictHistory = sanitizeChatToolHistory([
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', tool_call_id: 'orphan', content: 'orphan result' },
    {
      role: 'assistant',
      content: 'Running checks.',
      tool_calls: [
        {
          id: 'call_duplicate',
          type: 'function',
          function: { name: 'shell_command', arguments: { command: 'echo one' } }
        },
        {
          id: 'call_duplicate',
          type: 'function',
          function: { name: 'shell_command', arguments: '{"command":"echo two"}' }
        },
        { id: 'call_invalid', type: 'function', function: { name: '', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_duplicate', content: 'one' },
    { role: 'tool', tool_call_id: 'call_duplicate', content: 'two' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_incomplete', type: 'function', function: { name: 'shell_command', arguments: '{}' } }]
    },
    { role: 'user', content: 'Continue.' }
  ])
  const strictAssistant = strictHistory.messages.find(message => Array.isArray(message.tool_calls))

  assert.deepStrictEqual(
    strictAssistant.tool_calls.map(call => call.id),
    ['call_duplicate', 'call_duplicate_d2'],
    'duplicate call ids must be deterministically uniquified'
  )
  assert.strictEqual(strictAssistant.tool_calls[0].function.arguments, '{"command":"echo one"}')
  assert.deepStrictEqual(
    strictHistory.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    ['call_duplicate', 'call_duplicate_d2'],
    'tool results must remain paired with rewritten ids'
  )
  assert.strictEqual(strictHistory.diagnostics.droppedEmptyToolCallArrays, 1)
  assert.strictEqual(strictHistory.diagnostics.droppedInvalidToolCalls, 1)
  assert.strictEqual(strictHistory.diagnostics.droppedOrphanToolResults, 1)
  assert.strictEqual(strictHistory.diagnostics.droppedIncompleteToolCalls, 1)
  assert.strictEqual(strictHistory.diagnostics.deduplicatedToolCallIds, 1)

  const missingIdPair = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '', type: 'function', function: { name: 'exec', arguments: { input: 'text(true)' } } }]
    },
    { role: 'tool', tool_call_id: '', content: 'ok' }
  ]
  const firstMissingId = sanitizeChatToolHistory(missingIdPair).messages[0].tool_calls[0].id
  const secondMissingId = sanitizeChatToolHistory(missingIdPair).messages[0].tool_calls[0].id

  assert.ok(firstMissingId.startsWith('call_'))
  assert.strictEqual(firstMissingId, secondMissingId)

  const optionalPayload = {
    stream_options: { include_usage: true },
    parallel_tool_calls: true,
    tools: [{ type: 'function', function: { name: 'exec', strict: true, parameters: { type: 'object' } } }]
  }

  assert.strictEqual(
    rejectedOptionalChatParameter(400, "Unrecognized request argument supplied: 'stream_options'", optionalPayload),
    'stream_options'
  )
  assert.strictEqual(
    rejectedOptionalChatParameter(422, 'Extra inputs are not permitted: parallel_tool_calls', optionalPayload),
    'parallel_tool_calls'
  )
  assert.strictEqual(
    rejectedOptionalChatParameter(400, 'tools[0].function.strict is not supported', optionalPayload),
    'tool_function_strict'
  )
  assert.strictEqual(rejectedOptionalChatParameter(429, 'stream_options unavailable', optionalPayload), '')
  assert.strictEqual(withoutRejectedChatParameter(optionalPayload, 'stream_options').stream_options, undefined)
  assert.strictEqual(
    withoutRejectedChatParameter(optionalPayload, 'tool_function_strict').tools[0].function.strict,
    undefined
  )
  const nonStreamingChat = responsesRequestToChat({
    model: 'grok-4.5',
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'No stream.' }] }]
  })

  assert.strictEqual(nonStreamingChat.request.stream, false)
  assert.strictEqual(
    nonStreamingChat.request.stream_options,
    undefined,
    'non-streaming NewAPI requests must not contain stream_options'
  )
  const projectRoot = path.resolve(__dirname, '..')
  const installerIncludeRelative = String(packageMetadata.build?.nsis?.include || '')
  const installerIncludePath = path.resolve(projectRoot, installerIncludeRelative)
  const installerBuildScript = String(packageMetadata.scripts?.['dist:installer'] || '')
  const windowsBuildScripts = ['dist', 'dist:installer', 'dist:portable', 'pack'].map(name =>
    String(packageMetadata.scripts?.[name] || '')
  )
  const packagedFileRules = packageMetadata.build?.files || []
  const mainProcessSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8')
  const afterPackRelative = String(packageMetadata.build?.afterPack || '')
  const afterPackPath = path.resolve(projectRoot, afterPackRelative)
  const afterPackSource = fs.readFileSync(afterPackPath, 'utf8')
  const rceditPath = path.join(projectRoot, 'tools', 'vendor', 'rcedit-x64.exe')
  const iconPaths = [
    ...new Set([
      packageMetadata.build?.win?.icon,
      packageMetadata.build?.nsis?.installerIcon,
      packageMetadata.build?.nsis?.uninstallerIcon,
      packageMetadata.build?.nsis?.installerHeaderIcon,
      'electron/assets/app.ico',
      'src/app/favicon.ico'
    ])
  ].map(iconPath => path.resolve(projectRoot, String(iconPath || '')))

  assert.ok(installerIncludeRelative, 'NSIS include path must be configured')
  assert.ok(
    installerIncludePath.startsWith(`${projectRoot}${path.sep}`),
    'NSIS include path must stay inside the project'
  )
  assert.strictEqual(
    fs.statSync(installerIncludePath).isFile(),
    true,
    'NSIS include source must be tracked and present'
  )
  assert.match(
    installerBuildScript,
    /--publish\s+never(?:\s|$)/,
    'installer build must not auto-publish before release validation completes'
  )
  assert.strictEqual(
    packageMetadata.build?.win?.signAndEditExecutable,
    false,
    'electron-builder resource editing must stay disabled because its winCodeSign archive requires symlink privileges'
  )
  assert.ok(
    windowsBuildScripts.every(script => !/signAndEditExecutable=false/i.test(script)),
    'Windows build commands must use the centralized resource-editing configuration'
  )
  assert.strictEqual(afterPackRelative, 'tools/after-pack.js', 'the Windows icon hook must stay configured')
  assert.strictEqual(fs.statSync(afterPackPath).isFile(), true, 'the Windows icon hook must exist')
  assert.match(afterPackSource, /--set-icon/, 'the afterPack hook must embed the application icon')
  assert.strictEqual(fs.statSync(rceditPath).isFile(), true, 'the vendored Windows resource editor must exist')
  assert.strictEqual(
    crypto.createHash('sha256').update(fs.readFileSync(rceditPath)).digest('hex').toUpperCase(),
    '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A',
    'the vendored Windows resource editor must match the reviewed binary'
  )
  assert.ok(packagedFileRules.includes('!electron/assets/app.ico'), 'the unused default Electron icon must be excluded')
  assert.ok(
    !packagedFileRules.includes('!electron/assets/app-icon.ico'),
    'the runtime window icon must remain available in the packaged app'
  )
  assert.match(mainProcessSource, /assets['"],\s*['"]app-icon\.ico['"]/, 'the window must use the custom icon')
  assert.strictEqual(
    (mainProcessSource.match(/assets['"],\s*['"]app-icon\.ico['"]/g) || []).length,
    2,
    'the window and tray must use the same multi-size custom icon'
  )
  assert.doesNotMatch(
    mainProcessSource,
    /assets['"],\s*['"]app\.ico['"]/,
    'the tray must not use the removed legacy icon'
  )
  assert.doesNotMatch(
    mainProcessSource,
    /openRuntimeLog|打开运行日志/,
    'the client must not expose the debug log opener'
  )
  assert.doesNotMatch(
    fs.readFileSync(path.join(projectRoot, 'electron', 'preload.js'), 'utf8'),
    /openRuntimeLog/,
    'the debug log opener must not remain exposed through preload'
  )
  const globalStyles = fs.readFileSync(path.join(projectRoot, 'src', 'app', 'globals.css'), 'utf8')

  assert.match(
    globalStyles,
    /@keyframes\s+manager-circular-progress-spin/,
    'busy indicators need an explicit spin animation'
  )
  assert.match(
    globalStyles,
    /\.MuiCircularProgress-root[\s\S]*animation:/,
    'busy indicators must apply the spin animation'
  )
  assert.match(
    mainProcessSource,
    /app\.disableHardwareAcceleration\(\)/,
    'mapped-drive builds must not require a GPU process'
  )
  assert.ok(
    mainProcessSource.indexOf('app.disableHardwareAcceleration()') <
      mainProcessSource.indexOf('configurePortableStorage({'),
    'hardware acceleration must be disabled before Electron runtime initialization'
  )
  assert.match(
    mainProcessSource,
    /app\.commandLine\.appendSwitch\(['"]no-sandbox['"]\)/,
    'network-drive startup must activate the verified Chromium compatibility switch'
  )
  assert.ok(
    mainProcessSource.indexOf("app.commandLine.appendSwitch('no-sandbox')") <
      mainProcessSource.indexOf('configurePortableStorage({'),
    'the network-drive sandbox compatibility switch must be set before Electron runtime initialization'
  )

  const fakeDriveTypeRunner = value => (_command, args, options) => {
    assert.ok(args.includes('-NoProfile'), 'drive detection must not load the user PowerShell profile')
    assert.strictEqual(options.windowsHide, true, 'drive detection must not flash a console window')
    assert.strictEqual(options.timeout, 3000, 'drive detection must have a bounded startup timeout')
    return { status: 0, stdout: `${value}\n` }
  }
  assert.strictEqual(
    windowsDriveType('K:\\Apps\\Manager.exe', { platform: 'win32', runner: fakeDriveTypeRunner(4) }),
    4,
    'Windows network drives must be detected'
  )
  assert.deepStrictEqual(
    startupCompatibility('C:\\Apps\\Manager.exe', { platform: 'win32', runner: fakeDriveTypeRunner(3) }),
    {
      driveType: 3,
      networkDrive: false,
      disableHardwareAcceleration: true,
      disableChromiumSandbox: false
    },
    'local drives must retain the Chromium sandbox'
  )
  assert.strictEqual(
    startupCompatibility('K:\\Apps\\Manager.exe', {
      platform: 'win32',
      runner: fakeDriveTypeRunner(4)
    }).disableChromiumSandbox,
    true,
    'only detected network drives should disable the Chromium sandbox'
  )
  assert.strictEqual(
    startupCompatibility('K:\\Apps\\Manager.exe', {
      platform: 'win32',
      runner: () => ({ status: 1, stdout: '' })
    }).disableChromiumSandbox,
    false,
    'drive detection failures must fail closed and retain the Chromium sandbox'
  )
  assert.strictEqual(packageMetadata.build?.nsis?.oneClick, false, 'installer must use the assisted wizard')
  assert.strictEqual(
    packageMetadata.build?.nsis?.allowToChangeInstallationDirectory,
    true,
    'installer wizard must let the user choose the installation directory'
  )
  for (const iconPath of iconPaths) {
    assert.ok(iconPath.startsWith(`${projectRoot}${path.sep}`), 'application icons must stay inside the project')
    assert.strictEqual(fs.statSync(iconPath).isFile(), true, 'application icon asset must exist')
    assert.ok(fs.statSync(iconPath).size > 1024, 'application icon must contain real multi-size image data')
    const iconBytes = fs.readFileSync(iconPath)

    assert.deepStrictEqual([...iconBytes.subarray(0, 4)], [0, 0, 1, 0], 'application icon must be a valid ICO')
    const iconEntryCount = iconBytes.readUInt16LE(4)

    assert.ok(iconEntryCount >= 6, 'application icon must include the Windows small and large sizes')
    for (let index = 0; index < iconEntryCount; index += 1) {
      const directoryOffset = 6 + index * 16
      const imageOffset = iconBytes.readUInt32LE(directoryOffset + 12)

      assert.strictEqual(
        iconBytes.readUInt32LE(imageOffset),
        40,
        'Windows icon sizes must use broadly compatible DIB frames instead of PNG-only frames'
      )
    }
  }

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-legacy-'))
  const markerPath = path.join(legacyRoot, 'manager-executable.json')
  const currentExecutable = 'C:\\Programs\\ChatGPT-Model-Manager-1.2.32-complete\\ChatGPT Model Manager.exe'
  const previousExecutable = 'C:\\Programs\\ChatGPT-Model-Manager-1.2.31-complete\\ChatGPT Model Manager.exe'

  try {
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    assert.match(legacyCleanupCommand(currentExecutable, 1234), /Get-CimInstance Win32_Process -Filter/)
    assert.match(legacyCleanupCommand(currentExecutable, 1234), /\$currentPid = 1234/)

    fs.writeFileSync(markerPath, JSON.stringify({ version: 1, executablePath: previousExecutable }), 'utf8')
    let scanCalls = 0
    let clock = 100
    const changedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      processId: 1234,
      markerPath,
      platform: 'win32',
      execFileSyncFn(file, args, options) {
        scanCalls += 1
        assert.strictEqual(file, 'powershell.exe')
        assert.deepStrictEqual(args.slice(0, 2), ['-NoProfile', '-Command'])
        assert.strictEqual(options.encoding, 'utf8')
        assert.strictEqual(options.windowsHide, true)
        assert.deepStrictEqual(options.stdio, ['ignore', 'pipe', 'ignore'])
        assert.strictEqual(options.timeout, 10000)

        return '2'
      },
      now: () => {
        clock += 25

        return clock
      }
    })

    assert.deepStrictEqual(changedScan, {
      scan: true,
      reason: 'executable-changed',
      ok: true,
      durationMs: 25,
      stoppedCount: 2
    })
    assert.strictEqual(scanCalls, 1)
    assert.deepStrictEqual(
      rememberManagerExecutable({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { updated: true, reason: 'stored' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable.toUpperCase(),
        markerPath,
        platform: 'win32'
      }),
      { scan: false, reason: 'same-executable' }
    )
    const repeatedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      execFileSyncFn() {
        throw new Error('same-path startup must not launch PowerShell')
      }
    })

    assert.deepStrictEqual(repeatedScan, {
      scan: false,
      reason: 'same-executable',
      ok: true,
      durationMs: 0,
      stoppedCount: 0
    })

    fs.writeFileSync(markerPath, '{broken json', 'utf8')
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: 'C:\\Tools\\electron.exe',
        markerPath,
        platform: 'win32'
      }),
      { scan: false, reason: 'not-packaged-windows-manager' }
    )
    const failedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      execFileSyncFn() {
        const error = new Error('simulated access denied')

        error.code = 'EACCES'
        throw error
      },
      now: (() => {
        let value = 200

        return () => {
          value += 10

          return value
        }
      })()
    })

    assert.deepStrictEqual(failedScan, {
      scan: true,
      reason: 'marker-missing-or-invalid',
      ok: false,
      durationMs: 10,
      stoppedCount: 0,
      errorCode: 'EACCES'
    })
    assert.deepStrictEqual(
      rememberManagerExecutableAfterScan({
        scanResult: failedScan,
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { updated: false, reason: 'legacy-scan-failed' }
    )
    assert.deepStrictEqual(
      legacyScanDecision({
        executablePath: currentExecutable,
        markerPath,
        platform: 'win32'
      }),
      { scan: true, reason: 'marker-missing-or-invalid' }
    )
    const forcedScan = stopLegacyManagerInstances({
      executablePath: currentExecutable,
      markerPath,
      platform: 'win32',
      force: true,
      execFileSyncFn() {
        return '1'
      },
      now: (() => {
        let value = 300

        return () => {
          value += 5

          return value
        }
      })()
    })

    assert.deepStrictEqual(forcedScan, {
      scan: true,
      reason: 'single-instance-lock-conflict',
      ok: true,
      durationMs: 5,
      stoppedCount: 1
    })
  } finally {
    fs.rmSync(legacyRoot, { recursive: true, force: true })
  }

  const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-portable-'))
  const currentClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.32-complete')
  const previousClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.31-complete')
  const olderClientRoot = path.join(portableRoot, 'ChatGPT-Model-Manager-1.2.30-complete')
  const legacyHome = path.join(portableRoot, 'legacy-home')
  const legacyAppData = path.join(legacyHome, 'AppData', 'Roaming')
  const legacyLocalAppData = path.join(legacyHome, 'AppData', 'Local')
  const legacyElectronUserData = path.join(legacyAppData, 'chatgpt-model-manager')

  try {
    const paths = portableStoragePaths({
      isPackaged: true,
      executablePath: path.join(currentClientRoot, 'ChatGPT Model Manager.exe')
    })

    fs.mkdirSync(path.join(previousClientRoot, 'data', 'manager'), { recursive: true })
    fs.mkdirSync(path.join(olderClientRoot, 'data', 'manager'), { recursive: true })
    fs.mkdirSync(path.join(legacyHome, '.codex', 'codex-model-manager'), { recursive: true })
    fs.mkdirSync(path.join(legacyElectronUserData, 'other-channels', 'grok-oauth'), { recursive: true })
    fs.mkdirSync(path.join(legacyLocalAppData, 'ChatGPT Model Manager', 'logs'), { recursive: true })
    fs.writeFileSync(
      path.join(previousClientRoot, 'data', 'manager', 'channels.json'),
      '{"source":"previous-portable"}'
    )
    fs.writeFileSync(path.join(olderClientRoot, 'data', 'manager', 'channels.json'), '{"source":"older-portable"}')
    fs.writeFileSync(
      path.join(legacyHome, '.codex', 'codex-model-manager', 'channels.json'),
      '{"source":"legacy-manager"}'
    )
    fs.writeFileSync(
      path.join(legacyHome, '.codex', 'codex-model-manager', 'newapi.json'),
      '{"source":"legacy-manager"}'
    )
    fs.writeFileSync(path.join(legacyElectronUserData, 'Preferences'), '{"theme":"portable-test"}')
    fs.writeFileSync(
      path.join(legacyElectronUserData, 'other-channels', 'grok-oauth', 'account.json'),
      '{"id":"portable-test"}'
    )
    fs.writeFileSync(path.join(legacyLocalAppData, 'ChatGPT Model Manager', 'logs', 'legacy.log'), 'legacy-log')

    assert.deepStrictEqual(parseCompleteReleaseVersion('ChatGPT-Model-Manager-1.2.32-complete'), [1, 2, 32])
    assert.strictEqual(parseCompleteReleaseVersion('unrelated-folder'), null)
    assert.deepStrictEqual(previousPortableDataRoots(paths), [
      path.join(previousClientRoot, 'data'),
      path.join(olderClientRoot, 'data')
    ])

    const setPaths = new Map()
    let appLogsPath = ''
    const fakeApp = {
      getPath(name) {
        assert.strictEqual(name, 'userData')
        return legacyElectronUserData
      },
      setPath(name, value) {
        setPaths.set(name, value)
      },
      setAppLogsPath(value) {
        appLogsPath = value
      }
    }
    const configured = configurePortableStorage({
      app: fakeApp,
      isPackaged: true,
      executablePath: path.join(currentClientRoot, 'ChatGPT Model Manager.exe')
    })

    assert.strictEqual(configured.dataRoot, path.join(currentClientRoot, 'data'))
    assert.strictEqual(configured.generatedImages, path.join(currentClientRoot, 'data', 'generated-images'))
    assert.strictEqual(fs.existsSync(configured.generatedImages), true)
    assert.strictEqual(configured.legacyElectronUserData, legacyElectronUserData)
    assert.strictEqual(setPaths.get('userData'), configured.electronUserData)
    assert.strictEqual(setPaths.get('sessionData'), configured.sessionData)
    assert.strictEqual(setPaths.get('crashDumps'), configured.crashDumps)
    assert.strictEqual(appLogsPath, configured.electronLogs)
    assert.strictEqual(legacyDataMigrationEnabled({}), false)
    assert.strictEqual(legacyDataMigrationEnabled({ CODEX_MM_ENABLE_LEGACY_DATA_MIGRATION: '1' }), true)
    assert.strictEqual(
      legacyDataMigrationEnabled({
        CODEX_MM_ENABLE_LEGACY_DATA_MIGRATION: '1',
        CODEX_MM_DISABLE_LEGACY_DATA_MIGRATION: '1'
      }),
      false
    )

    const migrated = migratePortableData(configured, {
      homeDir: legacyHome,
      appDataDir: legacyAppData,
      localAppDataDir: legacyLocalAppData,
      legacyElectronUserData
    })

    assert.strictEqual(migrated.migrated, true)
    assert.strictEqual(migrated.reason, 'migration-complete')
    assert.strictEqual(migrated.errors.length, 0)
    assert.ok(migrated.filesCopied >= 4)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configured.managerState, 'channels.json'), 'utf8')), {
      source: 'previous-portable'
    })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configured.managerState, 'newapi.json'), 'utf8')), {
      source: 'legacy-manager'
    })
    assert.strictEqual(fs.existsSync(path.join(configured.electronUserData, 'Preferences')), true)
    assert.strictEqual(
      fs.existsSync(path.join(configured.electronUserData, 'other-channels', 'grok-oauth', 'account.json')),
      false
    )
    assert.strictEqual(fs.existsSync(path.join(configured.logs, 'legacy.log')), true)
    assert.strictEqual(fs.existsSync(configured.migrationMarker), true)
    assert.deepStrictEqual(migratePortableData(configured), {
      migrated: false,
      reason: 'already-migrated',
      filesCopied: 0,
      bytesCopied: 0,
      skippedLinks: 0,
      errors: []
    })

    const markerFailurePaths = portableStoragePaths({
      isPackaged: true,
      executablePath: path.join(portableRoot, 'marker-failure-client', 'ChatGPT Model Manager.exe')
    })

    fs.mkdirSync(markerFailurePaths.migrationMarker, { recursive: true })
    const markerFailure = migratePortableData(markerFailurePaths, {
      homeDir: path.join(portableRoot, 'empty-home'),
      appDataDir: path.join(portableRoot, 'empty-appdata'),
      localAppDataDir: path.join(portableRoot, 'empty-localappdata')
    })

    assert.strictEqual(markerFailure.reason, 'migration-incomplete')
    assert.strictEqual(markerFailure.errors.length, 1)
    assert.strictEqual(markerFailure.errors[0].kind, 'migration-marker')
    assert.ok(markerFailure.errors[0].code)
  } finally {
    fs.rmSync(portableRoot, { recursive: true, force: true })
  }

  const closeOptions = closePromptOptions()

  assert.deepStrictEqual(closeOptions.buttons, ['最小化到任务栏', '关闭程序', '取消'])
  assert.strictEqual(closeOptions.defaultId, 0)
  assert.strictEqual(closeOptions.cancelId, 2)
  assert.strictEqual(actionFromResponse(0), CLOSE_ACTION.MINIMIZE)
  assert.strictEqual(actionFromResponse(1), CLOSE_ACTION.QUIT)
  assert.strictEqual(actionFromResponse(2), CLOSE_ACTION.CANCEL)
  assert.strictEqual(actionFromResponse(99), CLOSE_ACTION.CANCEL)

  async function runCloseChoice(response) {
    const state = {
      dialogCalls: 0,
      minimized: 0,
      quit: 0,
      quitting: false,
      options: null
    }
    const window = { id: 'main-window' }
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      }
    }
    const handler = createWindowCloseHandler({
      dialog: {
        async showMessageBox(parent, options) {
          assert.strictEqual(parent, window)
          state.dialogCalls += 1
          state.options = options

          return { response }
        }
      },
      getWindow: () => window,
      isQuitting: () => state.quitting,
      onMinimize: () => {
        state.minimized += 1
      },
      onQuit: () => {
        state.quitting = true
        state.quit += 1
      }
    })

    await handler(event)

    return { event, state }
  }

  const minimizeChoice = await runCloseChoice(0)

  assert.strictEqual(minimizeChoice.event.prevented, true)
  assert.strictEqual(minimizeChoice.state.dialogCalls, 1)
  assert.strictEqual(minimizeChoice.state.options.message, '要最小化到任务栏，还是关闭程序？')
  assert.strictEqual(minimizeChoice.state.minimized, 1)
  assert.strictEqual(minimizeChoice.state.quit, 0)

  const quitChoice = await runCloseChoice(1)

  assert.strictEqual(quitChoice.state.minimized, 0)
  assert.strictEqual(quitChoice.state.quit, 1)
  assert.strictEqual(quitChoice.state.quitting, true)

  const cancelChoice = await runCloseChoice(2)

  assert.strictEqual(cancelChoice.state.minimized, 0)
  assert.strictEqual(cancelChoice.state.quit, 0)

  let resolveClosePrompt
  let concurrentDialogCalls = 0
  const concurrentHandler = createWindowCloseHandler({
    dialog: {
      showMessageBox() {
        concurrentDialogCalls += 1

        return new Promise(resolve => {
          resolveClosePrompt = resolve
        })
      }
    },
    getWindow: () => ({}),
    isQuitting: () => false,
    onMinimize: () => {},
    onQuit: () => {}
  })
  const firstConcurrentEvent = { preventDefault() {} }
  const secondConcurrentEvent = { preventDefault() {} }
  const firstClose = concurrentHandler(firstConcurrentEvent)
  const secondClose = concurrentHandler(secondConcurrentEvent)

  assert.strictEqual(concurrentDialogCalls, 1)
  resolveClosePrompt({ response: 2 })
  await Promise.all([firstClose, secondClose])

  let promptFailure = null
  const failureEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  const failureHandler = createWindowCloseHandler({
    dialog: {
      async showMessageBox() {
        throw new Error('simulated close prompt failure')
      }
    },
    getWindow: () => ({}),
    isQuitting: () => false,
    onMinimize: () => {
      throw new Error('must not minimize after prompt failure')
    },
    onQuit: () => {
      throw new Error('must not quit after prompt failure')
    },
    logError: (event, error) => {
      promptFailure = { event, message: error.message }
    }
  })

  await failureHandler(failureEvent)
  assert.strictEqual(failureEvent.prevented, true)
  assert.deepStrictEqual(promptFailure, {
    event: 'window.close.prompt.failed',
    message: 'simulated close prompt failure'
  })

  let quittingDialogCalls = 0
  const quittingEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  const quittingHandler = createWindowCloseHandler({
    dialog: {
      async showMessageBox() {
        quittingDialogCalls += 1

        return { response: 0 }
      }
    },
    getWindow: () => ({}),
    isQuitting: () => true,
    onMinimize: () => {},
    onQuit: () => {}
  })

  await quittingHandler(quittingEvent)
  assert.strictEqual(quittingEvent.prevented, false)
  assert.strictEqual(quittingDialogCalls, 0)

  assert.match(modelIdentityInstruction('grok-4.5'), /selected_upstream_model_id="grok-4\.5"/)
  assert.strictEqual(
    canonicalModelFor({ modelAliases: { 'gpt-native-slot': 'grok-4.5' } }, 'gpt-native-slot'),
    'grok-4.5'
  )
  assert.strictEqual(normalizeReasoningEffort('ultra', ['low', 'high']), 'high')

  const crossModelInput = [
    {
      id: 'fc_53e2893f954b40c8af50100324613d7c',
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_cross_model',
      input: 'text("ok")'
    },
    { type: 'custom_tool_call_output', call_id: 'call_cross_model', output: 'ok' },
    {
      id: 'ctc_1c667409108a493b95f89b8ffefa4079',
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call_native_function',
      arguments: '{"command":"echo ok"}'
    }
  ]
  const normalizedCrossModelInput = normalizeResponsesToolItemIds(crossModelInput)

  assert.strictEqual(normalizedCrossModelInput[0].id, 'ctc_53e2893f954b40c8af50100324613d7c')
  assert.strictEqual(normalizedCrossModelInput[0].call_id, 'call_cross_model')
  assert.strictEqual(normalizedCrossModelInput[1], crossModelInput[1])
  assert.strictEqual(normalizedCrossModelInput[2].id, 'fc_1c667409108a493b95f89b8ffefa4079')
  assert.strictEqual(crossModelInput[0].id, 'fc_53e2893f954b40c8af50100324613d7c')
  assert.deepStrictEqual(
    adaptResponsesRequest({ model: 'gpt-5.6-sol', input: crossModelInput }, {}).input.map(item => item.id || ''),
    ['ctc_53e2893f954b40c8af50100324613d7c', '', 'fc_1c667409108a493b95f89b8ffefa4079']
  )

  assert.strictEqual(followsImmediateToolResult([{ role: 'user' }, { role: 'tool' }]), true)
  assert.strictEqual(followsImmediateToolResult([{ role: 'tool' }, { role: 'user' }]), false)
  assert.strictEqual(followsImmediateToolResult([{ role: 'tool' }, { role: 'system' }]), true)
  assert.strictEqual(
    followsImmediateResponsesToolResult([
      { type: 'custom_tool_call_output', call_id: 'call_image_skill', output: 'skill loaded' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context><cwd>C:\\TestWorkspace</cwd></environment_context>' }
        ]
      }
    ]),
    true
  )
  assert.strictEqual(
    followsImmediateResponsesToolResult([
      { type: 'custom_tool_call_output', call_id: 'call_image_skill', output: 'skill loaded' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Start a different task instead.' }]
      }
    ]),
    false
  )
  assert.strictEqual(isMalformedToolRecovery('<codex_no_tool>'), true)
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: '今日金价' }], new Set(['exec', 'wait'])),
    true
  )
  assert.strictEqual(
    requestLikelyRequiresTool(
      [{ role: 'user', content: 'This is a new task. Inspect it with the shell.' }],
      new Set(['shell_command'])
    ),
    true
  )
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: 'Explain how gold markets work.' }], new Set(['exec'])),
    false
  )
  assert.strictEqual(
    requestLikelyRequiresTool([{ role: 'user', content: '今日金价' }], new Set(['request_user_input'])),
    false
  )
  assert.strictEqual(looksLikeStalledToolContinuation('我先确认有没有 image-gen 工具。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('我先检查是否有可用的 image_gen 技能。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('按照图像生成流程读取相关技能说明。'), true)
  assert.strictEqual(looksLikeStalledToolContinuation('正在加载图像生成能力。'), true)
  const screenshotPlan = '先改用更稳妥的方式：写一个本地脚本，再获取金价、打开记事本并保存到桌面。'

  assert.strictEqual(looksLikePendingMultiStepAction(screenshotPlan), true)
  assert.strictEqual(looksLikeStalledToolContinuation(screenshotPlan), false)
  assert.strictEqual(looksLikeStalledToolContinuation(screenshotPlan, { afterToolResult: true }), true)
  assert.strictEqual(looksLikeStalledToolContinuation('正在准备下一个可执行步骤。', { afterToolResult: true }), true)
  assert.strictEqual(
    looksLikeStalledToolContinuation('文件已经成功写入并保存到桌面。', { afterToolResult: true }),
    false
  )
  assert.strictEqual(
    looksLikeStalledToolContinuation('无法获取金价，请提供可用的数据源。', { afterToolResult: true }),
    false
  )
  assert.strictEqual(
    looksLikeStalledToolContinuation('我确认过了：没有可用的 image-gen 工具，因此无法继续生成。'),
    false
  )
  assert.strictEqual(looksLikeStalledToolContinuation('图片已经生成，见附件。'), false)
  assert.strictEqual(PROMPT_TOOL_RECOVERY_MAX_TOKENS, 4096)
  assert.strictEqual(UPSTREAM_CAPACITY_MAX_RETRIES, 2)
  assert.strictEqual(upstreamFailureKind(503, 'Currently experiencing high demand'), 'upstream_capacity')
  assert.strictEqual(upstreamFailureKind(400, 'context_length_exceeded: too many input tokens'), 'context_too_large')
  assert.strictEqual(upstreamFailureKind(429, 'quota exceeded'), 'upstream_rate_limit')
  assert.strictEqual(upstreamRejectsNativeTools('Currently experiencing high demand'), false)
  assert.strictEqual(upstreamRejectsNativeTools('Tool calls are not supported'), true)
  let capacityAttempts = 0
  const recoveredCapacityResponse = await fetchWithCapacityRetry(async () => {
    capacityAttempts += 1

    if (capacityAttempts < 3) {
      return new Response(JSON.stringify({ error: { message: 'currently experiencing high demand' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '0' }
      })
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })

  assert.strictEqual(recoveredCapacityResponse.ok, true)
  assert.strictEqual(capacityAttempts, 3)
  assert.deepStrictEqual(recoveredCapacityResponse.codexRetryDiagnostic, {
    retryCount: 2,
    retryDelayMs: 0,
    failureKind: ''
  })
  let contextAttempts = 0
  const rejectedContextResponse = await fetchWithCapacityRetry(async () => {
    contextAttempts += 1

    return new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'retry-after': '0' }
    })
  })

  assert.strictEqual(contextAttempts, 1)
  assert.strictEqual(rejectedContextResponse.codexRetryDiagnostic.failureKind, 'context_too_large')
  assert.deepStrictEqual(parseAgentRecoveryDecision('{"decision":"complete","answer":"文件已经保存。"}'), {
    type: RECOVERY_DECISION.COMPLETE,
    content: '文件已经保存。'
  })
  assert.deepStrictEqual(
    parseAgentRecoveryDecision('```json\n{"action":"needs-input","question":"请提供保存路径。"}\n```'),
    { type: RECOVERY_DECISION.NEEDS_INPUT, content: '请提供保存路径。' }
  )
  assert.deepStrictEqual(
    parseAgentRecoveryDecision('{"decision":"tool","name":"exec","arguments":{"input":"text(1)"}}'),
    { type: RECOVERY_DECISION.TOOL, content: '' }
  )
  assert.strictEqual(parseAgentRecoveryDecision('{"decision":"complete","answer":""}'), null)
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledAfterToolResult: true,
      retryContent: '<codex_no_tool>',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledContinuation: true,
      retryContent: '正在加载图像生成能力。',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledAfterToolResult: true,
      stalledContinuation: true,
      retryContent: '下一步将继续执行保存任务。',
      retryToolCall: null
    }),
    false
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      stalledContinuation: true,
      retryContent: '还缺少要编辑的原图，请重新附加图片。',
      retryToolCall: null
    }),
    true
  )
  assert.strictEqual(
    shouldAcceptContinuationRecovery({
      afterToolResult: true,
      explicitUserInputRequired: true,
      stalledContinuation: true,
      retryContent: '保存到哪个目录？',
      retryToolCall: null
    }),
    true
  )

  assert.strictEqual(safePackageName('..'), 'imported')
  assert.strictEqual(safePackageName('my skill'), 'my-skill')
  assert.strictEqual(allowedGithubDownloadHost('github.com'), true)
  assert.strictEqual(allowedGithubDownloadHost('objects.githubusercontent.com', true), true)
  assert.strictEqual(allowedGithubDownloadHost('example.com', true), false)

  assert.strictEqual(sameOrigin('http://127.0.0.1:123/a', 'http://127.0.0.1:123/b'), true)
  assert.strictEqual(sameOrigin('https://example.com', 'http://127.0.0.1:123'), false)

  const limitedJson = await readResponseJsonLimited(new Response(JSON.stringify({ ok: true })), 64)

  assert.deepStrictEqual(limitedJson, { ok: true })
  const chatDeltas = []
  const chatAssistant = await readChatAssistant(
    new Response(
      [
        `data: ${JSON.stringify({
          id: 'chatcmpl-module-stream',
          model: 'grok-module-test',
          choices: [{ index: 0, delta: { content: '第一段' } }]
        })}\n\n`,
        `data: ${JSON.stringify({
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          choices: [{ index: 0, delta: { content: '第二段' } }]
        })}\n\ndata: [DONE]\n\n`
      ].join(''),
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
    ),
    {
      onContentDelta(delta, snapshot) {
        chatDeltas.push([delta, snapshot])
      }
    }
  )

  assert.deepStrictEqual(chatDeltas, [
    ['第一段', '第一段'],
    ['第二段', '第一段第二段']
  ])
  assert.deepStrictEqual(chatAssistant, {
    id: 'chatcmpl-module-stream',
    model: 'grok-module-test',
    content: '第一段第二段',
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  })
  assert.strictEqual(
    (
      await readChatAssistant(new Response(JSON.stringify({ choices: [{ message: { content: 'JSON_OK' } }] })), {
        onContentDelta() {
          throw new Error('simulated disconnected display')
        }
      })
    ).content,
    'JSON_OK'
  )
  await assert.rejects(readResponseBufferLimited(new Response('0123456789'), 5), /上游响应超过/)
  const recoveryTimeoutStartedAt = Date.now()

  await assert.rejects(
    runWithAbortTimeout(
      undefined,
      15,
      signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    ),
    /prompt tool recovery timed out/
  )
  assert.ok(Date.now() - recoveryTimeoutStartedAt < 1000)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-modules-'))
  const outRoot = path.join(tempRoot, 'out')
  const siblingRoot = path.join(tempRoot, 'output')

  fs.mkdirSync(outRoot)
  fs.mkdirSync(siblingRoot)
  const staticChunkPath = path.join(outRoot, '_next', 'static', 'chunks', 'app-test.js')

  fs.mkdirSync(path.dirname(staticChunkPath), { recursive: true })
  fs.writeFileSync(path.join(outRoot, 'index.html'), '<!doctype html><title>module-test</title>')
  fs.writeFileSync(staticChunkPath, 'window.__STATIC_CACHE_TEST__ = true')
  fs.writeFileSync(path.join(siblingRoot, 'secret.txt'), 'must-not-leak')
  assert.strictEqual(isPathInsideRoot(outRoot, path.join(outRoot, 'index.html')), true)
  assert.strictEqual(isPathInsideRoot(outRoot, path.join(siblingRoot, 'secret.txt')), false)
  assert.strictEqual(resolveStaticTarget(outRoot, '/%2e%2e%5coutput%5csecret.txt'), null)
  assert.strictEqual(cacheControlForTarget(outRoot, path.join(outRoot, 'index.html')), 'no-cache')
  assert.strictEqual(cacheControlForTarget(outRoot, staticChunkPath), 'public, max-age=31536000, immutable')

  const staticUi = await startStaticUiServer({ outDir: outRoot })

  try {
    const indexResponse = await fetch(staticUi.url)
    const methodResponse = await fetch(staticUi.url, { method: 'POST' })
    const traversalResponse = await fetch(`${staticUi.url}/%2e%2e%5coutput%5csecret.txt`)
    const staticChunkResponse = await fetch(`${staticUi.url}/_next/static/chunks/app-test.js`)

    assert.strictEqual(indexResponse.status, 200)
    assert.strictEqual(indexResponse.headers.get('cache-control'), 'no-cache')
    assert.strictEqual(staticChunkResponse.status, 200)
    assert.strictEqual(staticChunkResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(indexResponse.headers.get('content-security-policy') || '', /default-src 'self'/)
    assert.strictEqual(methodResponse.status, 405)
    assert.strictEqual(traversalResponse.status, 404)
    assert.doesNotMatch(await traversalResponse.text(), /must-not-leak/)
    const malformedResponse = await rawHttpRequest(
      staticUi.port,
      'GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    )

    assert.match(malformedResponse, /^HTTP\/1\.1 400 /)
    assert.strictEqual((await fetch(staticUi.url)).status, 200)
  } finally {
    await new Promise(resolve => staticUi.server.close(resolve))
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  const previousManagerStateDir = process.env.CODEX_MANAGER_STATE_DIR
  const portableManagerStateDir = path.join(os.tmpdir(), 'portable-manager-state-test')

  process.env.CODEX_MANAGER_STATE_DIR = portableManagerStateDir
  assert.strictEqual(manager.getPaths({ homeDir: os.tmpdir() }).stateDir, portableManagerStateDir)
  if (previousManagerStateDir === undefined) delete process.env.CODEX_MANAGER_STATE_DIR
  else process.env.CODEX_MANAGER_STATE_DIR = previousManagerStateDir
  assert.strictEqual(runtimeLogger.configureRuntimeLogger({ roots: [] }), '')
  assert.strictEqual(runtimeLogger.logEvent('info', 'test.no-appdata-fallback'), false)

  console.log('module boundary tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
