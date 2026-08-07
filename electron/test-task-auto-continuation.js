const assert = require('assert')

const {
  AUTO_CONTINUATION_PROMPT,
  MAX_AUTO_CONTINUATIONS,
  createTaskAutoContinuationSupervisor,
  desktopProxyUnavailable,
  startVisibleTaskContinuation,
  waitForTaskIdle
} = require('./features/taskAutoContinuation')

const THREAD_ID = '019fd644-3128-7d70-9f84-b95bec943f21'
const TURN_IDS = [
  '019fda49-48f3-7382-872f-e51aaa190525',
  '019fda49-48f3-7382-872f-e51aaa190526',
  '019fda49-48f3-7382-872f-e51aaa190527',
  '019fda49-48f3-7382-872f-e51aaa190528',
  '019fda49-48f3-7382-872f-e51aaa190529'
]

function termination(turnId, kind = 'refusal') {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: turnId,
    outcome: 'upstream_accepted',
    taskTermination: {
      terminal: true,
      status: 'completed',
      kind,
      shouldContinue: true,
      normalCompletion: false
    }
  }
}

function normalCompletion(turnId) {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: turnId,
    outcome: 'upstream_accepted',
    taskTermination: {
      terminal: true,
      status: 'completed',
      kind: 'normal',
      shouldContinue: false,
      normalCompletion: true
    }
  }
}

async function main() {
  assert.strictEqual(AUTO_CONTINUATION_PROMPT, '继续')
  assert.strictEqual(MAX_AUTO_CONTINUATIONS, 3)
  assert.strictEqual(desktopProxyUnavailable(new Error('failed to connect to control socket')), true)
  assert.strictEqual(desktopProxyUnavailable(new Error('permission denied by policy')), false)

  const events = []
  const starts = []
  const supervisor = createTaskAutoContinuationSupervisor({
    onEvent: event => events.push(event),
    startContinuation: async request => {
      starts.push(request)
      return { mode: 'desktop-app-server', turnId: TURN_IDS[starts.length] }
    }
  })

  for (let index = 0; index < 3; index += 1) {
    const result = await supervisor.handleDiagnostic(termination(TURN_IDS[index]))

    assert.strictEqual(result.action, 'started')
    assert.strictEqual(result.attempt, index + 1)
    assert.strictEqual(starts[index].prompt, '继续')
    assert.strictEqual(starts[index].attempt, index + 1)
  }
  const exhausted = await supervisor.handleDiagnostic(termination(TURN_IDS[3]))

  assert.deepStrictEqual(exhausted, { action: 'exhausted', attempts: 3 })
  assert.strictEqual(starts.length, 3)
  assert.strictEqual(events.filter(event => event.type === 'started').length, 3)
  assert.strictEqual(events.filter(event => event.type === 'exhausted').length, 1)
  assert.strictEqual((await supervisor.handleDiagnostic(termination(TURN_IDS[3]))).reason, 'duplicate-termination')

  await supervisor.handleDiagnostic(normalCompletion(TURN_IDS[3]))
  assert.strictEqual(supervisor.getState(THREAD_ID), null)
  const restarted = await supervisor.handleDiagnostic(termination(TURN_IDS[4], 'empty'))

  assert.strictEqual(restarted.attempt, 1)
  assert.strictEqual(starts.length, 4)

  const manualStarts = []
  const manualSupervisor = createTaskAutoContinuationSupervisor({
    startContinuation: async request => {
      manualStarts.push(request)
      return { mode: 'desktop-app-server', turnId: TURN_IDS[1] }
    }
  })

  await manualSupervisor.handleDiagnostic(termination(TURN_IDS[0]))
  const manualTurnResult = await manualSupervisor.handleDiagnostic(termination(TURN_IDS[4]))

  assert.strictEqual(manualTurnResult.attempt, 1)
  assert.strictEqual(manualStarts.length, 2)

  let releasePending
  const pending = new Promise(resolve => {
    releasePending = resolve
  })
  let pendingStarts = 0
  const pendingSupervisor = createTaskAutoContinuationSupervisor({
    startContinuation: async () => {
      pendingStarts += 1
      await pending
      return { mode: 'exec-resume', turnId: '' }
    }
  })
  const firstPending = pendingSupervisor.handleDiagnostic(termination(TURN_IDS[0]))
  const secondPending = pendingSupervisor.handleDiagnostic(termination(TURN_IDS[0]))

  assert.strictEqual(pendingStarts, 0)
  releasePending()
  assert.strictEqual((await firstPending).action, 'started')
  assert.strictEqual((await secondPending).action, 'started')
  assert.strictEqual(pendingStarts, 1)

  const failureEvents = []
  const failedSupervisor = createTaskAutoContinuationSupervisor({
    onEvent: event => failureEvents.push(event),
    startContinuation: async () => {
      throw Object.assign(new Error('cannot start'), { code: 'ESTART' })
    }
  })
  const failed = await failedSupervisor.handleDiagnostic(termination(TURN_IDS[0]))

  assert.strictEqual(failed.action, 'failed')
  assert.strictEqual(failedSupervisor.getState(THREAD_ID).attempts, 0)
  assert.strictEqual(failureEvents.at(-1).errorCode, 'ESTART')

  let inspectionAttempts = 0
  const inspection = await waitForTaskIdle(
    THREAD_ID,
    async () => {
      inspectionAttempts += 1
      if (inspectionAttempts < 3) throw new Error('这个任务仍在运行')
      return { codexPath: 'codex.exe', cwd: 'C:\\work' }
    },
    { idleAttempts: 3, idleDelayMs: 1, delay: async () => {} }
  )

  assert.strictEqual(inspection.cwd, 'C:\\work')
  assert.strictEqual(inspectionAttempts, 3)

  const desktopCalls = []
  const visible = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    prompt: '继续',
    inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
    runDesktopRequest: async request => {
      desktopCalls.push(request)
      return { result: { turn: { id: TURN_IDS[1] } } }
    },
    startFallback: () => {
      throw new Error('fallback must not run')
    }
  })

  assert.deepStrictEqual(visible, { mode: 'desktop-app-server', turnId: TURN_IDS[1] })
  assert.deepStrictEqual(desktopCalls[0].input, [{ type: 'text', text: '继续' }])

  let fallbackRequest
  const fallback = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
    runDesktopRequest: async () => {
      throw new Error('failed to connect to control socket')
    },
    startFallback: request => {
      fallbackRequest = request
      return { completion: Promise.resolve({ ok: true }) }
    }
  })

  assert.deepStrictEqual(fallback, { mode: 'exec-resume', turnId: '' })
  assert.strictEqual(fallbackRequest.prompt, '继续')
  assert.strictEqual(fallbackRequest.threadId, THREAD_ID)

  await assert.rejects(
    startVisibleTaskContinuation({
      threadId: THREAD_ID,
      inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
      runDesktopRequest: async () => {
        throw new Error('permission denied by policy')
      },
      startFallback: () => ({ completion: Promise.resolve() })
    }),
    /permission denied/
  )

  console.log('task auto-continuation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
