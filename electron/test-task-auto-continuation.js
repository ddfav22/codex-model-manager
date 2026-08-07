const assert = require('assert')

const {
  AUTO_CONTINUATION_PROMPT,
  MAX_AUTO_CONTINUATIONS,
  createTaskAutoContinuationSupervisor,
  desktopProxyUnavailable,
  desktopTurnIsActive,
  desktopTurnNeedsStart,
  startVisibleTaskContinuation
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

function toolCall(turnId) {
  return {
    codexThreadId: THREAD_ID,
    codexTurnId: turnId,
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
    outcome: 'proxy_error',
    diagnosticKind: 'proxy_transport_error',
    transportFailureKind: 'network_error'
  }
}

async function main() {
  assert.strictEqual(AUTO_CONTINUATION_PROMPT, '继续')
  assert.strictEqual(MAX_AUTO_CONTINUATIONS, 3)
  assert.strictEqual(desktopProxyUnavailable(new Error('failed to connect to control socket')), true)
  assert.strictEqual(desktopProxyUnavailable(new Error('permission denied by policy')), false)
  assert.strictEqual(desktopTurnNeedsStart(new Error('no active turn for thread')), true)
  assert.strictEqual(desktopTurnNeedsStart(new Error('permission denied by policy')), false)
  assert.strictEqual(desktopTurnIsActive(new Error('active turn already running')), true)
  assert.strictEqual(desktopTurnIsActive(new Error('no active turn')), false)

  const events = []
  const starts = []
  const supervisor = createTaskAutoContinuationSupervisor({
    onEvent: event => events.push(event),
    startContinuation: async request => {
      starts.push(request)
      return { mode: 'desktop-turn-start', turnId: TURN_IDS[starts.length] }
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
      return { mode: 'desktop-turn-start', turnId: TURN_IDS[1] }
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
      throw Object.assign(new TypeError('cannot resolve continuation target; token=super-secret-token-value'), {
        code: 'ESTART',
        continuationPhase: 'resolve-target'
      })
    }
  })
  const failed = await failedSupervisor.handleDiagnostic(termination(TURN_IDS[0]))

  assert.strictEqual(failed.action, 'failed')
  assert.strictEqual(failedSupervisor.getState(THREAD_ID).attempts, 0)
  assert.strictEqual(failureEvents.at(-1).errorCode, 'ESTART')
  assert.strictEqual(failureEvents.at(-1).errorName, 'TypeError')
  assert.strictEqual(failureEvents.at(-1).errorPhase, 'resolve-target')
  assert.strictEqual(failureEvents.at(-1).errorMessage, 'cannot resolve continuation target; [redacted]')
  assert.strictEqual(failureEvents.at(-1).terminationKind, 'refusal')

  let legacyDelayCalled = false
  const directStarts = []
  const directSupervisor = createTaskAutoContinuationSupervisor({
    watchGraceMs: 60000,
    delay: async () => {
      legacyDelayCalled = true
    },
    startContinuation: async request => {
      directStarts.push(request)
      return { mode: 'desktop-turn-steer', turnId: request.sourceTurnId }
    }
  })
  const blockedTool = await directSupervisor.handleDiagnostic(toolCall(TURN_IDS[0]))

  assert.strictEqual(blockedTool.action, 'started')
  assert.strictEqual(directStarts[0].terminationKind, 'blocked_tool_call')
  assert.strictEqual(legacyDelayCalled, false)
  assert.strictEqual(directSupervisor.getState(THREAD_ID).watching, undefined)

  const transportStarts = []
  const transportSupervisor = createTaskAutoContinuationSupervisor({
    startContinuation: async request => {
      transportStarts.push(request)
      return { mode: 'desktop-turn-steer', turnId: request.sourceTurnId }
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

  let releaseDirect
  const directPending = new Promise(resolve => {
    releaseDirect = resolve
  })
  let uncancelledStarts = 0
  const uncancelledSupervisor = createTaskAutoContinuationSupervisor({
    startContinuation: async () => {
      uncancelledStarts += 1
      await directPending
      return { mode: 'desktop-turn-start', turnId: TURN_IDS[1] }
    }
  })
  const uncancelled = uncancelledSupervisor.handleDiagnostic(toolCall(TURN_IDS[0]))

  await Promise.resolve()
  await uncancelledSupervisor.handleDiagnostic(normalCompletion(TURN_IDS[0]))
  releaseDirect()
  assert.strictEqual((await uncancelled).action, 'started')
  assert.strictEqual(uncancelledStarts, 1)

  const inspectCalls = []
  const desktopStartCalls = []
  const visible = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    sourceTurnId: TURN_IDS[0],
    prompt: '继续',
    terminationKind: 'refusal',
    inspectTask: async (threadId, options) => {
      inspectCalls.push({ threadId, options })
      return { codexPath: 'codex.exe', cwd: 'C:\\work', runtimeStatus: 'idle' }
    },
    runDesktopRequest: async request => {
      desktopStartCalls.push(request)
      return { result: { turn: { id: TURN_IDS[1] } } }
    },
    runDesktopSteer: async () => {
      throw new Error('steer must not run for a completed refusal')
    },
    startFallback: () => {
      throw new Error('fallback must not run')
    }
  })

  assert.deepStrictEqual(visible, { mode: 'desktop-turn-start', turnId: TURN_IDS[1] })
  assert.deepStrictEqual(inspectCalls, [
    { threadId: THREAD_ID, options: { allowActive: true, skipRuntimeInspection: true } }
  ])
  assert.deepStrictEqual(desktopStartCalls[0].input, [{ type: 'text', text: '继续' }])

  const steerCalls = []
  const activeSteer = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    sourceTurnId: TURN_IDS[0],
    terminationKind: 'blocked_tool_call',
    inspectTask: async () => ({
      codexPath: 'codex.exe',
      cwd: 'C:\\work',
      runtimeStatus: 'active',
      lastTurnId: TURN_IDS[0]
    }),
    runDesktopRequest: async () => {
      throw new Error('turn/start must not run while the source turn is active')
    },
    runDesktopSteer: async request => {
      steerCalls.push(request)
      return { result: {} }
    },
    startFallback: () => {
      throw new Error('fallback must not run')
    }
  })

  assert.deepStrictEqual(activeSteer, { mode: 'desktop-turn-steer', turnId: TURN_IDS[0] })
  assert.strictEqual(steerCalls[0].expectedTurnId, TURN_IDS[0])
  assert.deepStrictEqual(steerCalls[0].input, [{ type: 'text', text: '继续' }])

  let startAfterIdleSteer = 0
  const steerThenStart = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    sourceTurnId: TURN_IDS[0],
    terminationKind: 'transport_interrupted',
    inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
    runDesktopSteer: async () => {
      throw new Error('no active turn for thread')
    },
    runDesktopRequest: async () => {
      startAfterIdleSteer += 1
      return { result: { turn: { id: TURN_IDS[1] } } }
    },
    startFallback: () => {
      throw new Error('fallback must not run')
    }
  })

  assert.deepStrictEqual(steerThenStart, { mode: 'desktop-turn-start', turnId: TURN_IDS[1] })
  assert.strictEqual(startAfterIdleSteer, 1)

  let steerAfterActiveStart = 0
  const startThenSteer = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    sourceTurnId: TURN_IDS[0],
    terminationKind: 'refusal',
    inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
    runDesktopRequest: async () => {
      throw new Error('active turn already running')
    },
    runDesktopSteer: async request => {
      steerAfterActiveStart += 1
      assert.strictEqual(request.expectedTurnId, TURN_IDS[0])
    },
    startFallback: () => {
      throw new Error('fallback must not run')
    }
  })

  assert.deepStrictEqual(startThenSteer, { mode: 'desktop-turn-steer', turnId: TURN_IDS[0] })
  assert.strictEqual(steerAfterActiveStart, 1)

  let fallbackRequest
  const fallback = await startVisibleTaskContinuation({
    threadId: THREAD_ID,
    sourceTurnId: TURN_IDS[0],
    inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
    runDesktopRequest: async () => {
      throw new Error('failed to connect to control socket')
    },
    runDesktopSteer: async () => {
      throw new Error('steer must not run')
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
      sourceTurnId: TURN_IDS[0],
      inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
      runDesktopRequest: async () => {
        throw new Error('permission denied by policy')
      },
      runDesktopSteer: async () => {
        throw new Error('steer must not run')
      },
      startFallback: () => ({ completion: Promise.resolve() })
    }),
    error => /permission denied/.test(error?.message) && error?.continuationPhase === 'turn-start'
  )

  await assert.rejects(
    startVisibleTaskContinuation({
      threadId: THREAD_ID,
      sourceTurnId: TURN_IDS[0],
      terminationKind: 'blocked_tool_call',
      inspectTask: async () => ({ codexPath: 'codex.exe', cwd: 'C:\\work' }),
      runDesktopRequest: async () => {
        throw new Error('start must not run')
      },
      runDesktopSteer: async () => {
        throw new Error('active_turn_not_steerable during review')
      },
      startFallback: () => ({ completion: Promise.resolve() })
    }),
    error => /active_turn_not_steerable/.test(error?.message) && error?.continuationPhase === 'turn-steer'
  )

  await assert.rejects(
    startVisibleTaskContinuation({
      threadId: THREAD_ID,
      sourceTurnId: TURN_IDS[0],
      inspectTask: async () => {
        throw new TypeError('session metadata is not iterable')
      },
      runDesktopRequest: async () => {},
      runDesktopSteer: async () => {},
      startFallback: () => ({ completion: Promise.resolve() })
    }),
    error => /session metadata/.test(error?.message) && error?.continuationPhase === 'resolve-target'
  )

  console.log('task auto-continuation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
