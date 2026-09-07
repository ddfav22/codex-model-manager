const assert = require('assert')
const http = require('http')
const manager = require('./codexManager')
const { readResponsesProbeText } = require('./protocol/probeStream')
const { readResponseTextLimited } = require('./protocol/upstreamRequest')
const { parseResponsesProbePayload } = require('./protocol/probeParsing')

function payload(output, status = 'completed') {
  return { object: 'response', model: 'gpt-6-astra', status, output }
}

function message(text) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
}

async function main() {
  let mode = 'healthy'
  let requests = []
  const server = http.createServer(async (request, response) => {
    const parts = []

    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())

    requests.push({ url: request.url, body })
    assert.strictEqual(body.model, 'gpt-6-astra')
    assert.deepStrictEqual(body.reasoning, { effort: 'low' })
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }

    if (mode === 'responses-unavailable') return json(503, { error: { message: 'responses unavailable' } })
    if (mode === 'stream-only' && !body.stream && !body.tools) return json(400, { error: { message: 'stream must be true' } })
    const hasResult = body.input.some(item => item.type === 'function_call_output')
    const tool = { type: 'function_call', call_id: 'probe_call', name: 'codex_local_tool_probe', arguments: '{"ack":"OK"}' }
    const output = hasResult ? [message('CODEX_TOOL_LOOP_OK')] : body.tools ? [tool] : [message('OK')]

    if (!body.stream || mode === 'json-only') return json(200, payload(output))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (mode === 'stream-failed' && !body.tools) {
      response.write(`data: ${JSON.stringify({ type: 'response.failed', response: payload([], 'failed') })}\n\n`)
      return // Deliberately keep the HTTP stream open after the terminal event.
    }
    if (mode === 'tool-truncated' && hasResult) {
      response.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'CODEX_TOOL_LOOP_OK' })}\n\n`)
      return
    }
    const frame = `data: ${JSON.stringify({ type: 'response.completed', response: payload(output) })}\n\n`

    // Split across a JSON token to exercise incremental decoding/framing.
    response.write(frame.slice(0, 25))
    setImmediate(() => response.write(frame.slice(25)))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const scenario of ['healthy', 'stream-only', 'json-only', 'stream-failed', 'tool-truncated']) {
      mode = scenario
      requests = []
      const result = await manager.testRelay({
        name: 'isolated Responses probe',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-only-fake-key',
        model: 'gpt-6-astra'
      }, { timeoutMs: 3000 })

      assert.strictEqual(result.chatOk, scenario !== 'stream-failed', `${scenario}: ${result.message}`)
      assert.strictEqual(result.ok, !['json-only', 'stream-failed'].includes(scenario), `${scenario}: ${result.message}`)
      assert.strictEqual(result.streamOk, !['json-only', 'stream-failed'].includes(scenario), scenario)
      assert.strictEqual(result.agentToolOk, scenario !== 'stream-failed', scenario)
      assert.ok(requests.every(item => item.url === '/v1/responses'), 'Responses success must not fall back to Chat')
      assert.strictEqual(requests[0].body.stream, true)
      assert.ok(requests.some(item => item.body.stream === true && !item.body.tools), 'streaming is independently tested')
    }

    mode = 'responses-unavailable'
    requests = []
    const unavailable = await manager.testRelay({
      name: 'Responses only failure',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'test-only-fake-key',
      model: 'gpt-6-astra',
      wireApi: 'chat'
    }, { timeoutMs: 3000 })

    assert.strictEqual(unavailable.ok, false)
    assert.strictEqual(unavailable.chatOk, false)
    assert.ok(requests.length >= 1)
    assert.ok(requests.every(item => item.url === '/v1/responses'), 'Astra must never probe Chat Completions')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }

  let cancelled = false
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65)) },
    cancel() { cancelled = true }
  }), { headers: { 'content-type': 'text/event-stream' } })

  await assert.rejects(readResponsesProbeText(oversized, readResponseTextLimited, 64), /64 字节限制/)
  assert.strictEqual(cancelled, true)
  const truncated = new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  })

  assert.strictEqual(parseResponsesProbePayload(await readResponsesProbeText(truncated, readResponseTextLimited)).completed, false)
  assert.strictEqual(parseResponsesProbePayload(JSON.stringify(payload([message('OK')], 'in_progress'))).completed, false)
  console.log('Responses probe regressions passed: 6 relay scenarios, size limit, truncated SSE, pending JSON')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
