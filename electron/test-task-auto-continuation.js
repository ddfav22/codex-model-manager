const assert = require('assert')

const {
  AUTO_CONTINUATION_PROMPT,
  AUTO_CONTINUATION_CANCELLED,
  DEFAULT_IDLE_ATTEMPTS,
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

function toolCall(turnId, capturedAt = '2026-08-07T06:29:33.093Z') {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: turnId,
    capturedAt,
    outcome: 'upstream_accepted',
    taskTermination: {
      terminal: true,
      status: 'completed',
      kind: 'tool_call',
      shouldContinue: false,
      normalCompletion: false,
      observedBytes: 183541
    }
  }
}

function transportFailure(turnId) {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: turnId,
    capturedAt: '2026-08-07T06:21:40.246Z',
    outcome: 'proxy_error',
    diagnosticKind: 'proxy_transport_error',
    transportFailureKind: 'network_error'
  }
}

async function main() {
  assert.strictEqual(AUTO_CONTINUATION_PROMPT, '继续')
  assert.strictEqual(MAX_AUTO_CONTINUATIONS, 3)
  assert.strictEqual(DEFAULT_IDLE_ATTEMPTS, 150)
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

  const watchedStarts = []
  const watchEvents = []
  const watchSupervisor = createTaskAutoContinuationSupervisor({
    watchGraceMs: 0,
    delay: async () => {},
    onEvent: event => watchEvents.push(event),
    startContinuation: async request => {
      watchedStarts.push(request)
      return { mode: 'desktop-app-server', turnId: TURN_IDS[1] }
    }
  })
  const blockedTool = await watchSupervisor.handleDiagnostic(toolCall(TURN_IDS[0]))

  assert.strictEqual(blockedTool.action, 'started')
  assert.strictEqual(watchedStarts[0].terminationKind, 'blocked_tool_call')
  assert.strictEqual(
    watchEvents.some(event => event.type === 'watching'),
    true
  )

  const transportStarts = []
  const transportSupervisor = createTaskAutoContinuationSupervisor({
    watchGraceMs: 0,
    delay: async () => {},
    startContinuation: async request => {
      transportStarts.push(request)
      return { mode: 'desktop-app-server', turnId: TURN_IDS[1] }
    }
  })
  assert.strictEqual((await transportSupervisor.handleDiagnostic(transportFailure(TURN_IDS[0]))).action, 'started')
  assert.strictEqual(transportStarts[0].terminationKind, 'transport_interrupted')
  assert.strictEqual(
    (
      await transportSupervisor.handleDiagnostic({
        codexThreadId: THREAD_ID,
        codexTurnId: TURN_IDS[2],
        outcome: 'client_cancelled',
        diagnosticKind: 'client_cancelled',
        transportFailureKind: 'client_request_aborted'
      })
    ).action,
    'observed'
  )

  let releaseWatch
  const watchDelay = new Promise(resolve => {
    releaseWatch = resolve
  })
  let cancelledWatchStarts = 0
  const cancellationEvents = []
  const cancellationSupervisor = createTaskAutoContinuationSupervisor({
    watchGraceMs: 1,
    delay: async () => watchDelay,
    onEvent: event => cancellationEvents.push(event),
    startContinuation: async () => {
      cancelledWatchStarts += 1
      return { mode: 'desktop-app-server', turnId: TURN_IDS[1] }
    }
  })
  const cancelledWatch = cancellationSupervisor.handleDiagnostic(toolCall(TURN_IDS[0]))

  await Promise.resolve()
  await cancellationSupervisor.handleDiagnostic(normalCompletion(TURN_IDS[0]))
  releaseWatch()
  assert.deepStrictEqual(await cancelledWatch, { action: 'ignored', reason: 'progress-resumed' })
  assert.strictEqual(cancelledWatchStarts, 0)
  assert.strictEqual(
    cancellationEvents.some(event => event.type === 'watchCancelled'),
    true
  )

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

  const idleAbort = new AbortController()
  let releaseIdleDelay
  const idleDelay = new Promise(resolve => {
    releaseIdleDelay = resolve
  })
  const abortedInspection = waitForTaskIdle(
    THREAD_ID,
    async () => {
      throw new Error('这个任务仍在运行')
    },
    { signal: idleAbort.signal, idleAttempts: 3, delay: async () => idleDelay }
  )

  await Promise.resolve()
  idleAbort.abort(new Error('new response arrived'))
  releaseIdleDelay()
  await assert.rejects(abortedInspection, error => error?.code === AUTO_CONTINUATION_CANCELLED)

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
