const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const manager = require('./codexManager')
const { createProtocolProxy } = require('./protocolProxy')

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

async function main() {
  const configuredChannels = manager.readStatus().providers.filter(provider => provider.managed)
  const channelId =
    process.env.CODEX_MM_LIVE_CHANNEL ||
    configuredChannels.find(provider => provider.active)?.id ||
    configuredChannels[0]?.id ||
    ''
  const model = process.env.CODEX_MM_LIVE_MODEL || 'grok-4.5'
  const toolTest = process.env.CODEX_MM_LIVE_TOOL_TEST === '1'
  const expectedText = process.env.CODEX_MM_LIVE_EXPECT || 'PROXY_OK'
  const prompt =
    process.env.CODEX_MM_LIVE_PROMPT ||
    (toolTest
      ? 'Use the shell tool to run exactly: Write-Output PROXY_OK_TOOL. Then reply exactly PROXY_OK_TOOL.'
      : 'Reply with exactly PROXY_OK and do not call tools.')
  const codexPath = findCodexExecutable(path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'))

  if (!codexPath) throw new Error('没有找到 ChatGPT 客户端附带的 codex.exe')
  if (!channelId) {
    console.log('live proxy test skipped: 本机未配置在线渠道；协议与 Codex 实机测试由 test:wire 覆盖')
    return
  }

  const diagnostics = []
  const proxy = await createProtocolProxy({
    port: 0,
    resolveChannel: id => manager.getRelayRuntime(id),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic)
  })
  const provider = `{name="Live Proxy Test",base_url="${proxy.baseUrl}/v1/${encodeURIComponent(channelId)}",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`
  const child = spawn(
    codexPath,
    [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--json',
      '-m',
      model,
      '-c',
      'model_provider="live-proxy"',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-c',
      `model_providers.live-proxy=${provider}`,
      prompt
    ],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  let stdout = ''
  let stderr = ''

  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8')
  })

  const timeout = setTimeout(() => {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        child.kill()
      }
    } else {
      child.kill('SIGKILL')
    }
  }, 120000)
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })

  clearTimeout(timeout)
  await new Promise(resolve => proxy.server.close(resolve))
  assert.strictEqual(
    exitCode,
    0,
    `在线代理测试失败：${stderr.slice(0, 1500)}\n${stdout.slice(-1500)}\n` +
      `diagnostic=${JSON.stringify(diagnostics.at(-1) || null)}`
  )
  assert.ok(stdout.includes(expectedText), `在线代理没有返回预期文本：${stdout.slice(-1500)}`)
  if (toolTest) assert.match(stdout, /"type":"command_execution"/)
  console.log(`live ${model} ${toolTest ? 'tool' : 'chat'} proxy test passed`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
