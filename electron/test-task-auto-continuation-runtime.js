const assert = require('assert')

const { createTaskAutoContinuationRuntime } = require('./features/taskAutoContinuationRuntime')

const THREAD_ID = '019fd644-3128-7d70-9f84-b95bec943f21'
const TURN_ID = '019fdb85-dc30-7c50-bae1-c776c584b5d8'
const NEXT_TURN_ID = '019fdb85-dc30-7c50-bae1-c776c584b5d9'

function toolTermination() {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: TURN_ID,
    outcome: 'upstream_accepted',
    taskTermination: {
      terminal: true,
      kind: 'tool_call',
      shouldContinue: false,
      normalCompletion: false
    }
  }
}

async function main() {
  const calls = []
  const logs = []
  const manager = {
    getPaths: () => ({ codexHome: 'C:\\codex-home' }),
    resolveCodexContinuationTarget: options => {
      calls.push({ type: 'resolve', options })
      return { codexPath: 'C:\\Codex\\codex.exe', cwd: 'C:\\codex-home' }
    },
    runCodexAppServerRequest: async (codexPath, method, params, options) => {
      calls.push({ type: 'app-server', codexPath, method, params, options })
      return { result: {} }
    }
  }
  const runtime = createTaskAutoContinuationRuntime({
    manager,
    getRuntimeTargets: () => ['C:\\Codex\\ChatGPT.exe', 'C:\\Codex\\codex.exe'],
    logEvent: (level, event, details) => logs.push({ level, event, details }),
    startRecovery: () => {
      throw new Error('resume fallback must not run')
    }
  })
  const steered = await runtime.handleDiagnostic(toolTermination())

  assert.strictEqual(steered.action, 'started')
  assert.strictEqual(steered.mode, 'desktop-turn-steer')
  assert.deepStrictEqual(calls[0], {
    type: 'resolve',
    options: { codexTargets: ['C:\\Codex\\ChatGPT.exe', 'C:\\Codex\\codex.exe'] }
  })
  assert.strictEqual(calls[1].codexPath, 'C:\\Codex\\codex.exe')
  assert.strictEqual(calls[1].method, 'turn/steer')
  assert.deepStrictEqual(calls[1].params, {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: '继续' }],
    expectedTurnId: TURN_ID
  })
  assert.strictEqual(calls[1].options.cwd, 'C:\\codex-home')
  assert.strictEqual(calls[1].options.env.CODEX_HOME, 'C:\\codex-home')
  assert.strictEqual(calls[1].options.timeoutMs, 15000)
  assert.strictEqual(calls[1].options.connectDesktop, true)
  assert.strictEqual(logs.at(-1).event, 'task.autoContinue.started')
  assert.strictEqual(logs.at(-1).details.mode, 'desktop-turn-steer')

  const stateChangeCalls = []
  const stateChangeRuntime = createTaskAutoContinuationRuntime({
    manager: {
      getPaths: manager.getPaths,
      resolveCodexContinuationTarget: () => ({ codexPath: 'codex.exe', cwd: 'C:\\codex-home' }),
      runCodexAppServerRequest: async (_codexPath, method, params) => {
        stateChangeCalls.push({ method, params })
        if (method === 'turn/steer') throw new Error('no active turn for thread')
        return { result: { turn: { id: NEXT_TURN_ID } } }
      }
    },
    startRecovery: () => {
      throw new Error('resume fallback must not run')
    }
  })
  const started = await stateChangeRuntime.handleDiagnostic(toolTermination())

  assert.strictEqual(started.action, 'started')
  assert.strictEqual(started.mode, 'desktop-turn-start')
  assert.deepStrictEqual(
    stateChangeCalls.map(call => call.method),
    ['turn/steer', 'turn/start']
  )
  assert.deepStrictEqual(stateChangeCalls[1].params, {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: '继续' }]
  })

  const fallbackCalls = []
  const fallbackRuntime = createTaskAutoContinuationRuntime({
    manager: {
      getPaths: manager.getPaths,
      resolveCodexContinuationTarget: () => ({ codexPath: 'codex.exe', cwd: 'C:\\codex-home' }),
      runCodexAppServerRequest: async () => {
        throw Object.assign(new Error('control socket closed'), { code: 'EPIPE' })
      }
    },
    startRecovery: request => {
      fallbackCalls.push(request)
      return { completion: Promise.resolve({ ok: true }) }
    }
  })
  const resumed = await fallbackRuntime.handleDiagnostic(toolTermination())

  assert.strictEqual(resumed.action, 'started')
  assert.strictEqual(resumed.mode, 'exec-resume')
  assert.strictEqual(fallbackCalls.length, 1)
  assert.strictEqual(fallbackCalls[0].taskId, THREAD_ID)
  assert.strictEqual(fallbackCalls[0].prompt, '继续')

  const failureLogs = []
  const failedRuntime = createTaskAutoContinuationRuntime({
    manager: {
      getPaths: manager.getPaths,
      resolveCodexContinuationTarget: () => {
        throw new TypeError('bad cwd metadata')
      },
      runCodexAppServerRequest: async () => ({})
    },
    logEvent: (level, event, details) => failureLogs.push({ level, event, details }),
    startRecovery: () => ({ completion: Promise.resolve() })
  })
  const failed = await failedRuntime.handleDiagnostic(toolTermination())

  assert.strictEqual(failed.action, 'failed')
  assert.strictEqual(failureLogs.at(-1).event, 'task.autoContinue.failed')
  assert.strictEqual(failureLogs.at(-1).details.errorName, 'TypeError')
  assert.strictEqual(failureLogs.at(-1).details.errorPhase, 'resolve-target')
  assert.strictEqual(failureLogs.at(-1).details.errorMessage, 'bad cwd metadata')

  console.log('task auto-continuation runtime integration tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
