const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const manager = require('./codexManager')
const {
  createProtocolProxy,
  endpointCompatibilityFailure,
  inferredWireApiForModel,
  PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS,
  PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES,
  PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES,
  PROMPT_TOOL_RECOVERY_MAX_TOKENS,
  PROMPT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS,
  responsesRequestToChat,
  wireApiForModel
} = require('./protocolProxy')

function findCodexExecutable(root) {
  if (!fs.existsSync(root)) return ''

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)

    if (entry.isDirectory()) {
      const nested = findCodexExecutable(target)

      if (nested) return nested
    } else if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') {
      return target
    }
  }

  return ''
}

function resolveTestCodexExecutable() {
  const explicitPath = String(process.env.CODEX_MM_TEST_CODEX_PATH || '').trim()
  const packagePath = path.join(
    __dirname,
    '..',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe'
  )
  const desktopPath = findCodexExecutable(path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'))

  return [explicitPath, packagePath, desktopPath].find(candidate => candidate && fs.existsSync(candidate)) || ''
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.unref()
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
  })
}

function withTimeout(promise, milliseconds, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function removeTemporaryPaths(paths, timeoutMs = 15000) {
  const targets = paths.filter(Boolean)
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    lastError = null

    for (const target of targets) {
      if (!fs.existsSync(target)) continue

      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 })
      } catch (error) {
        lastError = error
      }
    }

    if (targets.every(target => !fs.existsSync(target))) return

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  const residuals = targets.filter(target => fs.existsSync(target))

  throw new Error(`wire 测试临时文件未清理：${residuals.join(', ')}${lastError ? `；${lastError.message}` : ''}`)
}

function writeHistorySwitchFixture(codexHome, projectPath) {
  const id = '019fa2ff-2222-7333-8444-555555555555'
  const turnId = '019fa2ff-2222-7333-8444-555555555556'
  const timestamp = '2026-07-28T03:00:00.000Z'
  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '28')
  const userMessage = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'History remains visible after switching providers.' }]
  }
  const rows = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd: projectPath,
        originator: 'Codex Desktop',
        cli_version: '0.131.0-alpha.9',
        source: 'vscode',
        thread_source: 'user',
        model_provider: 'openai',
        base_instructions: { text: 'Test fixture.' },
        dynamic_tools: []
      }
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        started_at: 1779153880,
        model_context_window: 258400,
        collaboration_mode_kind: 'default'
      }
    },
    {
      timestamp,
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Test instructions.' }] }
    },
    { timestamp, type: 'response_item', payload: userMessage },
    {
      timestamp,
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd: projectPath,
        current_date: '2026-07-28',
        timezone: 'Asia/Shanghai',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
        model: 'grok-4.5',
        personality: 'default',
        collaboration_mode: {
          mode: 'default',
          settings: { model: 'grok-4.5', reasoning_effort: 'medium', developer_instructions: 'Test.' }
        },
        realtime_active: false,
        effort: 'medium',
        summary: 'auto',
        developer_instructions: 'Test.',
        truncation_policy: { mode: 'tokens', limit: 10000 }
      }
    },
    { timestamp, type: 'response_item', payload: userMessage },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'History remains visible after switching providers.',
        images: [],
        local_images: [],
        text_elements: []
      }
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 0, window_minutes: 300, resets_at: 1779171614 },
          secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1779675898 },
          credits: null,
          plan_type: 'pro',
          rate_limit_reached_type: null
        }
      }
    }
  ]

  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, `rollout-2026-07-28T03-00-00-${id}.jsonl`),
    `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  )

  return id
}

function writeHistoryProviderConfig(configPath, model, proxyBaseUrl, modelCatalogPath) {
  fs.writeFileSync(
    configPath,
    [
      `model = ${JSON.stringify(model)}`,
      'model_provider = "openai"',
      `openai_base_url = ${JSON.stringify(`${proxyBaseUrl}/v1/test-channel`)}`,
      `model_catalog_json = ${JSON.stringify(modelCatalogPath)}`,
      ''
    ].join('\n'),
    'utf8'
  )
}

async function main() {
  assert.strictEqual(PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS, 60000)
  assert.strictEqual(PROMPT_TOOL_RECOVERY_TOTAL_TIMEOUT_MS, 0)
  let phase = 'discover-codex'
  const watchdog = setTimeout(() => {
    console.error(`wire test watchdog timeout at phase: ${phase}`)
    process.exit(2)
  }, 240000)
  watchdog.unref()
  const mark = value => {
    phase = value
    if (process.env.CODEX_MM_WIRE_TRACE === '1') {
      const line = `wire test phase: ${phase}`

      console.error(line)
      if (process.env.CODEX_MM_WIRE_TRACE_FILE) {
        fs.appendFileSync(process.env.CODEX_MM_WIRE_TRACE_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
      }
    }
  }
  const codexPath = resolveTestCodexExecutable()
  const modelCatalogPath = path.join(os.tmpdir(), 'codex-mm-wire-model-catalog.json')
  const wireCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-wire-home-'))

  if (!codexPath) throw new Error('没有找到 wire 测试所需的 Codex CLI，请执行 npm ci 后重试')

  const wireOptions = {
    codexHome: wireCodexHome,
    stateDir: path.join(wireCodexHome, 'codex-model-manager'),
    codexCliPath: codexPath
  }
  mark('capture-model-catalog')
  const nativeCatalogPath = manager._internal.captureBundledModelCatalog(manager.getPaths(wireOptions), wireOptions)

  assert.ok(nativeCatalogPath)
  const discoveredModels = [
    'gpt-5.6-sol',
    'gpt-5.5',
    'grok-4.5',
    'claude-sonnet-5',
    'gemini-3.5-flash',
    'deepseek-r1',
    'provider-specific-model',
    'gpt-newapi-chat-only',
    'vendor-responses-only'
  ]

  const catalogResult = manager._internal.writeChannelModelCatalog(modelCatalogPath, discoveredModels, [
    nativeCatalogPath
  ])
  const expectedCanonicalModels = ['gpt-5.6-sol', 'gpt-5.5', 'grok-4.5', 'gpt-newapi-chat-only']
  const expectedPickerModels = Object.keys(catalogResult.aliases)
  const aliasFor = model => catalogResult.reverse[model]
  const generatedCatalog = JSON.parse(fs.readFileSync(modelCatalogPath, 'utf8')).models
  const generatedModel = generatedCatalog.find(
    model => model.manager_actual_model === 'grok-4.5' && model.visibility === 'list'
  )

  assert.ok(String(generatedModel.base_instructions || '').length >= 1000)
  assert.strictEqual(generatedModel.shell_type, 'shell_command')
  assert.ok(String(generatedModel.tool_mode || '').startsWith('code_mode'))
  assert.strictEqual(generatedModel.use_responses_lite, false)
  assert.deepStrictEqual(catalogResult.models, expectedCanonicalModels)
  assert.ok(
    catalogResult.unavailable.some(item => item.model === 'provider-specific-model' && /适配未完成/.test(item.reason))
  )
  fs.writeFileSync(
    path.join(wireCodexHome, 'config.toml'),
    [
      `model = ${JSON.stringify(aliasFor('grok-4.5'))}`,
      'model_provider = "openai"',
      `model_catalog_json = ${JSON.stringify(modelCatalogPath)}`,
      ''
    ].join('\n'),
    'utf8'
  )
  mark('model-list')
  const pickerModelResponse = await manager._internal.runCodexAppServerRequest(
    codexPath,
    'model/list',
    { limit: 100, includeHidden: false },
    { env: { ...process.env, CODEX_HOME: wireCodexHome }, timeoutMs: 60000 }
  )
  const pickerModels = (pickerModelResponse.result?.data || pickerModelResponse.result?.models || []).map(item =>
    String(item?.model || item?.slug || item?.id || '')
  )

  assert.deepStrictEqual(
    expectedPickerModels.filter(model => pickerModels.includes(model)),
    expectedPickerModels,
    `Codex model/list 未返回完整别名模型：${pickerModels.join(', ')}`
  )
  mark('protocol-conversion-tests')
  assert.strictEqual(inferredWireApiForModel('gpt-provider-model'), 'responses')
  assert.strictEqual(inferredWireApiForModel('GROK-provider-model'), 'chat')
  assert.strictEqual(inferredWireApiForModel('provider-specific-model'), '')
  assert.strictEqual(wireApiForModel({ wireApi: 'chat' }, 'gpt-provider-model'), 'responses')
  assert.strictEqual(
    wireApiForModel({ wireApi: 'chat', runtimeModelWireApis: { 'gpt-provider-model': 'chat' } }, 'gpt-provider-model'),
    'chat'
  )
  assert.strictEqual(endpointCompatibilityFailure(404, '{"error":{"message":"not found"}}'), true)
  assert.strictEqual(
    endpointCompatibilityFailure(400, '{"error":{"message":"Responses endpoint is not supported"}}'),
    true
  )
  assert.strictEqual(endpointCompatibilityFailure(429, '{"error":{"message":"rate limited"}}'), false)

  const convertedCustom = responsesRequestToChat({
    model: 'grok-4.5',
    input: [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_exec_history',
        input: 'await tools.shell_command({ command: "pwd" })'
      },
      { type: 'custom_tool_call_output', call_id: 'call_exec_history', output: 'C:\\workspace' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }
    ],
    tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
  })

  assert.ok(convertedCustom.request.tools.some(tool => tool.function?.name === 'exec'))
  assert.ok(
    convertedCustom.request.messages.some(
      message =>
        message.role === 'system' &&
        message.content.includes('selected_upstream_model_id="grok-4.5"') &&
        message.content.includes('does not prescribe a canned identity answer') &&
        !message.content.includes('If the user asks which model you are')
    )
  )
  assert.deepStrictEqual(
    convertedCustom.request.tools.find(tool => tool.function?.name === 'exec').function.parameters.required,
    ['input']
  )
  assert.ok(
    convertedCustom.request.messages.some(
      message =>
        message.role === 'assistant' &&
        JSON.parse(message.tool_calls?.[0]?.function?.arguments || '{}').input.includes('shell_command')
    )
  )
  assert.ok(
    convertedCustom.request.messages.some(
      message => message.role === 'tool' && message.tool_call_id === 'call_exec_history'
    )
  )
  const convertedParallelHistory = responsesRequestToChat({
    model: 'grok-4.5',
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will run both checks.' }] },
      { type: 'function_call', name: 'shell_command', call_id: 'call_one', arguments: '{"command":"echo one"}' },
      { type: 'function_call', name: 'shell_command', call_id: 'call_two', arguments: '{"command":"echo two"}' },
      { type: 'function_call_output', call_id: 'call_one', output: 'one' },
      { type: 'function_call_output', call_id: 'call_two', output: 'two' }
    ],
    tools: [
      {
        type: 'function',
        name: 'shell_command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    ]
  })
  const parallelAssistant = convertedParallelHistory.request.messages.find(message => message.role === 'assistant')

  assert.strictEqual(parallelAssistant.role, 'assistant')
  assert.strictEqual(parallelAssistant.content, 'I will run both checks.')
  assert.strictEqual(parallelAssistant.tool_calls.length, 2)
  assert.strictEqual(convertedParallelHistory.request.messages.filter(message => message.role === 'tool').length, 2)
  const convertedNamespace = responsesRequestToChat({
    model: 'grok-4.5',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the plugin.' }] }],
    tools: [
      {
        type: 'namespace',
        name: 'computer_use',
        description: 'Control visible Windows applications.',
        tools: [
          {
            name: 'click',
            description: 'Click a visible target.',
            parameters: {
              type: 'object',
              properties: { target: { type: 'string' } },
              required: ['target']
            }
          }
        ]
      }
    ]
  })

  assert.ok(convertedNamespace.request.tools.some(tool => tool.function?.name === 'computer_use_click'))

  for (const [model, effort] of [
    ['grok-4.5', 'high'],
    ['claude-sonnet-5', 'medium'],
    ['gemini-3.5-flash', 'low']
  ]) {
    const convertedSwitch = responsesRequestToChat({
      model,
      reasoning: { effort },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Model switch test.' }] }]
    })

    assert.strictEqual(convertedSwitch.request.model, model)
    assert.strictEqual(convertedSwitch.request.reasoning_effort, effort)
  }

  const upstreamRequests = []
  let modelsFailure = false
  let stalledRecoveryRequests = 0
  let currentLiveRecoveryRequests = 0
  let completionSignalRecoveryRequests = 0
  let splitCompletionSignalRecoveryRequests = 0
  let exhaustedCompletionSignalRecoveryRequests = 0
  let streamedInternalTranscriptRequests = 0
  let formatFallbackRecoveryRequests = 0
  let highDemandRetryRequests = 0
  let releaseStalledFinalResponse = null
  let markStalledFinalReached
  const stalledFinalReached = new Promise(resolve => {
    markStalledFinalReached = resolve
  })
  let releaseDelayedPlainResponse = null
  let markDelayedPlainReached
  const delayedPlainReached = new Promise(resolve => {
    markDelayedPlainReached = resolve
  })
  let releaseStreamedPlanResponse = null
  let markStreamedPlanReached
  const streamedPlanReached = new Promise(resolve => {
    markStreamedPlanReached = resolve
  })
  const upstream = http.createServer((request, response) => {
    const chunks = []

    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const requestBody = rawBody ? JSON.parse(rawBody) : {}

      upstreamRequests.push({ url: request.url, body: requestBody, authorization: request.headers.authorization || '' })
      if (request.method === 'GET' && request.url === '/v1/models') {
        if (modelsFailure) {
          response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: { message: 'temporary model discovery failure' } }))
          return
        }

        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: discoveredModels.map(id => ({ id, object: 'model', created: 0, owned_by: 'test' }))
          })
        )
        return
      }
      const requestText = JSON.stringify(requestBody)

      if (requestText.includes('CONTEXT CHECKPOINT COMPACTION')) {
        if (requestBody.stream !== true) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: { message: 'stream must true' } }))
          return
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        if (request.url === '/v1/responses') {
          const summaryItem = {
            id: 'msg-compaction-summary',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Preserve the model switch and completed tool results.' }]
          }

          response.write(
            `data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'Preserve the model switch and completed tool results.'
            })}\n\n`
          )
          response.end(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp-compaction-summary',
                object: 'response',
                status: 'completed',
                model: requestBody.model,
                output: [summaryItem]
              }
            })}\n\n`
          )
        } else {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-compaction-summary',
              object: 'chat.completion.chunk',
              model: requestBody.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: 'Preserve the model switch and completed tool results.'
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          response.end(
            `data: ${JSON.stringify({
              id: 'chatcmpl-compaction-summary',
              object: 'chat.completion.chunk',
              model: requestBody.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\ndata: [DONE]\n\n`
          )
        }
        return
      }

      if (requestBody.model === 'gpt-newapi-chat-only' && request.url === '/v1/responses') {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({ error: { message: 'Responses endpoint is not supported for this provider model' } })
        )
        return
      }

      if (requestBody.model === 'vendor-responses-only' && request.url === '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({ error: { message: 'Chat Completions endpoint is not supported for this provider model' } })
        )
        return
      }

      if (requestBody.model === 'grok-high-demand-retry') {
        highDemandRetryRequests += 1
        if (highDemandRetryRequests <= 2) {
          response.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': '0'
          })
          response.end(
            JSON.stringify({ error: { type: 'server_is_overloaded', message: 'currently experiencing high demand' } })
          )
          return
        }
      }

      if (requestBody.model === 'grok-high-demand-exhausted') {
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '0'
        })
        response.end(
          JSON.stringify({ error: { type: 'server_is_overloaded', message: 'currently experiencing high demand' } })
        )
        return
      }

      if (requestBody.model === 'grok-context-too-large') {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '0' })
        response.end(JSON.stringify({ error: { type: 'context_length_exceeded', message: 'too many input tokens' } }))
        return
      }

      if (requestBody.model === 'grok-current-live-data') {
        const recovering = requestBody.messages?.some(message =>
          /requires a verified tool result/i.test(String(message?.content || ''))
        )
        const requestText = JSON.stringify(requestBody)
        if (recovering) currentLiveRecoveryRequests += 1

        if (recovering) {
          assert.ok(requestText.includes('nested web__run tool'))
          assert.deepStrictEqual(requestBody.response_format, { type: 'json_object' })
          assert.strictEqual(requestBody.max_tokens, PROMPT_TOOL_RECOVERY_MAX_TOKENS)
        } else {
          assert.ok(requestText.includes('Current or time-sensitive facts require a tool result.'))
          assert.ok(requestText.includes('tools.web__run'))
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-current-live-data',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: recovering
                    ? currentLiveRecoveryRequests === 1
                      ? '<codex_no_tool>'
                      : '{"name":"exec","arguments":{"input":"const result = await tools.web__run({search_query:[{q:\\"今日金价\\"}],response_length:\\"short\\"}); text(result);"}}'
                    : 'Gold is 9999 from unverified model memory.'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-image-generation') {
        const recovering = requestBody.messages?.some(message =>
          /requires a verified tool result|^The previous answer stopped at a plan-only sentence/i.test(
            String(message?.content || '')
          )
        )
        const requestText = JSON.stringify(requestBody)

        if (recovering) {
          assert.ok(requestText.includes('image_gen__imagegen'))
          assert.ok(requestText.includes('generatedImage'))
          assert.deepStrictEqual(
            requestBody.response_format,
            { type: 'json_object' },
            `image recovery payload: ${JSON.stringify(requestBody)}`
          )
        } else {
          assert.ok(requestText.includes('reading an image skill'))
          assert.ok(requestText.includes('image_gen__imagegen'))
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-image-generation',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: recovering
                    ? '{"name":"exec","arguments":{"input":"const result = await tools.image_gen__imagegen({prompt:\\"一张太阳图片\\"}); generatedImage(result);"}}'
                    : '我先按照图像生成流程读取相关技能说明。'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-delayed-plain-answer') {
        assert.ok(
          !requestBody.messages?.some(message =>
            /requires a verified tool result|strict Codex tool-call compiler/i.test(String(message?.content || ''))
          )
        )
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.flushHeaders()
        releaseDelayedPlainResponse = () => {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-delayed-plain-answer',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'PLAIN_ANSWER_OK' },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          response.end('data: [DONE]\n\n')
        }
        markDelayedPlainReached()
        return
      }

      if (requestBody.model === 'grok-streamed-plan-progress') {
        if (Array.isArray(requestBody.tools) && requestBody.tools.length) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: { message: 'tool calls are not supported by the selected adapter' } }))
          return
        }
        const recovering = requestBody.messages?.some(
          message =>
            message?.role === 'system' &&
            /^The previous answer stopped at a plan-only sentence/i.test(String(message?.content || ''))
        )

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        if (recovering) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-streamed-plan-recovery',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: '{"name":"exec","arguments":{"input":"text(123)"}}' },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          response.end('data: [DONE]\n\n')
          return
        }
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-streamed-plan-progress',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '我先确认有没有 image-gen 工具。' },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        releaseStreamedPlanResponse = () => response.end('data: [DONE]\n\n')
        markStreamedPlanReached()
        return
      }

      if (requestBody.model === 'grok-internal-transcript-echo') {
        assert.ok(!JSON.stringify(requestBody.messages || []).includes('[Codex local tool calls]'))
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-internal-transcript-echo',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '[Codex local tool calls]\n[{"name":"exec","arguments":"{}"}]\nVISIBLE_ONLY'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-escaped-whitespace') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-escaped-whitespace',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '\\n\\n\\n\\n' }, finish_reason: null }]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-html-tool-scaffold') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        const chunks = [
          '<!DOCTYPE html><html><head><script>const tools = globalThis.tools; tools.shell_command({command:"python --version"})</script></head><body></body></html>\n',
          'I will use the correct tool format.\n',
          '<codex_tool_call>{"name":"exec","arguments":{"input":"text(123)"}}</codex_tool_call>'
        ]

        for (const content of chunks) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-html-tool-scaffold',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-encoded-tool-frame') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        const chunks = [
          '0xa0',
          'a1e0ex',
          'ec0xa1in',
          'put0xa2const result = await tools.shell_command({command:"python --version"}); text(result);'
        ]

        for (const content of chunks) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-encoded-tool-frame',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-streamed-internal-transcript') {
        streamedInternalTranscriptRequests += 1
        const recovering = streamedInternalTranscriptRequests > 1
        const chunks = recovering
          ? ['{"decision":"complete","answer":"VISIBLE_ONLY"}']
          : [
              'I will inspect the local frontend and then verify the authentication flow.',
              '\n[Codex local tool calls]\n[\n  {"name":"exec","arguments":{"input":"RAW_POWERSHELL_SHOULD_NOT_RENDER C:\\\\Users\\\\Tester\\\\Desktop\\\\recon.js","nested":["one",{"two":true}]}}\n]'
            ]

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        for (const content of chunks) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-streamed-internal-transcript',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
        return
      }

      if (
        requestBody.model === 'grok-short-continue-anchor' ||
        requestBody.model === 'grok-interrupted-continue-anchor'
      ) {
        const requestText = JSON.stringify(requestBody)

        if (requestBody.model === 'grok-interrupted-continue-anchor') {
          assert.ok(requestText.includes('prior turn was manually interrupted'))
          assert.ok(requestText.includes('Original task: 安装 Python，完成后运行 python --version 验证。'))
          assert.ok(requestText.includes('Completed tool results already preserved in this conversation: 1'))
          assert.ok(!requestText.includes('turn_aborted'))
        } else {
          assert.ok(requestText.includes('Original task: 查询今日金价，并把结果写入桌面文件。'))
          assert.ok(requestText.includes('Latest visible assistant state: 先查询最新金价。'))
          assert.ok(!requestText.includes('上游模型未能完成剩余步骤，请重试本轮任务。'))
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${requestBody.model}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content:
                    requestBody.model === 'grok-interrupted-continue-anchor'
                      ? '继续执行：\n```json\n{"tool_call":{"tool":"exec","input":"const result = await tools.shell_command({command:\\"python --version\\"}); text(result);"}}\n```'
                      : '继续执行：\n```json\n{"tool_call":{"tool":"exec","input":"const result = await tools.web__run({search_query:[{q:\\"今日金价\\"}]}); text(result);"}}\n```'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'gpt-native-responses-test' || requestBody.model === 'gpt-5.6-sol') {
        assert.strictEqual(request.url, '/v1/responses')
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'OK',
            response: { model: requestBody.model }
          })}\n\n`
        )
        response.end(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { model: requestBody.model, output: [] }
          })}\n\n`
        )
        return
      }

      if (
        requestBody.model === 'grok-reject-tools-test' ||
        requestBody.model === 'grok-reject-exec-test' ||
        requestBody.model === 'grok-forced-emulation'
      ) {
        if (Array.isArray(requestBody.tools) && requestBody.tools.length) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(
            JSON.stringify({ error: { message: 'tool calls are not supported by the selected Grok upstream' } })
          )
          return
        }

        assert.ok(requestBody.messages.some(message => String(message.content || '').includes('<codex_tool_call>')))
        const hasLocalToolResult = requestBody.messages.some(message =>
          String(message.content || '').includes('"kind":"tool_result"')
        )
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-emulated-tool-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: hasLocalToolResult
                    ? 'CODEX_CONTINUATION_OK\n[CODEX_AGENT_LOOP_COMPLETE]'
                    : requestBody.model === 'grok-reject-exec-test'
                      ? '{"name":"exec","arguments":{"input":"Start-Process calc.exe"}}'
                      : '{"name":"shell_command","arguments":{"command":"Write-Output emulated-ok"}}'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (
        requestBody.model === 'grok-completion-signal' ||
        requestBody.model === 'grok-completion-signal-exhausted' ||
        requestBody.model === 'grok-completion-signal-user-input'
      ) {
        const recovering = requestBody.messages?.some(message =>
          /omitted the required completion signal|bounded recovery attempt/i.test(String(message?.content || ''))
        )
        let content =
          requestBody.model === 'grok-completion-signal-user-input'
            ? '请提供要保存的完整路径。'
            : '任务已经完成，文件已保存。'

        if (recovering && requestBody.model === 'grok-completion-signal') {
          completionSignalRecoveryRequests += 1
          assert.deepStrictEqual(requestBody.response_format, { type: 'json_object' })
          assert.strictEqual(requestBody.max_tokens, PROMPT_TOOL_RECOVERY_MAX_TOKENS)
          content = '{"decision":"complete","answer":"任务已经完成，文件已保存。"}'
        } else if (recovering) {
          exhaustedCompletionSignalRecoveryRequests += 1
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${requestBody.model}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-split-completion-signal') {
        const recovering = requestBody.messages?.some(message =>
          /recovering a stalled Codex agent turn|bounded recovery attempt/i.test(String(message?.content || ''))
        )
        const chunks = recovering
          ? [
              JSON.stringify({
                decision: 'tool',
                name: 'exec',
                arguments: {
                  input:
                    'const result = await tools.shell_command({command:"Write-Output AUTH_CHECKED"}); text(result);'
                }
              })
            ]
          : ['网络和 SSH 端口都通，接下来用更稳妥的脚本方式排查认证。', '\n[CODEX_AGENT_LOOP_COM', 'PLETE]']

        if (recovering) splitCompletionSignalRecoveryRequests += 1
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        for (const content of chunks) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-split-completion-signal',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-completion-signal-recovery-failure') {
        const recovering = requestBody.messages?.some(message =>
          /omitted the required completion signal|bounded recovery attempt/i.test(String(message?.content || ''))
        )

        if (recovering) {
          response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: { message: 'temporary recovery channel unavailable' } }))
          return
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-completion-signal-recovery-failure',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '下一步我会继续保存文件。' },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-delayed-recovery-over-legacy-timeout') {
        const recovering = requestBody.messages?.some(message =>
          /bounded recovery attempt/i.test(String(message?.content || ''))
        )

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        if (!recovering) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-delayed-recovery-initial',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: '我接下来会运行安装脚本并验证结果。' },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          response.end('data: [DONE]\n\n')
          return
        }

        setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-delayed-recovery-success',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: '{"name":"exec","arguments":{"input":"text(\\"RECOVERED_AFTER_LEGACY_TIMEOUT\\")"}}'
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          response.end('data: [DONE]\n\n')
        }, 16_000)
        return
      }

      if (requestBody.model === 'grok-stalled-continuation') {
        const recovering = requestBody.messages?.some(message =>
          /recovering a stalled Codex agent turn|bounded recovery attempt/i.test(String(message?.content || ''))
        )
        const hasLocalToolResult = requestBody.messages?.some(message =>
          String(message?.content || '').includes('"kind":"tool_result"')
        )
        let content

        if (recovering) {
          stalledRecoveryRequests += 1
          const recoveryInstructions = requestBody.messages
            .filter(message => message.role === 'system')
            .map(message => String(message.content || ''))
            .join('\n')

          assert.ok(recoveryInstructions.includes('plan-only sentence'))
          assert.ok(!recoveryInstructions.includes('omitted the required completion signal'))
          assert.ok(recoveryInstructions.includes('no fixed round limit'))
          assert.deepStrictEqual(requestBody.response_format, { type: 'json_object' })
          assert.strictEqual(requestBody.max_tokens, PROMPT_TOOL_RECOVERY_MAX_TOKENS)
          const pendingPlans = [
            '正在准备下一个可执行步骤。',
            '下一步将继续执行保存任务。',
            '接下来我会执行写入文件。',
            '然后我将打开记事本并保存。'
          ]

          content =
            pendingPlans[stalledRecoveryRequests - 1] ||
            '{"name":"exec","arguments":{"input":"const saved = await tools.shell_command({command:\\"Set-Content -Path gold-price.txt -Value 2026-07-31_gold_2800; Start-Process notepad.exe gold-price.txt\\"}); text(saved);"}}'
          if (stalledRecoveryRequests === 5) {
            content = content.replace('{"name"', '{"decision":"tool","name"')
          }
        } else {
          content = hasLocalToolResult
            ? '我接下来会处理剩余步骤。'
            : '{"name":"exec","arguments":{"input":"const price = await tools.shell_command({command:\\"Write-Output 2800\\"}); text(price);"}}'
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        const sendStalledResponse = () => {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-stalled-continuation',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
          response.end('data: [DONE]\n\n')
        }

        if (recovering && stalledRecoveryRequests === 5) {
          releaseStalledFinalResponse = sendStalledResponse
          markStalledFinalReached()
        } else {
          sendStalledResponse()
        }
        return
      }

      if (requestBody.model === 'grok-repeated-stall-fuse') {
        const recovering = requestBody.messages?.some(message =>
          /bounded recovery attempt/i.test(String(message?.content || ''))
        )
        const content = recovering ? '下一步我会继续执行相同的中间计划。' : '我接下来会处理剩余步骤。'

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-repeated-stall-fuse',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-partial-emulated-tool-tag') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        for (const content of [
          'Ping 已通。SSH 密码登录刚才超时了。我改用 Windows 可用的方式完成登录验证。',
          '\n<codex_tool_cal',
          `l>${JSON.stringify({
            decision: 'tool',
            name: 'exec',
            arguments: {
              input: 'const result = await tools.shell_command({command:"Write-Output CONNECTED"}); text(result);'
            }
          })}`
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-partial-emulated-tool-tag',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-recovery-format-fallback') {
        const recovering = requestBody.messages?.some(message =>
          /bounded recovery attempt/i.test(String(message?.content || ''))
        )

        if (recovering) {
          formatFallbackRecoveryRequests += 1
          if (requestBody.response_format) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ error: { message: 'response_format is not supported by this channel' } }))
            return
          }
        }

        const content = recovering
          ? JSON.stringify({
              decision: 'tool',
              name: 'exec',
              arguments: {
                input:
                  'const result = await tools.shell_command({command:"Write-Output POSH_SSH_READY"}); text(result);'
              }
            })
          : 'Ping 已通，SSH 密码登录刚才超时了。我改用 PowerShell 的 Posh-SSH 做端口探测和登录验证。'

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-recovery-format-fallback',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-historical-tool-new-turn') {
        const recovering = requestBody.messages?.some(message =>
          /strict Codex tool-call compiler|requires a verified tool result|bounded recovery attempt/i.test(
            String(message?.content || '')
          )
        )
        const content = recovering
          ? '{"name":"shell_command","arguments":{"command":"Write-Output NEW_TURN_RECOVERED"}}'
          : 'I need additional context before I can complete the new task.'

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-historical-tool-new-turn',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (requestBody.model === 'grok-identity-self-report') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-identity-self-report',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'UPSTREAM_OWN_IDENTITY_ANSWER'
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      })
      if (requestBody.model === 'grok-custom-proxy-test') {
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-custom-tool-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_custom_exec',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments:
                          '{"input":"await tools.shell_command({ command: \\"curl http://192.0.2.17:3000\\" })"}'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      if (upstreamRequests.length === 1 && Array.isArray(requestBody.tools) && requestBody.tools.length) {
        const declaredTool =
          requestBody.tools?.find(tool => /^(exec|shell_command)$/i.test(String(tool?.function?.name || ''))) ||
          requestBody.tools?.[0]
        const declaredToolName = String(declaredTool?.function?.name || 'shell_command')
        const declaredArguments =
          declaredToolName === 'exec'
            ? '{"input":"text(\\"proxy-tool-ok\\")"}'
            : '{"command":"Write-Output proxy-tool-ok"}'

        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-proxy-tool-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_proxy_test',
                      type: 'function',
                      function: { name: declaredToolName, arguments: declaredArguments }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-proxy-tool-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'grok-4.5',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }

      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-proxy-test',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestBody.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
        })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-proxy-test',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestBody.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    })
  })

  await listen(upstream)
  const upstreamAddress = upstream.address()
  const proxyDiagnostics = []
  const testOnlyModels = [
    'gpt-native-responses-test',
    'grok-custom-proxy-test',
    'grok-reject-tools-test',
    'grok-reject-exec-test',
    'grok-forced-emulation',
    'grok-completion-signal',
    'grok-split-completion-signal',
    'grok-completion-signal-exhausted',
    'grok-completion-signal-recovery-failure',
    'grok-delayed-recovery-over-legacy-timeout',
    'grok-completion-signal-user-input',
    'grok-stalled-continuation',
    'grok-repeated-stall-fuse',
    'grok-partial-emulated-tool-tag',
    'grok-recovery-format-fallback',
    'grok-historical-tool-new-turn',
    'grok-current-live-data',
    'grok-image-generation',
    'grok-delayed-plain-answer',
    'grok-streamed-plan-progress',
    'grok-internal-transcript-echo',
    'grok-escaped-whitespace',
    'grok-html-tool-scaffold',
    'grok-encoded-tool-frame',
    'grok-streamed-internal-transcript',
    'grok-short-continue-anchor',
    'grok-interrupted-continue-anchor',
    'grok-identity-self-report',
    'grok-high-demand-retry',
    'grok-high-demand-exhausted',
    'grok-context-too-large'
  ]
  const modelCapabilities = Object.fromEntries(
    [...expectedCanonicalModels, ...testOnlyModels].map(model => [
      model,
      manager._internal.modelAdapterProfile(
        model,
        model === 'grok-forced-emulation' ||
          model === 'grok-completion-signal' ||
          model === 'grok-split-completion-signal' ||
          model === 'grok-completion-signal-exhausted' ||
          model === 'grok-completion-signal-recovery-failure' ||
          model === 'grok-delayed-recovery-over-legacy-timeout' ||
          model === 'grok-completion-signal-user-input' ||
          model === 'grok-stalled-continuation' ||
          model === 'grok-repeated-stall-fuse' ||
          model === 'grok-partial-emulated-tool-tag' ||
          model === 'grok-recovery-format-fallback' ||
          model === 'grok-historical-tool-new-turn' ||
          model === 'grok-current-live-data' ||
          model === 'grok-image-generation' ||
          model === 'grok-delayed-plain-answer' ||
          model === 'grok-streamed-plan-progress' ||
          model === 'grok-internal-transcript-echo' ||
          model === 'grok-escaped-whitespace' ||
          model === 'grok-html-tool-scaffold' ||
          model === 'grok-encoded-tool-frame' ||
          model === 'grok-streamed-internal-transcript' ||
          model === 'grok-short-continue-anchor' ||
          model === 'grok-interrupted-continue-anchor'
          ? { wireApi: 'chat', toolTransport: 'prompt-emulated' }
          : {
              wireApi: model.startsWith('gpt-native') || model === 'gpt-newapi-chat-only' ? 'responses' : undefined
            }
      )
    ])
  )
  const proxy = await createProtocolProxy({
    port: 0,
    onDiagnostic: diagnostic => proxyDiagnostics.push(diagnostic),
    resolveChannel: id => {
      assert.strictEqual(id, 'test-channel')

      return {
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        apiKey: 'test-key',
        models: expectedCanonicalModels,
        modelAliases: catalogResult.aliases,
        modelCatalog: generatedCatalog.filter(model => expectedPickerModels.includes(model.slug)),
        modelCapabilities,
        modelWireApis: { 'gpt-native-responses-test': 'responses', 'grok-4.5': 'chat' }
      }
    }
  })
  const reusedProxy = await createProtocolProxy({
    port: proxy.port,
    accessToken: proxy.accessToken,
    resolveChannel: () => null
  })

  assert.strictEqual(reusedProxy.reused, true)
  assert.strictEqual(reusedProxy.baseUrl, proxy.baseUrl)
  assert.ok(proxy.port > 0)
  assert.strictEqual(proxy.baseUrl, `http://127.0.0.1:${proxy.port}/proxy/${proxy.accessToken}`)
  const unauthenticatedHealth = await fetch(`http://127.0.0.1:${proxy.port}/health`)

  assert.strictEqual(unauthenticatedHealth.status, 404)
  mark('models-proxy-upstream')
  const proxiedModelsResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/models?client_version=0.146.0`)
  const proxiedModels = await proxiedModelsResponse.json()

  assert.strictEqual(proxiedModelsResponse.status, 200)
  assert.deepStrictEqual(
    proxiedModels.data.map(item => item.id),
    expectedPickerModels
  )
  assert.deepStrictEqual(
    proxiedModels.models.map(item => item.slug),
    expectedPickerModels
  )
  assert.strictEqual(proxyDiagnostics.at(-1).source, 'validated-alias-catalog')
  assert.strictEqual(upstreamRequests.length, 0)
  modelsFailure = true
  const cachedModelsResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/models`)
  const cachedModels = await cachedModelsResponse.json()

  assert.strictEqual(cachedModelsResponse.status, 200)
  assert.deepStrictEqual(
    cachedModels.data.map(item => item.id),
    expectedPickerModels
  )
  assert.deepStrictEqual(
    cachedModels.models.map(item => item.slug),
    expectedPickerModels
  )
  assert.strictEqual(proxyDiagnostics.at(-1).source, 'validated-alias-catalog')
  upstreamRequests.length = 0
  highDemandRetryRequests = 0
  const highDemandRecovered = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-high-demand-retry',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Capacity retry.' }] }]
    })
  })
  const highDemandRecoveredBody = await highDemandRecovered.text()

  assert.strictEqual(highDemandRecovered.status, 200)
  assert.ok(highDemandRecoveredBody.includes('OK'))
  assert.strictEqual(highDemandRetryRequests, 3)
  assert.strictEqual(proxyDiagnostics.at(-1).outcome, 'upstream_accepted')
  assert.strictEqual(proxyDiagnostics.at(-1).upstreamRetryCount, 2)
  assert.ok(proxyDiagnostics.at(-1).sourceRequestBytes > 0)
  assert.ok(proxyDiagnostics.at(-1).forwardedRequestBytes > 0)
  upstreamRequests.length = 0
  const highDemandExhausted = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-high-demand-exhausted',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Capacity failure.' }] }]
    })
  })
  const highDemandExhaustedBody = await highDemandExhausted.text()

  assert.strictEqual(highDemandExhausted.status, 503)
  assert.ok(highDemandExhaustedBody.includes('已自动重试 2 次'))
  assert.strictEqual(upstreamRequests.length, 3)
  assert.strictEqual(proxyDiagnostics.at(-1).outcome, 'upstream_error')
  assert.strictEqual(proxyDiagnostics.at(-1).upstreamFailureKind, 'upstream_capacity')
  assert.strictEqual(proxyDiagnostics.at(-1).upstreamRetryCount, 2)
  upstreamRequests.length = 0
  const contextTooLarge = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-context-too-large',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Large context.' }] }]
    })
  })
  const contextTooLargeBody = await contextTooLarge.text()

  assert.strictEqual(contextTooLarge.status, 400)
  assert.ok(contextTooLargeBody.includes('上下文过大'))
  assert.strictEqual(upstreamRequests.length, 1)
  assert.strictEqual(proxyDiagnostics.at(-1).upstreamFailureKind, 'context_too_large')
  assert.strictEqual(proxyDiagnostics.at(-1).upstreamRetryCount, 0)
  upstreamRequests.length = 0
  const fastResponses = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: aliasFor('gpt-5.6-sol'),
      stream: true,
      reasoning: { effort: 'ultra', summary: 'auto' },
      service_tier: 'priority',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fast mode.' }] }]
    })
  })

  assert.strictEqual(fastResponses.status, 200)
  await fastResponses.text()
  assert.strictEqual(upstreamRequests[0].url, '/v1/responses')
  assert.strictEqual(upstreamRequests[0].body.model, 'gpt-5.6-sol')
  assert.strictEqual(upstreamRequests[0].body.reasoning.effort, 'ultra')
  assert.strictEqual(upstreamRequests[0].body.service_tier, 'priority')
  upstreamRequests.length = 0
  const gptChatFallback = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-newapi-chat-only',
      stream: true,
      reasoning: { effort: 'xhigh', summary: 'auto' },
      service_tier: 'priority',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Protocol fallback.' }] }]
    })
  })

  assert.strictEqual(gptChatFallback.status, 200)
  await gptChatFallback.text()
  assert.deepStrictEqual(
    upstreamRequests.map(item => item.url),
    ['/v1/responses', '/v1/chat/completions']
  )
  assert.strictEqual(upstreamRequests[0].body.reasoning.effort, 'high')
  assert.strictEqual(upstreamRequests[0].body.service_tier, undefined)
  assert.strictEqual(upstreamRequests[1].body.reasoning_effort, 'high')
  assert.strictEqual(upstreamRequests[1].body.service_tier, undefined)
  assert.strictEqual(proxyDiagnostics.at(-1).protocolFallback.from, 'responses')
  assert.strictEqual(proxyDiagnostics.at(-1).wireApi, 'chat')
  upstreamRequests.length = 0
  const learnedGptChat = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-newapi-chat-only',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Learned protocol.' }] }]
    })
  })

  assert.strictEqual(learnedGptChat.status, 200)
  await learnedGptChat.text()
  assert.deepStrictEqual(
    upstreamRequests.map(item => item.url),
    ['/v1/chat/completions']
  )
  upstreamRequests.length = 0
  const unknownInterface = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'vendor-responses-only',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Unknown provider protocol.' }] }]
    })
  })

  assert.strictEqual(unknownInterface.status, 422)
  assert.match(await unknownInterface.text(), /适配未完成，暂不可用/)
  assert.deepStrictEqual(upstreamRequests, [])
  mark('history-index-before-switch')
  modelsFailure = false
  upstreamRequests.length = 0
  manager._internal.writeApiKeyAuth(path.join(wireCodexHome, 'auth.json'), 'test-wire-api-key', {
    forceApiKeyMode: true
  })
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(wireCodexHome, 'auth.json'), 'utf8')).auth_mode, 'apikey')

  const historyProjectPath = path.join(wireCodexHome, 'history-project')
  const historyConfigPath = path.join(wireCodexHome, 'config.toml')
  const historySessionId = writeHistorySwitchFixture(wireCodexHome, historyProjectPath)

  fs.mkdirSync(historyProjectPath, { recursive: true })
  writeHistoryProviderConfig(historyConfigPath, aliasFor('grok-4.5'), proxy.baseUrl, modelCatalogPath)
  const apiLoginModelResponse = await manager._internal.runCodexAppServerRequest(
    codexPath,
    'model/list',
    { limit: 100, includeHidden: false },
    { env: { ...process.env, CODEX_HOME: wireCodexHome }, timeoutMs: 60000 }
  )
  const apiLoginModels = (apiLoginModelResponse.result?.data || apiLoginModelResponse.result?.models || []).map(item =>
    String(item?.model || item?.slug || item?.id || '')
  )

  assert.deepStrictEqual(
    expectedPickerModels.filter(model => apiLoginModels.includes(model)),
    expectedPickerModels,
    `API Key 登录后的 Codex model/list 不完整：${apiLoginModels.join(', ')}`
  )
  upstreamRequests.length = 0

  const historyBeforeSwitch = await manager.repairCodexConversationIndex({
    ...wireOptions,
    configPath: historyConfigPath,
    timeoutMs: 60000
  })

  assert.strictEqual(historyBeforeSwitch.ok, true)
  assert.ok(historyBeforeSwitch.allIndexedThreadSummaries.some(thread => thread.id === historySessionId))

  mark('history-index-after-switch')
  writeHistoryProviderConfig(historyConfigPath, aliasFor('gpt-5.6-sol'), proxy.baseUrl, modelCatalogPath)

  const historyAfterSwitch = await manager.repairCodexConversationIndex({
    ...wireOptions,
    configPath: historyConfigPath,
    timeoutMs: 60000
  })

  assert.strictEqual(historyAfterSwitch.ok, true)
  assert.strictEqual(historyAfterSwitch.missingSessionCount, 0)
  assert.ok(historyAfterSwitch.allIndexedThreadSummaries.some(thread => thread.id === historySessionId))

  mark('proxy-request-tests')
  upstreamRequests.length = 0
  const identityResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-identity-self-report',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What model are you?' }]
        }
      ]
    })
  })
  const identityStream = await identityResponse.text()

  assert.strictEqual(identityResponse.status, 200)
  assert.ok(identityStream.includes('UPSTREAM_OWN_IDENTITY_ANSWER'))
  assert.strictEqual(upstreamRequests.length, 1)
  assert.ok(
    upstreamRequests[0].body.messages.some(message =>
      String(message?.content || '').includes('selected_upstream_model_id="grok-identity-self-report"')
    )
  )
  assert.ok(!JSON.stringify(upstreamRequests[0].body).includes('If the user asks which model you are'))
  assert.ok(!JSON.stringify(upstreamRequests[0].body).includes('answer Grok'))

  upstreamRequests.length = 0
  const grokCompactionResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: aliasFor('grok-4.5'),
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Keep this context when switching models.' }]
        },
        { type: 'compaction_trigger' }
      ]
    })
  })
  const grokCompactionStream = await grokCompactionResponse.text()
  const grokCompactionEvents = grokCompactionStream
    .split(/\r?\n/)
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice('data: '.length)))
  const grokCompactionCompleted = grokCompactionEvents.find(event => event.type === 'response.completed')
  const grokCompactionItem = grokCompactionCompleted?.response?.output?.[0]

  assert.strictEqual(grokCompactionResponse.status, 200)
  assert.strictEqual(grokCompactionCompleted.response.model, aliasFor('grok-4.5'))
  assert.strictEqual(grokCompactionCompleted.response.output.length, 1)
  assert.strictEqual(grokCompactionItem.type, 'compaction')
  assert.match(grokCompactionItem.encrypted_content, /^cmm1:/)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.strictEqual(upstreamRequests[0].url, '/v1/chat/completions')
  assert.strictEqual(upstreamRequests[0].body.stream, true)
  assert.ok(JSON.stringify(upstreamRequests[0].body).includes('CONTEXT CHECKPOINT COMPACTION'))
  assert.ok(!JSON.stringify(upstreamRequests[0].body).includes('compaction_trigger'))
  assert.strictEqual(proxyDiagnostics.at(-1).operation, 'compaction')
  assert.strictEqual(proxyDiagnostics.at(-1).compactionVersion, 'v2')
  assert.strictEqual(proxyDiagnostics.at(-1).wireApi, 'chat')

  upstreamRequests.length = 0
  const compactionReplayResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: aliasFor('grok-4.5'),
      stream: true,
      input: [
        grokCompactionItem,
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue after switching models.' }]
        }
      ]
    })
  })

  assert.strictEqual(compactionReplayResponse.status, 200)
  await compactionReplayResponse.text()
  assert.strictEqual(upstreamRequests.length, 1)
  assert.ok(
    upstreamRequests[0].body.messages.some(message =>
      String(message?.content || '').includes(
        'Another language model started this task and produced a continuation summary'
      )
    )
  )
  assert.ok(JSON.stringify(upstreamRequests[0].body).includes('Preserve the model switch and completed tool results.'))
  assert.ok(!JSON.stringify(upstreamRequests[0].body).includes('"type":"compaction"'))

  upstreamRequests.length = 0
  const gptCompactionResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: aliasFor('gpt-5.6-sol'),
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Preserve GPT context.' }]
        },
        { type: 'compaction_trigger' }
      ]
    })
  })
  const gptCompactionPayload = await gptCompactionResponse.json()

  assert.strictEqual(gptCompactionResponse.status, 200)
  assert.strictEqual(gptCompactionPayload.model, aliasFor('gpt-5.6-sol'))
  assert.strictEqual(gptCompactionPayload.output.length, 1)
  assert.strictEqual(gptCompactionPayload.output[0].type, 'compaction')
  assert.match(gptCompactionPayload.output[0].encrypted_content, /^cmm1:/)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.strictEqual(upstreamRequests[0].url, '/v1/responses')
  assert.strictEqual(upstreamRequests[0].body.stream, true)
  assert.strictEqual(proxyDiagnostics.at(-1).compactionVersion, 'v2')
  assert.strictEqual(proxyDiagnostics.at(-1).wireApi, 'responses')

  upstreamRequests.length = 0
  const compactV1Response = await fetch(`${proxy.baseUrl}/v1/test-channel/responses/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: aliasFor('grok-4.5'),
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Legacy compact context.' }]
        }
      ]
    })
  })
  const compactV1Payload = await compactV1Response.json()

  assert.strictEqual(compactV1Response.status, 200)
  assert.ok(compactV1Payload.output.length >= 2)
  assert.ok(compactV1Payload.output.every(item => item.type === 'message'))
  assert.strictEqual(upstreamRequests[0].body.stream, true)
  assert.strictEqual(proxyDiagnostics.at(-1).compactionVersion, 'v1')

  upstreamRequests.length = 0
  const customResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-custom-proxy-test',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Call exec.' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const customStream = await customResponse.text()
  const customUpstream = upstreamRequests[0]
  const customDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(customResponse.status, 200)
  assert.ok(customUpstream.body.tools.some(tool => tool.function?.name === 'exec'))
  assert.ok(customStream.includes('response.custom_tool_call_input.done'))
  assert.ok(customStream.includes('"type":"custom_tool_call"'))
  assert.ok(customStream.includes('"id":"ctc_'))
  assert.ok(customStream.includes('curl http://192.0.2.17:3000'))
  assert.strictEqual(customDiagnostic.sourceToolCount, 1)
  assert.strictEqual(customDiagnostic.forwardedToolCount, 1)
  assert.ok(customDiagnostic.sourceToolNames.includes('exec'))
  assert.strictEqual(customDiagnostic.hasShellTool, true)
  upstreamRequests.length = 0
  const delayedPlainResponsePromise = fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-delayed-plain-answer',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  let delayedPlainResponse
  let delayedPlainReader
  let delayedPlainStream = ''

  try {
    await withTimeout(delayedPlainReached, 3000, 'delayed plain upstream headers')
    delayedPlainResponse = await withTimeout(
      delayedPlainResponsePromise,
      3000,
      'early downstream response before Grok body'
    )
    delayedPlainReader = delayedPlainResponse.body.getReader()
    const firstChunk = await withTimeout(delayedPlainReader.read(), 1000, 'early response.in_progress event')

    delayedPlainStream += new TextDecoder().decode(firstChunk.value || new Uint8Array(), { stream: !firstChunk.done })
    assert.ok(delayedPlainStream.includes('response.created'))
    assert.ok(delayedPlainStream.includes('response.in_progress'))
    assert.ok(!delayedPlainStream.includes('PLAIN_ANSWER_OK'))
  } finally {
    const release = releaseDelayedPlainResponse

    releaseDelayedPlainResponse = null
    release?.()
  }
  if (delayedPlainReader) {
    const decoder = new TextDecoder()

    for (;;) {
      const { done, value } = await delayedPlainReader.read()

      if (done) break
      delayedPlainStream += decoder.decode(value, { stream: true })
    }
    delayedPlainStream += decoder.decode()
  } else {
    delayedPlainResponse = await delayedPlainResponsePromise
    delayedPlainStream = await delayedPlainResponse.text()
  }
  const delayedPlainDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(delayedPlainResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.ok(delayedPlainStream.includes('PLAIN_ANSWER_OK'))
  assert.ok(delayedPlainStream.includes('response.completed'))
  assert.strictEqual(delayedPlainDiagnostic.emulation.continuationRecovery.retryAttempted, false)
  assert.strictEqual(delayedPlainDiagnostic.emulation.continuationRecovery.maximumRecoveryAttempts, 0)
  assert.strictEqual(delayedPlainDiagnostic.emulation.continuationRecovery.toolIntentRequired, false)
  assert.strictEqual(delayedPlainDiagnostic.emulation.earlyResponseStarted, true)
  upstreamRequests.length = 0
  const streamedPlanResponsePromise = fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-streamed-plan-progress',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '生成一张太阳图片。' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  let streamedPlanResponse
  let streamedPlanReader
  let streamedPlanPrefix = ''

  try {
    await withTimeout(streamedPlanReached, 3000, 'streamed plan first upstream delta').catch(error => {
      error.message += `; upstream=${JSON.stringify(upstreamRequests.slice(-3).map(item => ({ url: item.url, model: item.body.model, tools: item.body.tools?.length || 0 })))}`
      throw error
    })
    streamedPlanResponse = await withTimeout(streamedPlanResponsePromise, 1000, 'streamed commentary response')
    streamedPlanReader = streamedPlanResponse.body.getReader()
    const decoder = new TextDecoder()

    while (!streamedPlanPrefix.includes('我先确认有没有 image-gen 工具。')) {
      const { done, value } = await withTimeout(streamedPlanReader.read(), 1000, 'streamed commentary delta')

      if (done) break
      streamedPlanPrefix += decoder.decode(value, { stream: true })
    }
    assert.ok(streamedPlanPrefix.includes('我先确认有没有 image-gen 工具。'))
    assert.ok(streamedPlanPrefix.includes('"phase":"commentary"'))
    assert.ok(!streamedPlanPrefix.includes('text(123)'))
  } finally {
    const release = releaseStreamedPlanResponse

    releaseStreamedPlanResponse = null
    release?.()
  }
  let streamedPlanStream = streamedPlanPrefix

  if (streamedPlanReader) {
    const decoder = new TextDecoder()

    for (;;) {
      const { done, value } = await streamedPlanReader.read()

      if (done) break
      streamedPlanStream += decoder.decode(value, { stream: true })
    }
    streamedPlanStream += decoder.decode()
  } else {
    streamedPlanResponse = await streamedPlanResponsePromise
    streamedPlanStream = await streamedPlanResponse.text()
  }
  const streamedPlanDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(streamedPlanResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.ok(streamedPlanStream.includes('response.custom_tool_call_input.done'))
  assert.ok(streamedPlanStream.includes('text(123)'))
  assert.strictEqual(streamedPlanDiagnostic.emulation.continuationRecovery.liveProgressCount, 1)
  assert.ok(streamedPlanDiagnostic.emulation.continuationRecovery.firstProgressDeltaMs >= 0)
  assert.ok(
    streamedPlanDiagnostic.emulation.continuationRecovery.firstProgressDeltaMs <
      streamedPlanDiagnostic.emulation.totalSynthesisMs
  )
  assert.ok(streamedPlanDiagnostic.emulation.continuationRecovery.progressDeltaCount >= 1)
  assert.strictEqual(streamedPlanDiagnostic.emulation.continuationRecovery.acceptedRetry, true)
  upstreamRequests.length = 0
  const shortContinueResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-short-continue-anchor',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '查询今日金价，并把结果写入桌面文件。' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '先查询最新金价。\n上游模型未能完成剩余步骤，请重试本轮任务。'
            }
          ]
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const shortContinueStream = await shortContinueResponse.text()
  const shortContinueDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(shortContinueResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.ok(shortContinueStream.includes('response.custom_tool_call_input.done'))
  assert.ok(shortContinueStream.includes('tools.web__run'))
  assert.strictEqual(shortContinueDiagnostic.emulation.toolCallName, 'exec')
  assert.strictEqual(shortContinueDiagnostic.emulation.contextContinuity.shortContinuationAnchored, true)
  assert.ok(shortContinueDiagnostic.emulation.contextContinuity.continuationTaskLength > 0)
  upstreamRequests.length = 0
  const interruptedContinueResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-interrupted-continue-anchor',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '安装 Python，完成后运行 python --version 验证。' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '正在下载安装程序。' }]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_interrupted_python_download',
          input: 'download installer'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_interrupted_python_download',
          output: 'download complete'
        },
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: '<turn_aborted>The user intentionally interrupted the previous turn.</turn_aborted>'
            }
          ]
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续安装并验证 Python' }]
        }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const interruptedContinueStream = await interruptedContinueResponse.text()
  const interruptedContinueDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(interruptedContinueResponse.status, 200)
  assert.ok(interruptedContinueStream.includes('response.custom_tool_call_input.done'))
  assert.ok(interruptedContinueStream.includes('python --version'))
  assert.ok(!interruptedContinueStream.includes('turn_aborted'))
  assert.strictEqual(interruptedContinueDiagnostic.emulation.toolCallName, 'exec')
  assert.strictEqual(interruptedContinueDiagnostic.emulation.contextContinuity.shortContinuationAnchored, true)
  assert.strictEqual(interruptedContinueDiagnostic.emulation.contextContinuity.interruptedContinuationAnchored, true)
  assert.strictEqual(interruptedContinueDiagnostic.emulation.contextContinuity.continuationToolResultCount, 1)
  upstreamRequests.length = 0
  const currentLiveDataResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-current-live-data',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '今日金价' }] }],
      tools: [
        { type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' },
        { type: 'web_search' }
      ]
    })
  })
  const currentLiveDataStream = await currentLiveDataResponse.text()
  const currentLiveDataDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(currentLiveDataResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 3)
  assert.ok(upstreamRequests.every(request => request.body.stream === true))
  assert.ok(currentLiveDataStream.includes('response.custom_tool_call_input.done'))
  assert.ok(currentLiveDataStream.includes('tools.web__run'))
  assert.ok(!currentLiveDataStream.includes('Gold is 9999 from unverified model memory.'))
  assert.strictEqual(currentLiveDataDiagnostic.emulation.toolCallName, 'exec')
  assert.strictEqual(currentLiveDataDiagnostic.emulation.toolCallUsesWebRun, true)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.toolIntentRequired, true)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.initialToolOmission, true)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.recoveryAttempts, 2)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.maximumRecoveryAttempts, 0)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.maximumRecoveryMs, 0)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.unlimitedRecovery, true)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.recoveryTimeBudgetExhausted, false)
  assert.ok(currentLiveDataDiagnostic.emulation.continuationRecovery.recoveryElapsedMs >= 0)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.continuationRecovery.acceptedRetry, true)
  assert.strictEqual(currentLiveDataDiagnostic.emulation.recoveryRequestMs.length, 2)
  assert.ok(currentLiveDataDiagnostic.emulation.initialResponseMs >= 0)
  assert.ok(currentLiveDataDiagnostic.emulation.totalSynthesisMs >= 0)
  upstreamRequests.length = 0
  const imageGenerationResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-image-generation',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '生成一张太阳图片' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const imageGenerationStream = await imageGenerationResponse.text()
  const imageGenerationDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(imageGenerationResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.ok(imageGenerationStream.includes('response.custom_tool_call_input.done'))
  assert.ok(imageGenerationStream.includes('tools.image_gen__imagegen'))
  assert.ok(imageGenerationStream.includes('generatedImage'))
  assert.strictEqual(imageGenerationDiagnostic.emulation.toolCallName, 'exec')
  assert.strictEqual(imageGenerationDiagnostic.emulation.continuationRecovery.naturalStall, true)
  assert.strictEqual(imageGenerationDiagnostic.emulation.continuationRecovery.recoveryAttempts, 1)
  assert.strictEqual(imageGenerationDiagnostic.emulation.continuationRecovery.acceptedRetry, true)
  upstreamRequests.length = 0
  const rejectedResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-reject-tools-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use a tool.' }] }],
      tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } }]
    })
  })

  assert.strictEqual(rejectedResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  const emulatedStream = await rejectedResponse.text()

  assert.ok(emulatedStream.includes('response.function_call_arguments.done'))
  assert.ok(emulatedStream.includes('Write-Output emulated-ok'))
  assert.strictEqual(proxyDiagnostics.at(-1).toolTransport, 'prompt-emulated')
  upstreamRequests.length = 0
  const emulatedContinuationResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-reject-tools-test',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect and report the result.' }] },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_emulated_continuation',
          arguments: '{"command":"Write-Output emulated-ok"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_emulated_continuation',
          output: 'emulated-ok'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })
  const emulatedContinuationStream = await emulatedContinuationResponse.text()

  assert.strictEqual(emulatedContinuationResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.ok(emulatedContinuationStream.includes('CODEX_CONTINUATION_OK'))
  assert.ok(!emulatedContinuationStream.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(!emulatedContinuationStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.ok(emulatedContinuationStream.includes('response.completed'))
  assert.strictEqual(proxyDiagnostics.at(-1).sourceToolOutputCount, 1)
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.continuationRecovery.retryAttempted, false)
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.continuationRecovery.acceptedCompletionSignal, true)
  const continuationFallbackBody = upstreamRequests[1].body
  const continuationFallbackContents = (continuationFallbackBody.messages || []).map(message =>
    String(message?.content || '')
  )
  const continuationFallbackMessages = continuationFallbackContents.join('\n')

  assert.ok(continuationFallbackMessages.includes('<codex_internal_tool_history>'))
  assert.ok(continuationFallbackMessages.includes('"kind":"tool_calls"'))
  assert.ok(continuationFallbackMessages.includes('"kind":"tool_result"'))
  assert.ok(!continuationFallbackMessages.includes('[Codex local tool calls]'))
  assert.ok(!continuationFallbackMessages.includes('[Codex local tool result'))
  upstreamRequests.length = 0
  const transcriptEchoResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-internal-transcript-echo',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Return a normal answer.' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const transcriptEchoStream = await transcriptEchoResponse.text()

  assert.strictEqual(transcriptEchoResponse.status, 200)
  assert.ok(transcriptEchoStream.includes('VISIBLE_ONLY'), transcriptEchoStream)
  assert.ok(!transcriptEchoStream.includes('[Codex local tool calls]'))
  assert.ok(!transcriptEchoStream.includes('"name":"exec","arguments":"{}"'))
  assert.ok(!transcriptEchoStream.includes('response.custom_tool_call_input.done'))
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.internalTranscriptSuppressed, true)
  upstreamRequests.length = 0
  const escapedWhitespaceResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-escaped-whitespace',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Return a short answer.' }] }]
    })
  })
  const escapedWhitespaceStream = await escapedWhitespaceResponse.text()

  assert.strictEqual(escapedWhitespaceResponse.status, 200)
  assert.ok(escapedWhitespaceStream.includes('response.completed'))
  assert.ok(!escapedWhitespaceStream.includes('\\\\n\\\\n'), escapedWhitespaceStream)
  assert.ok(!escapedWhitespaceStream.includes('response.output_text.delta'))
  upstreamRequests.length = 0
  const htmlToolScaffoldResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-html-tool-scaffold',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Check the installed Python version.' }]
        }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const htmlToolScaffoldStream = await htmlToolScaffoldResponse.text()

  assert.strictEqual(htmlToolScaffoldResponse.status, 200)
  assert.ok(htmlToolScaffoldStream.includes('response.custom_tool_call_input.done'), htmlToolScaffoldStream)
  assert.ok(htmlToolScaffoldStream.includes('text(123)'))
  assert.ok(!htmlToolScaffoldStream.includes('<!DOCTYPE html>'))
  assert.ok(!htmlToolScaffoldStream.includes('globalThis.tools'))
  assert.ok(!htmlToolScaffoldStream.includes('python --version'))
  assert.ok(!htmlToolScaffoldStream.includes('<codex_tool_call'))
  assert.ok(!htmlToolScaffoldStream.includes('"phase":"commentary"'))
  upstreamRequests.length = 0
  const encodedToolFrameResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-encoded-tool-frame',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Check the installed Python version.' }]
        }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const encodedToolFrameStream = await encodedToolFrameResponse.text()

  assert.strictEqual(encodedToolFrameResponse.status, 200)
  assert.ok(encodedToolFrameStream.includes('response.custom_tool_call_input.done'), encodedToolFrameStream)
  assert.ok(encodedToolFrameStream.includes('python --version'))
  assert.ok(!encodedToolFrameStream.includes('0xa0a1e'))
  assert.ok(!encodedToolFrameStream.includes('0xa1input'))
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.toolCallName, 'exec')
  upstreamRequests.length = 0
  const streamedTranscriptResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-streamed-internal-transcript',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const streamedTranscript = await streamedTranscriptResponse.text()

  assert.strictEqual(streamedTranscriptResponse.status, 200)
  assert.ok(
    streamedTranscript.includes('VISIBLE_ONLY'),
    `${streamedTranscript}\nrequests=${streamedInternalTranscriptRequests}\nmodels=${upstreamRequests
      .map(request => request.body?.model)
      .join(',')}`
  )
  assert.ok(streamedTranscript.includes('I will inspect the local frontend'))
  assert.ok(!streamedTranscript.includes('[Codex local tool calls]'))
  assert.ok(!streamedTranscript.includes('RAW_POWERSHELL_SHOULD_NOT_RENDER'))
  assert.ok(!streamedTranscript.includes('C:\\\\Users\\\\Tester'))
  assert.ok(!streamedTranscript.includes('response.custom_tool_call_input.done'))
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.internalTranscriptSuppressed, true)
  upstreamRequests.length = 0
  const splitCompletionSignalResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-split-completion-signal',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue checking the remote login.' }]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_split_completion_signal',
          input: 'previous check'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_split_completion_signal',
          output: 'network and port reachable'
        }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run nested Codex tools.' }]
    })
  })
  const splitCompletionSignalStream = await splitCompletionSignalResponse.text()
  const splitCompletionSignalDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery

  assert.strictEqual(splitCompletionSignalResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.strictEqual(splitCompletionSignalRecoveryRequests, 1)
  assert.ok(splitCompletionSignalStream.includes('网络和 SSH 端口都通'))
  assert.ok(splitCompletionSignalStream.includes('response.custom_tool_call_input.done'))
  assert.ok(!splitCompletionSignalStream.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(!splitCompletionSignalStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.ok(!splitCompletionSignalStream.includes('<codex_tool_call'))
  assert.strictEqual(splitCompletionSignalDiagnostic.naturalStall, true)
  assert.strictEqual(splitCompletionSignalDiagnostic.completionSignalPresent, true)
  assert.strictEqual(splitCompletionSignalDiagnostic.inferredTerminalCandidate, false)
  assert.strictEqual(splitCompletionSignalDiagnostic.unlimitedRecovery, true)
  assert.strictEqual(splitCompletionSignalDiagnostic.recoveryAttempts, 1)
  assert.strictEqual(splitCompletionSignalDiagnostic.acceptedRetry, true)
  assert.strictEqual(splitCompletionSignalDiagnostic.retryProducedToolCall, true)
  upstreamRequests.length = 0
  const completionSignalResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-completion-signal',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Save the file and report the result.' }]
        },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_completion_signal',
          arguments: '{"command":"Set-Content result.txt done"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_completion_signal',
          output: 'saved'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })
  const completionSignalStream = await completionSignalResponse.text()
  const completionSignalDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery
  const completionSignalDeltas = completionSignalStream
    .split(/\r?\n/)
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice('data: '.length)))
    .filter(event => event.type === 'response.output_text.delta')
    .map(event => event.delta)
    .join('')

  assert.strictEqual(completionSignalResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.strictEqual(completionSignalRecoveryRequests, 1)
  assert.strictEqual(completionSignalDeltas, '任务已经完成，文件已保存。')
  assert.ok(!completionSignalStream.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(!completionSignalStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.strictEqual(completionSignalDiagnostic.toolResultPresent, true)
  assert.strictEqual(completionSignalDiagnostic.missingCompletionSignal, true)
  assert.strictEqual(completionSignalDiagnostic.retryAttempted, true)
  assert.strictEqual(completionSignalDiagnostic.recoveryAttempts, 1)
  assert.strictEqual(completionSignalDiagnostic.maximumRecoveryAttempts, 0)
  assert.strictEqual(completionSignalDiagnostic.unlimitedRecovery, true)
  assert.strictEqual(completionSignalDiagnostic.acceptedRetry, true)
  assert.strictEqual(completionSignalDiagnostic.visibleProgressCount, 0)
  assert.strictEqual(completionSignalDiagnostic.exhausted, false)
  assert.strictEqual(completionSignalDiagnostic.safetyStopAppended, false)
  assert.strictEqual(completionSignalDiagnostic.acceptedCompletionSignal, true)
  assert.deepStrictEqual(completionSignalDiagnostic.recoveryDecisionKinds, ['complete'])
  assert.strictEqual(completionSignalDiagnostic.acceptedRecoveryDecision, 'complete')
  upstreamRequests.length = 0
  const exhaustedCompletionSignalResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-completion-signal-exhausted',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Save the file and report the result.' }]
        },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_completion_signal_exhausted',
          arguments: '{"command":"Set-Content result.txt done"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_completion_signal_exhausted',
          output: 'saved'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })
  const exhaustedCompletionSignalStream = await exhaustedCompletionSignalResponse.text()
  const exhaustedCompletionSignalDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery

  assert.strictEqual(exhaustedCompletionSignalResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1 + PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.strictEqual(exhaustedCompletionSignalRecoveryRequests, PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.ok(!exhaustedCompletionSignalStream.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(!exhaustedCompletionSignalStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.ok(!exhaustedCompletionSignalStream.includes('上游模型未能完成剩余步骤，请重试本轮任务。'))
  assert.ok(exhaustedCompletionSignalStream.includes('模型连续返回相同的中间计划'))
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.retryAttempted, true)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.recoveryAttempts, PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.maximumRecoveryAttempts, 0)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.unlimitedRecovery, true)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.repeatedRecoveryResponses, 5)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.recoveryCircuitBreaker, 'identical_stalled_responses')
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.acceptedRetry, false)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.exhausted, true)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.safetyStopAppended, false)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.safetyStopTriggered, true)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.acceptedCompletionSignal, false)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.inferredTerminalCandidate, false)
  assert.strictEqual(exhaustedCompletionSignalDiagnostic.inferredCompletionAccepted, false)
  upstreamRequests.length = 0
  const recoveryFailureResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-completion-signal-recovery-failure',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Save the file and report the result.' }]
        },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_completion_signal_recovery_failure',
          arguments: '{"command":"Write-Output first-step-finished"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_completion_signal_recovery_failure',
          output: 'first step finished'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })
  const recoveryFailureStream = await recoveryFailureResponse.text()
  const recoveryFailureEmulation = proxyDiagnostics.at(-1).emulation
  const recoveryFailureDiagnostic = recoveryFailureEmulation.continuationRecovery
  const recoveryFailureDeltas = recoveryFailureStream
    .split(/\r?\n/)
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice('data: '.length)))
    .filter(event => event.type === 'response.output_text.delta')
    .map(event => event.delta)
    .join('')

  assert.strictEqual(recoveryFailureResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1 + PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES)
  assert.ok(upstreamRequests.every(request => request.body.stream === true))
  assert.strictEqual((recoveryFailureDeltas.match(/下一步我会继续保存文件。/g) || []).length, 1)
  assert.strictEqual((recoveryFailureDeltas.match(/\[CODEX_AGENT_LOOP_SAFETY_STOP\]/g) || []).length, 0)
  assert.strictEqual((recoveryFailureDeltas.match(/上游模型未能完成剩余步骤，请重试本轮任务。/g) || []).length, 0)
  assert.ok(!recoveryFailureDeltas.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(recoveryFailureDeltas.includes('模型渠道服务暂时不可用'))
  assert.strictEqual(recoveryFailureEmulation.recoveryAttemptTimeoutMs, 60000)
  assert.strictEqual(recoveryFailureDiagnostic.recoveryAttempts, PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES)
  assert.strictEqual(recoveryFailureDiagnostic.failedRecoveryAttempts, PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES)
  assert.deepStrictEqual(
    recoveryFailureDiagnostic.recoveryFailureKinds,
    Array(PROMPT_TOOL_RECOVERY_MAX_CONSECUTIVE_FAILURES).fill('http_server_error')
  )
  assert.strictEqual(recoveryFailureDiagnostic.maximumRecoveryAttempts, 0)
  assert.strictEqual(recoveryFailureDiagnostic.unlimitedRecovery, true)
  assert.strictEqual(recoveryFailureDiagnostic.recoveryCircuitBreaker, 'consecutive_transport_failures')
  assert.strictEqual(recoveryFailureDiagnostic.visibleProgressCount, 1)
  assert.strictEqual(recoveryFailureDiagnostic.liveProgressCount, 1)
  assert.strictEqual(recoveryFailureDiagnostic.exhausted, true)
  assert.strictEqual(recoveryFailureDiagnostic.safetyStopAppended, false)
  assert.strictEqual(recoveryFailureDiagnostic.safetyStopTriggered, true)
  assert.strictEqual(recoveryFailureDiagnostic.acceptedCompletionSignal, false)
  upstreamRequests.length = 0
  const delayedRecoveryStartedAt = Date.now()
  const delayedRecoveryResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-delayed-recovery-over-legacy-timeout',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Run the installer script and verify the result.' }]
        }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const delayedRecoveryStream = await delayedRecoveryResponse.text()
  const delayedRecoveryElapsedMs = Date.now() - delayedRecoveryStartedAt
  const delayedRecoveryDiagnostic = proxyDiagnostics.at(-1).emulation

  assert.strictEqual(delayedRecoveryResponse.status, 200)
  assert.ok(delayedRecoveryElapsedMs >= 15_500)
  assert.ok(delayedRecoveryElapsedMs < PROMPT_TOOL_RECOVERY_ATTEMPT_TIMEOUT_MS)
  assert.ok(delayedRecoveryStream.includes('response.custom_tool_call_input.done'))
  assert.ok(delayedRecoveryStream.includes('RECOVERED_AFTER_LEGACY_TIMEOUT'))
  assert.strictEqual(delayedRecoveryDiagnostic.continuationRecovery.recoveryAttempts, 1)
  assert.strictEqual(delayedRecoveryDiagnostic.continuationRecovery.failedRecoveryAttempts, 0)
  assert.deepStrictEqual(delayedRecoveryDiagnostic.continuationRecovery.recoveryFailureKinds, [])
  assert.strictEqual(delayedRecoveryDiagnostic.continuationRecovery.retryProducedToolCall, true)
  upstreamRequests.length = 0
  const repeatedStallResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-repeated-stall-fuse',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Complete every remaining local step.' }]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_repeated_stall_first_step',
          input: 'const first = await tools.shell_command({command:"Write-Output first"}); text(first);'
        },
        { type: 'custom_tool_call_output', call_id: 'call_repeated_stall_first_step', output: 'first done' }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const repeatedStallStream = await repeatedStallResponse.text()
  const repeatedStallDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery

  assert.strictEqual(repeatedStallResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1 + PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.ok(repeatedStallStream.includes('模型连续返回相同的中间计划'))
  assert.ok(!repeatedStallStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.strictEqual(repeatedStallDiagnostic.unlimitedRecovery, true)
  assert.strictEqual(repeatedStallDiagnostic.recoveryAttempts, PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.strictEqual(repeatedStallDiagnostic.repeatedRecoveryResponses, PROMPT_TOOL_RECOVERY_MAX_IDENTICAL_RESPONSES)
  assert.strictEqual(repeatedStallDiagnostic.recoveryCircuitBreaker, 'identical_stalled_responses')
  assert.strictEqual(repeatedStallDiagnostic.acceptedRetry, false)
  upstreamRequests.length = 0
  const completionSignalUserInputResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-completion-signal-user-input',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Save the file.' }]
        },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_completion_signal_user_input',
          arguments: '{"command":"Write-Output missing-path"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_completion_signal_user_input',
          output: 'path required'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })
  const completionSignalUserInputStream = await completionSignalUserInputResponse.text()
  const completionSignalUserInputDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery

  assert.strictEqual(completionSignalUserInputResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.ok(completionSignalUserInputStream.includes('请提供要保存的完整路径。'))
  assert.ok(!completionSignalUserInputStream.includes('[CODEX_AGENT_LOOP_COMPLETE]'))
  assert.ok(!completionSignalUserInputStream.includes('[CODEX_AGENT_LOOP_SAFETY_STOP]'))
  assert.strictEqual(completionSignalUserInputDiagnostic.retryAttempted, false)
  assert.strictEqual(completionSignalUserInputDiagnostic.exhausted, false)
  assert.strictEqual(completionSignalUserInputDiagnostic.safetyStopAppended, false)
  upstreamRequests.length = 0
  const partialToolTagResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-partial-emulated-tool-tag',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Connect to the host and verify the login.' }]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_initial_ssh_probe',
          input: 'const probe = await tools.shell_command({command:"ping 127.0.0.1"}); text(probe);'
        },
        { type: 'custom_tool_call_output', call_id: 'call_initial_ssh_probe', output: 'Ping succeeded.' }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const partialToolTagStream = await partialToolTagResponse.text()

  assert.strictEqual(partialToolTagResponse.status, 200)
  assert.ok(partialToolTagStream.includes('Ping 已通'))
  assert.ok(
    partialToolTagStream.includes('response.custom_tool_call_input.done'),
    `${partialToolTagStream}\ndiagnostic=${JSON.stringify(proxyDiagnostics.at(-1))}`
  )
  assert.ok(partialToolTagStream.includes('CONNECTED'))
  assert.ok(!partialToolTagStream.includes('<codex_tool_call'))
  assert.ok(!partialToolTagStream.includes('<codex_tool_cal'))
  assert.strictEqual(proxyDiagnostics.at(-1).emulation.continuationRecovery.recoveryAttempts, 0)
  upstreamRequests.length = 0
  formatFallbackRecoveryRequests = 0
  const formatFallbackResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-recovery-format-fallback',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Connect to the host and verify the login.' }]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_failed_ssh_login',
          input: 'const login = await tools.shell_command({command:"ssh test"}); text(login);'
        },
        { type: 'custom_tool_call_output', call_id: 'call_failed_ssh_login', output: 'SSH login timed out.' }
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })
  const formatFallbackStream = await formatFallbackResponse.text()
  const formatFallbackDiagnostic = proxyDiagnostics.at(-1).emulation.continuationRecovery

  assert.strictEqual(formatFallbackResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 3)
  assert.strictEqual(formatFallbackRecoveryRequests, 2)
  assert.deepStrictEqual(upstreamRequests[1].body.response_format, { type: 'json_object' })
  assert.strictEqual(upstreamRequests[2].body.response_format, undefined)
  assert.ok(formatFallbackStream.includes('response.custom_tool_call_input.done'))
  assert.ok(formatFallbackStream.includes('POSH_SSH_READY'))
  assert.ok(!formatFallbackStream.includes('<codex_tool_call'))
  assert.strictEqual(formatFallbackDiagnostic.recoveryAttempts, 1)
  assert.strictEqual(formatFallbackDiagnostic.failedRecoveryAttempts, 0)
  assert.strictEqual(formatFallbackDiagnostic.acceptedRetry, true)
  assert.strictEqual(formatFallbackDiagnostic.retryProducedToolCall, true)
  upstreamRequests.length = 0
  const stalledContinuationResponsePromise = fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-stalled-continuation',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Fetch today’s gold price, write it with the date, open Notepad, and save it.'
            }
          ]
        },
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_fetch_gold_price',
          input: 'const price = await tools.shell_command({command:"Write-Output 2800"}); text(price);'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_fetch_gold_price',
          output: 'Gold price: 2800'
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<environment_context><cwd>C:\\TestWorkspace</cwd><shell>powershell</shell></environment_context>'
            }
          ]
        }
      ],
      tools: [
        { type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' },
        {
          type: 'function',
          name: 'request_user_input',
          parameters: {
            type: 'object',
            properties: { question: { type: 'string' } },
            required: ['question']
          }
        }
      ]
    })
  })
  let stalledContinuationResponse
  let stalledContinuationReader
  let stalledContinuationPrefix = ''

  try {
    await withTimeout(stalledFinalReached, 3000, 'final stalled recovery request')
    stalledContinuationResponse = await withTimeout(
      stalledContinuationResponsePromise,
      1000,
      'live Codex progress response'
    )
    stalledContinuationReader = stalledContinuationResponse.body.getReader()
    const decoder = new TextDecoder()

    while (
      !stalledContinuationPrefix.includes('我接下来会处理剩余步骤。') ||
      !stalledContinuationPrefix.includes('正在准备下一个可执行步骤。') ||
      !stalledContinuationPrefix.includes('下一步将继续执行保存任务。')
    ) {
      const { done, value } = await withTimeout(stalledContinuationReader.read(), 1000, 'live Codex progress chunk')

      if (done) break
      stalledContinuationPrefix += decoder.decode(value, { stream: true })
    }
    assert.ok(stalledContinuationPrefix.includes('我接下来会处理剩余步骤。'))
    assert.ok(stalledContinuationPrefix.includes('正在准备下一个可执行步骤。'))
    assert.ok(stalledContinuationPrefix.includes('下一步将继续执行保存任务。'))
    assert.ok(!stalledContinuationPrefix.includes('notepad.exe'))
  } finally {
    releaseStalledFinalResponse?.()
  }
  let stalledContinuationStream = stalledContinuationPrefix

  if (stalledContinuationReader) {
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await stalledContinuationReader.read()

      if (done) break
      stalledContinuationStream += decoder.decode(value, { stream: true })
    }
  } else {
    stalledContinuationResponse = await stalledContinuationResponsePromise
    stalledContinuationStream = await stalledContinuationResponse.text()
  }
  const stalledDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(stalledContinuationResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 6)
  assert.ok(upstreamRequests.every(request => request.body.stream === true))
  assert.ok(stalledContinuationStream.includes('response.custom_tool_call_input.done'))
  assert.ok(stalledContinuationStream.includes('notepad.exe'))
  assert.ok(stalledContinuationStream.includes('"id":"ctc_'))
  assert.ok(stalledContinuationStream.includes('我接下来会处理剩余步骤。'))
  assert.ok(stalledContinuationStream.includes('正在准备下一个可执行步骤。'))
  assert.ok(stalledContinuationStream.includes('下一步将继续执行保存任务。'))
  assert.ok(stalledContinuationStream.includes('接下来我会执行写入文件。'))
  assert.ok(stalledContinuationStream.includes('然后我将打开记事本并保存。'))
  assert.ok(
    stalledContinuationStream.indexOf('我接下来会处理剩余步骤。') <
      stalledContinuationStream.indexOf('正在准备下一个可执行步骤。')
  )
  assert.ok(
    stalledContinuationStream.indexOf('正在准备下一个可执行步骤。') <
      stalledContinuationStream.indexOf('下一步将继续执行保存任务。')
  )
  assert.ok(
    stalledContinuationStream.indexOf('下一步将继续执行保存任务。') <
      stalledContinuationStream.indexOf('接下来我会执行写入文件。')
  )
  assert.ok(
    stalledContinuationStream.indexOf('接下来我会执行写入文件。') <
      stalledContinuationStream.indexOf('然后我将打开记事本并保存。')
  )
  assert.ok(
    stalledContinuationStream.indexOf('然后我将打开记事本并保存。') < stalledContinuationStream.indexOf('notepad.exe')
  )
  assert.strictEqual(stalledDiagnostic.toolTransport, 'prompt-emulated')
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.toolResultPresent, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.convertedToolResultPresent, false)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.sourceToolResultPresent, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.stalledContinuation, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.stalledAfterToolResult, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.retryAttempted, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.recoveryAttempts, 5)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.maximumRecoveryAttempts, 0)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.unlimitedRecovery, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.acceptedRetry, true)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.retryProducedToolCall, true)
  assert.deepStrictEqual(stalledDiagnostic.emulation.continuationRecovery.recoveryDecisionKinds, [
    'legacy',
    'legacy',
    'legacy',
    'legacy',
    'tool'
  ])
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.acceptedRecoveryDecision, 'tool')
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.visibleProgressCount, 5)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.liveProgressCount, 5)
  assert.strictEqual(stalledDiagnostic.emulation.continuationRecovery.bufferedProgressCount, 0)
  assert.strictEqual(stalledDiagnostic.sourceFollowsToolResult, true)
  assert.deepStrictEqual(stalledDiagnostic.sourceInputTailKinds.slice(-2), [
    { type: 'custom_tool_call_output', role: '' },
    { type: 'message', role: 'user' }
  ])
  assert.strictEqual(stalledDiagnostic.emulation.toolCallName, 'exec')
  upstreamRequests.length = 0
  const historicalToolNewTurnResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-historical-tool-new-turn',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Old task.' }]
        },
        {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_old_history',
          arguments: '{"command":"Write-Output OLD"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_old_history',
          output: 'OLD'
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'This is a new task. Inspect it with the shell.' }]
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      ]
    })
  })
  const historicalToolNewTurnStream = await historicalToolNewTurnResponse.text()
  const historicalToolNewTurnDiagnostic = proxyDiagnostics.at(-1)

  assert.strictEqual(historicalToolNewTurnResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.ok(historicalToolNewTurnStream.includes('response.function_call_arguments.done'))
  assert.ok(historicalToolNewTurnStream.includes('NEW_TURN_RECOVERED'))
  assert.strictEqual(historicalToolNewTurnDiagnostic.emulation.continuationRecovery.toolResultPresent, false)
  assert.strictEqual(historicalToolNewTurnDiagnostic.emulation.continuationRecovery.retryAttempted, true)
  upstreamRequests.length = 0
  const forcedEmulationResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-forced-emulation',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the shell tool.' }] }],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ]
    })
  })

  assert.strictEqual(forcedEmulationResponse.status, 200)
  assert.ok((await forcedEmulationResponse.text()).includes('response.function_call_arguments.done'))
  assert.strictEqual(upstreamRequests.length, 1)
  assert.strictEqual(Array.isArray(upstreamRequests[0].body.tools), false)
  assert.strictEqual(proxyDiagnostics.at(-1).forcedByCompatibilityTest, true)
  upstreamRequests.length = 0
  const rejectedExecResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-reject-exec-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Open Calculator.' }] }],
      tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript tool orchestration.' }]
    })
  })

  assert.strictEqual(rejectedExecResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 2)
  const emulatedExecStream = await rejectedExecResponse.text()
  const execDiagnostic = proxyDiagnostics.at(-1)

  assert.ok(emulatedExecStream.includes('response.custom_tool_call_input.done'))
  assert.ok(emulatedExecStream.includes('tools.shell_command'))
  assert.ok(emulatedExecStream.includes('Start-Process calc.exe'))
  assert.strictEqual(execDiagnostic.toolTransport, 'prompt-emulated')
  assert.strictEqual(execDiagnostic.emulation.toolCallName, 'exec')
  assert.strictEqual(execDiagnostic.emulation.toolCallUsesShellCommand, true)
  assert.strictEqual(execDiagnostic.emulation.toolCallMentionsCalculator, true)
  upstreamRequests.length = 0
  const nativeResponsesResponse = await fetch(`${proxy.baseUrl}/v1/test-channel/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-native-responses-test',
      stream: true,
      input: [
        {
          id: 'fc_53e2893f954b40c8af50100324613d7c',
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_cross_model_native',
          input: 'text("cross-model")'
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_cross_model_native',
          output: 'cross-model'
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use native responses.' }] }
      ]
    })
  })
  const nativeResponsesText = await nativeResponsesResponse.text()

  assert.strictEqual(nativeResponsesResponse.status, 200)
  assert.strictEqual(upstreamRequests.length, 1)
  assert.strictEqual(upstreamRequests[0].url, '/v1/responses')
  assert.strictEqual(upstreamRequests[0].body.input[0].id, 'ctc_53e2893f954b40c8af50100324613d7c')
  assert.strictEqual(upstreamRequests[0].body.input[0].call_id, 'call_cross_model_native')
  assert.ok(nativeResponsesText.includes('response.completed'))
  upstreamRequests.length = 0

  const child = spawn(
    codexPath,
    [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--json',
      '-m',
      aliasFor('grok-4.5'),
      '-c',
      'model_provider="openai"',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      `model_catalog_json=${JSON.stringify(modelCatalogPath)}`,
      '-c',
      `openai_base_url=${JSON.stringify(`${proxy.baseUrl}/v1/test-channel`)}`,
      '-c',
      'features.plugins=false',
      '-c',
      'features.remote_plugin=false',
      '-c',
      'features.plugin_sharing=false',
      'Reply with OK.'
    ],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, CODEX_HOME: wireCodexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  let stdout = ''
  let stderr = ''
  mark('codex-exec')

  child.stdin.end()
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8')
  })

  const timeout = setTimeout(() => child.kill(), 90000)
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })

  clearTimeout(timeout)
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
  mark('close-servers')
  await close(proxy.server)
  await close(upstream)
  await new Promise(resolve => setImmediate(resolve))
  await removeTemporaryPaths([wireCodexHome, modelCatalogPath])

  assert.strictEqual(exitCode, 0, `Codex 退出码 ${exitCode}: ${stderr.slice(0, 1000)}\n${stdout.slice(0, 1000)}`)
  assert.strictEqual(upstreamRequests.length, 2)
  assert.ok(upstreamRequests.every(request => request.url === '/v1/chat/completions'))
  assert.strictEqual(upstreamRequests[0].body.model, 'grok-4.5')
  assert.strictEqual(upstreamRequests[0].body.reasoning_effort, 'high')
  assert.strictEqual(upstreamRequests[0].body.stream, true)
  assert.ok(
    upstreamRequests[0].body.messages.some(
      message => message.role === 'user' && message.content.includes('Reply with OK.')
    )
  )
  assert.ok(Array.isArray(upstreamRequests[0].body.tools))
  assert.ok(
    upstreamRequests[0].body.tools.some(tool => /^(exec|shell_command)$/i.test(String(tool.function?.name || '')))
  )
  assert.ok(
    upstreamRequests[1].body.messages.some(
      message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_proxy_test'
    )
  )
  assert.ok(
    upstreamRequests[1].body.messages.some(
      message =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_proxy_test' &&
        message.content.includes('proxy-tool-ok')
    ),
    JSON.stringify(upstreamRequests[1].body.messages)
  )
  assert.ok(stdout.includes('OK'))
  mark('assertions-passed')
  clearTimeout(watchdog)
  console.log('responses to chat completions proxy test passed')
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
