const assert = require('assert')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

const { createTaskAutoContinuationRuntime } = require('./features/taskAutoContinuationRuntime')
const { startCodexExecRecovery } = require('./features/taskRecovery')

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
  const recoveryChild = new EventEmitter()

  recoveryChild.stdout = new PassThrough()
  recoveryChild.stderr = new PassThrough()
  recoveryChild.stdin = new PassThrough()
  recoveryChild.killed = false
  recoveryChild.kill = () => {
    recoveryChild.killed = true
  }
  const recovery = startCodexExecRecovery({
    taskId: THREAD_ID,
    codexPath: 'codex.exe',
    cwd: 'C:\\codex-home',
    startupTimeoutMs: 1000,
    timeoutMs: 2000,
    spawnProcess: () => recoveryChild
  })

  recoveryChild.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`)
  const recoveryStarted = await recovery.started

  assert.strictEqual(recoveryStarted.ok, true)
  assert.strictEqual(recoveryStarted.turnStarted, true)
  recoveryChild.emit('exit', 0, null)
  assert.strictEqual((await recovery.completion).ok, true)

  const failedRecoveryChild = new EventEmitter()

  failedRecoveryChild.stdout = new PassThrough()
  failedRecoveryChild.stderr = new PassThrough()
  failedRecoveryChild.stdin = new PassThrough()
  failedRecoveryChild.killed = false
  failedRecoveryChild.kill = () => {
    failedRecoveryChild.killed = true
  }
  const failedRecovery = startCodexExecRecovery({
    taskId: THREAD_ID,
    codexPath: 'codex.exe',
    cwd: 'C:\\codex-home',
    startupTimeoutMs: 1000,
    timeoutMs: 2000,
    spawnProcess: () => failedRecoveryChild
  })

  failedRecoveryChild.stderr.write('resume session not found')
  failedRecoveryChild.emit('exit', 1, null)
  const failedRecoveryStartup = await failedRecovery.started

  assert.strictEqual(failedRecoveryStartup.ok, false)
  assert.strictEqual(failedRecoveryStartup.turnStarted, false)
  assert.strictEqual(failedRecoveryStartup.failureCategory, 'session')

  const timedOutRecoveryChild = new EventEmitter()

  timedOutRecoveryChild.stdout = new PassThrough()
  timedOutRecoveryChild.stderr = new PassThrough()
  timedOutRecoveryChild.stdin = new PassThrough()
  timedOutRecoveryChild.killed = false
  timedOutRecoveryChild.kill = () => {
    timedOutRecoveryChild.killed = true
  }
  const timedOutRecovery = startCodexExecRecovery({
    taskId: THREAD_ID,
    codexPath: 'codex.exe',
    cwd: 'C:\\codex-home',
    startupTimeoutMs: 25,
    timeoutMs: 2000,
    spawnProcess: () => timedOutRecoveryChild
  })
  const timedOutRecoveryStartup = await timedOutRecovery.started

  assert.strictEqual(timedOutRecoveryStartup.ok, false)
  assert.strictEqual(timedOutRecoveryStartup.timedOut, true)
  assert.strictEqual(timedOutRecoveryStartup.failureCategory, 'network')
  assert.strictEqual(timedOutRecoveryChild.killed, true)

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
      return { completion: Promise.resolve({ ok: true, turnStarted: true, workStarted: false }) }
    }
  })
  const resumed = await fallbackRuntime.handleDiagnostic(toolTermination())

  assert.strictEqual(resumed.action, 'started')
  assert.strictEqual(resumed.mode, 'exec-resume')
  assert.strictEqual(fallbackCalls.length, 1)
  assert.strictEqual(fallbackCalls[0].taskId, THREAD_ID)
  assert.strictEqual(fallbackCalls[0].prompt, '继续')

  const fallbackFailureLogs = []
  let fallbackFailureStartCount = 0
  const fallbackFailureRuntime = createTaskAutoContinuationRuntime({
    manager: {
      getPaths: manager.getPaths,
      resolveCodexContinuationTarget: () => ({ codexPath: 'codex.exe', cwd: 'C:\\codex-home' }),
      runCodexAppServerRequest: async () => {
        throw Object.assign(new Error('control socket closed'), { code: 'EPIPE' })
      }
    },
    logEvent: (level, event, details) => fallbackFailureLogs.push({ level, event, details }),
    startRecovery: () => {
      fallbackFailureStartCount += 1
      return {
        started: Promise.resolve({
          ok: false,
          turnStarted: false,
          workStarted: false,
          failureCategory: 'session',
          exitCode: 1
        }),
        completion: Promise.resolve({
          ok: false,
          turnStarted: false,
          workStarted: false,
          failureCategory: 'session',
          exitCode: 1
        })
      }
    }
  })
  const fallbackFailed = await fallbackFailureRuntime.handleDiagnostic(toolTermination())

  assert.strictEqual(fallbackFailed.action, 'failed')
  assert.strictEqual(fallbackFailureLogs.at(-1).event, 'task.autoContinue.failed')
  assert.strictEqual(fallbackFailureLogs.at(-1).details.errorCode, 'ECODEXRESUME')
  assert.strictEqual(fallbackFailureLogs.at(-1).details.errorPhase, 'exec-resume')
  assert.strictEqual(fallbackFailureStartCount, 3)

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
