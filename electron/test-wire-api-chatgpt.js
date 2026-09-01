/*
 * Local protocol-wire regression tests.
 *
 * The test server below is deliberately in-process and uses a fake API key.
 * It exercises the same Responses endpoint that Codex uses, but never reaches
 * a real provider or reads a user credential file.
 */
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { modelAdapterProfile } = require('./features/modelAdapters')
const { DEFAULT_IMAGE_MODEL } = require('./protocol/newApiImageGeneration')
const {
  createProtocolProxy,
  endpointCompatibilityFailure,
  inferredWireApiForModel,
  responsesRequestToChat,
  wireApiForModel
} = require('./protocolProxy')

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0YAAAAASUVORK5CYII='

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  if (!server) return Promise.resolve()

  return new Promise(resolve => {
    server.close(() => resolve())
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
  })
}

async function readRequestBody(request) {
  const chunks = []

  for await (const chunk of request) chunks.push(Buffer.from(chunk))

  const text = Buffer.concat(chunks).toString('utf8')

  if (!text) return {}

  return JSON.parse(text)
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function responseMessage(model, text) {
  return {
    id: 'resp-native-1',
    object: 'response',
    status: 'completed',
    model,
    output: [
      {
        id: 'msg-native-1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    ]
  }
}

async function main() {
  const requests = []
  const diagnostics = []
  let retryableServerAttempts = 0
  let terminalServerAttempts = 0
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-wire-test-'))
  const upstream = http.createServer(async (request, response) => {
    let body = {}

    try {
      body = await readRequestBody(request)
    } catch {
      json(response, 400, { error: { message: 'invalid json' } })
      return
    }

    requests.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.authorization || ''
    })

    if (request.method !== 'POST') {
      json(response, 405, { error: { message: 'method not allowed' } })
      return
    }

    if (request.url === '/v1/images/generations') {
      if (body.model !== DEFAULT_IMAGE_MODEL) {
        json(response, 400, { error: { message: `unexpected image model ${body.model}` } })
        return
      }
      json(response, 200, { created: 1700000000, data: [{ b64_json: PNG_BASE64 }] })
      return
    }

    if (request.url === '/v1/responses') {
      const inputText = JSON.stringify(body.input || [])

      if (inputText.includes('trigger-native-retry')) {
        retryableServerAttempts += 1
        if (retryableServerAttempts === 1) {
          response.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'x-request-id': 'retry-first-SECRET body'
          })
          response.end(JSON.stringify({ error: { message: 'first failure body must stay private' } }))
          return
        }
        response.setHeader('x-request-id', 'retry/second?safe id')
      }

      if (inputText.includes('trigger-native-error')) {
        terminalServerAttempts += 1
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'x-request-id': 'terminal/SECRET id'
        })
        response.end(JSON.stringify({ error: { message: 'terminal failure body must stay private' } }))
        return
      }

      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'native stream' })}\n\n`)
        if (!inputText.includes('trigger-native-incomplete')) {
          response.write(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: responseMessage(body.model, 'native stream')
            })}\n\n`
          )
        }
        response.end()
        return
      }

      json(response, 200, responseMessage(body.model, 'native response'))
      return
    }

    if (request.url === '/v1/chat/completions') {
      const inputText = JSON.stringify(body.messages || [])

      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache'
        })
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'chat stream' }, finish_reason: null }]
          })}\n\n`
        )
        if (!inputText.includes('trigger-chat-incomplete')) response.end('data: [DONE]\n\n')
        else response.end()
        return
      }

      if (inputText.includes('trigger-tool')) {
        json(response, 200, {
          id: 'chatcmpl-tool',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_exec_1',
                    type: 'function',
                    function: { name: 'exec', arguments: '{"input":"echo wire"}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        })
        return
      }

      json(response, 200, {
        id: 'chatcmpl-plain',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'chat response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      })
      return
    }

    json(response, 404, { error: { message: 'route not found' } })
  })
  const upstreamAddress = await listen(upstream)
  const baseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`
  const responsesModel = 'gpt-compat-responses'
  const chatModel = 'gpt-compat-chat'
  const channel = {
    id: 'chatgpt-wire-test',
    baseUrl,
    apiKey: 'test-key-chatgpt-only',
    models: [responsesModel, chatModel],
    modelWireApis: { [responsesModel]: 'responses', [chatModel]: 'chat' },
    modelCapabilities: {
      [responsesModel]: modelAdapterProfile(responsesModel),
      [chatModel]: modelAdapterProfile(chatModel, { wireApi: 'chat' })
    },
    imageGeneration: {
      baseUrl,
      apiKey: 'test-key-chatgpt-only',
      defaultModel: DEFAULT_IMAGE_MODEL,
      candidates: [{ baseUrl, apiKey: 'test-key-chatgpt-only', defaultModel: DEFAULT_IMAGE_MODEL }]
    }
  }

  const proxy = await createProtocolProxy({
    resolveChannel: id => (id === channel.id ? channel : null),
    accessToken: 'test-wire-chatgpt-token-1234',
    generatedImagesRoot: path.join(temporaryRoot, 'generated-images'),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic)
  })

  const endpoint = `${proxy.baseUrl}/v1/${encodeURIComponent(channel.id)}`

  try {
    // Static routing must be ChatGPT/OpenAI-only; unknown provider IDs do not
    // receive a guessed wire API.
    assert.strictEqual(inferredWireApiForModel(responsesModel), 'responses')
    assert.strictEqual(inferredWireApiForModel('legacy-provider-model'), '')
    assert.strictEqual(wireApiForModel(channel, chatModel), 'chat')
    assert.strictEqual(endpointCompatibilityFailure(404, 'responses endpoint not found'), true)
    assert.strictEqual(endpointCompatibilityFailure(429, 'rate limited'), false)

    const modelsResponse = await fetch(`${endpoint}/models`)
    const modelsPayload = await modelsResponse.json()
    assert.strictEqual(modelsResponse.status, 200)
    assert.deepStrictEqual(
      modelsPayload.data.map(item => item.id),
      [responsesModel, chatModel]
    )
    assert.strictEqual(requests.length, 0)

    const nativeResponse = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: responsesModel,
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello native' }] }]
      })
    })
    const nativePayload = await nativeResponse.json()
    assert.strictEqual(nativeResponse.status, 200)
    assert.strictEqual(nativePayload.status, 'completed')
    assert.strictEqual(nativePayload.output[0].content[0].text, 'native response')
    assert.strictEqual(requests.at(-1).url, '/v1/responses')
    assert.strictEqual(requests.at(-1).authorization, 'Bearer test-key-chatgpt-only')

    const nativeStream = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: responsesModel,
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native stream' }] }]
      })
    })
    const nativeStreamText = await nativeStream.text()
    assert.strictEqual(nativeStream.status, 200)
    assert.match(nativeStreamText, /response\.output_text\.delta/)
    assert.match(nativeStreamText, /response\.completed/)

    const chatResponse = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        stream: false,
        reasoning: { effort: 'high' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello chat' }] }]
      })
    })
    const chatPayload = await chatResponse.json()
    assert.strictEqual(chatResponse.status, 200)
    assert.strictEqual(chatPayload.status, 'completed')
    assert.strictEqual(chatPayload.output[0].content[0].text, 'chat response')
    const chatRequest = requests.find(item => item.url === '/v1/chat/completions' && item.body.stream === false)
    assert.ok(chatRequest)
    assert.strictEqual(chatRequest.body.model, chatModel)
    assert.strictEqual(chatRequest.body.reasoning_effort, 'high')

    const toolResponse = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trigger-tool' }] }],
        tools: [
          {
            type: 'function',
            name: 'exec',
            description: 'Run a local command.',
            parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
          }
        ]
      })
    })
    const toolPayload = await toolResponse.json()
    assert.strictEqual(toolResponse.status, 200)
    assert.strictEqual(toolPayload.status, 'completed')
    assert.strictEqual(toolPayload.output[0].type, 'function_call')
    assert.strictEqual(toolPayload.output[0].name, 'exec')
    assert.deepStrictEqual(JSON.parse(toolPayload.output[0].arguments), { input: 'echo wire' })
    const toolRequest = requests.find(item => item.url === '/v1/chat/completions' && item.body.tools)
    assert.ok(toolRequest)
    assert.strictEqual(toolRequest.body.tools[0].function.name, 'exec')

    const history = responsesRequestToChat({
      model: chatModel,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"input":"echo one"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'one' }
      ],
      tools: [{ type: 'function', name: 'exec', parameters: { type: 'object', properties: {} } }]
    })
    assert.ok(history.request.messages.some(message => message.role === 'assistant' && message.tool_calls))
    assert.ok(history.request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_1'))

    const incompleteStream = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trigger-chat-incomplete' }] }]
      })
    })
    const incompleteText = await incompleteStream.text()
    assert.strictEqual(incompleteStream.status, 200)
    assert.match(incompleteText, /response\.incomplete/)
    assert.match(incompleteText, /upstream_stream_ended/)

    const retryResponse = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: responsesModel,
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trigger-native-retry' }] }]
      })
    })
    const retryPayload = await retryResponse.json()
    assert.strictEqual(retryResponse.status, 200)
    assert.strictEqual(retryPayload.status, 'completed')
    assert.strictEqual(retryableServerAttempts, 2)
    assert.strictEqual(diagnostics.at(-1).upstreamRetryCount, 1)
    assert.strictEqual(diagnostics.at(-1).upstreamRequestId, 'retry/secondsafeid')
    assert.doesNotMatch(JSON.stringify(diagnostics.at(-1)), /SECRET|private|body/)

    const providerFailure = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: responsesModel,
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trigger-native-error' }] }]
      })
    })
    const providerFailurePayload = await providerFailure.json()
    assert.strictEqual(providerFailure.status, 200)
    assert.strictEqual(providerFailurePayload.status, 'incomplete')
    assert.strictEqual(providerFailurePayload.error.type, 'upstream_server_error')
    assert.strictEqual(providerFailurePayload.incomplete_details.reason, 'upstream_server_error')
    assert.strictEqual(terminalServerAttempts, 2)
    assert.strictEqual(diagnostics.at(-1).upstreamRetryCount, 1)
    assert.strictEqual(diagnostics.at(-1).upstreamRequestId, 'terminal/SECRETid')
    assert.doesNotMatch(JSON.stringify(providerFailurePayload), /terminal failure body must stay private/)
    assert.strictEqual(diagnostics.at(-1).outcome, 'upstream_error')

    const imageResponse = await fetch(`${endpoint}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_IMAGE_MODEL, prompt: 'wire image', n: 1, size: '1024x1024' })
    })
    const imagePayload = await imageResponse.json()
    assert.strictEqual(imageResponse.status, 200)
    assert.strictEqual(imagePayload.data[0].b64_json, PNG_BASE64)
    const imageRequest = requests.find(item => item.url === '/v1/images/generations')
    assert.ok(imageRequest)
    assert.deepStrictEqual(imageRequest.body, {
      model: DEFAULT_IMAGE_MODEL,
      prompt: 'wire image',
      n: 1,
      size: '1024x1024'
    })

    const invalidImageResponse = await fetch(`${endpoint}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'legacy-image-model', prompt: 'must reject' })
    })
    const invalidImagePayload = await invalidImageResponse.json()
    assert.strictEqual(invalidImageResponse.status, 400)
    assert.match(invalidImagePayload.error.message, /仅支持 ChatGPT\/OpenAI 图片模型/)
    assert.strictEqual(requests.filter(item => item.url === '/v1/images/generations').length, 1)

    const diagnosticsResponse = await fetch(`${proxy.baseUrl}/diagnostics`)
    const diagnosticsPayload = await diagnosticsResponse.json()
    assert.strictEqual(diagnosticsResponse.status, 200)
    assert.strictEqual(diagnosticsPayload.ok, true)
    assert.ok(diagnosticsPayload.lastDiagnostic)

    const unsupportedModelResponse = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'legacy-provider-model',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'reject' }] }]
      })
    })
    const unsupportedPayload = await unsupportedModelResponse.json()
    assert.strictEqual(unsupportedModelResponse.status, 422)
    assert.strictEqual(unsupportedPayload.error.type, 'model_adapter_unavailable')
  } finally {
    await close(proxy.server)
    await close(upstream)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }

  console.log('ChatGPT-only wire API tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
