const { normalizeTaskId } = require('./taskRecovery')

const AUTO_CONTINUATION_PROMPT = '继续'
const MAX_AUTO_CONTINUATIONS = 3

function normalizedOptionalTaskId(value) {
  try {
    return normalizeTaskId(value)
  } catch {
    return ''
  }
}

function safeEvent(listener, event) {
  try {
    listener(event)
  } catch {
    // Logging and UI listeners must never break task supervision.
  }
}

function continuationCandidate(diagnostic) {
  const termination = diagnostic?.taskTermination
  const kind = String(termination?.kind || '')

  if (termination?.shouldContinue) return { kind: kind || 'terminated' }
  if (termination?.terminal && kind === 'tool_call') return { kind: 'blocked_tool_call' }
  if (
    diagnostic?.outcome === 'proxy_error' &&
    diagnostic?.diagnosticKind === 'proxy_transport_error' &&
    /^(?:network_error|upstream_timeout)$/.test(String(diagnostic?.transportFailureKind || ''))
  ) {
    return { kind: 'transport_interrupted' }
  }

  return null
}

function createTaskAutoContinuationSupervisor(options = {}) {
  const startContinuation = options.startContinuation
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const maxContinuations = Number(options.maxContinuations || MAX_AUTO_CONTINUATIONS)
  const chains = new Map()

  if (typeof startContinuation !== 'function') throw new Error('任务自动续接缺少启动器')
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 10) {
    throw new Error('任务自动续接次数无效')
  }

  const reset = (threadId, reason) => {
    const chain = chains.get(threadId)

    if (!chain) return
    chains.delete(threadId)
    safeEvent(onEvent, {
      type: 'reset',
      threadId,
      reason,
      attempts: chain.attempts,
      maxContinuations
    })
  }

  const ensureChain = threadId => {
    let chain = chains.get(threadId)

    if (!chain) {
      chain = {
        threadId,
        attempts: 0,
        pending: false,
        operation: null,
        expectedTurnId: '',
        acceptNextTurn: false,
        lastTriggerTurnId: ''
      }
      chains.set(threadId, chain)
    }

    return chain
  }

  const runContinuation = (chain, diagnostic, terminationKind) => {
    const threadId = chain.threadId
    const turnId = normalizedOptionalTaskId(diagnostic?.codexTurnId)

    if (chain.pending) return chain.operation || Promise.resolve({ action: 'pending' })
    if (turnId && chain.lastTriggerTurnId === turnId) {
      return Promise.resolve({ action: 'ignored', reason: 'duplicate-termination' })
    }
    if (chain.attempts >= maxContinuations) {
      chain.lastTriggerTurnId = turnId
      safeEvent(onEvent, {
        type: 'exhausted',
        threadId,
        turnId,
        attempts: chain.attempts,
        maxContinuations,
        terminationKind
      })
      return Promise.resolve({ action: 'exhausted', attempts: chain.attempts })
    }

    chain.pending = true
    const nextAttempt = chain.attempts + 1
    const operation = Promise.resolve()
      .then(() =>
        startContinuation({
          threadId,
          sourceTurnId: turnId,
          prompt: AUTO_CONTINUATION_PROMPT,
          attempt: nextAttempt,
          maxContinuations,
          terminationKind
        })
      )
      .then(result => {
        chain.attempts = nextAttempt
        chain.pending = false
        chain.operation = null
        chain.lastTriggerTurnId = turnId
        chain.expectedTurnId = normalizedOptionalTaskId(result?.turnId)
        chain.acceptNextTurn = !chain.expectedTurnId
        safeEvent(onEvent, {
          type: 'started',
          threadId,
          sourceTurnId: turnId,
          targetTurnId: chain.expectedTurnId,
          attempt: nextAttempt,
          attempts: chain.attempts,
          maxContinuations,
          mode: String(result?.mode || 'unknown'),
          terminationKind
        })

        return { action: 'started', attempt: nextAttempt, ...result }
      })
      .catch(error => {
        chain.pending = false
        chain.operation = null
        safeEvent(onEvent, {
          type: 'failed',
          threadId,
          sourceTurnId: turnId,
          attempt: nextAttempt,
          attempts: chain.attempts,
          maxContinuations,
          errorName: String(error?.name || 'Error'),
          errorCode: String(error?.code || '')
        })

        return { action: 'failed', attempt: nextAttempt, error }
      })

    chain.operation = operation
    return operation
  }

  const handleDiagnostic = diagnostic => {
    const threadId = normalizedOptionalTaskId(diagnostic?.codexThreadId)
    const turnId = normalizedOptionalTaskId(diagnostic?.codexTurnId)

    if (!threadId) return Promise.resolve({ action: 'ignored', reason: 'missing-thread' })
    let chain = chains.get(threadId)
    const candidate = continuationCandidate(diagnostic)

    if (chain && turnId && turnId !== chain.lastTriggerTurnId) {
      if (chain.acceptNextTurn) {
        chain.expectedTurnId = turnId
        chain.acceptNextTurn = false
      } else if (chain.expectedTurnId && turnId !== chain.expectedTurnId && !chain.pending) {
        reset(threadId, 'user-turn')
        chain = null
      } else if (chain.attempts > 0 && !chain.expectedTurnId && !chain.pending) {
        reset(threadId, 'user-turn')
        chain = null
      }
    }

    if (chain && diagnostic?.outcome === 'upstream_error') {
      reset(threadId, 'non-recoverable-error')
      return Promise.resolve({ action: 'stopped', reason: 'non-recoverable-error' })
    }
    if (chain && diagnostic?.outcome === 'proxy_error' && !candidate) {
      reset(threadId, 'non-recoverable-error')
      return Promise.resolve({ action: 'stopped', reason: 'non-recoverable-error' })
    }
    if (!candidate) {
      if (diagnostic?.taskTermination?.normalCompletion) reset(threadId, 'normal-completion')
      return Promise.resolve({ action: 'observed' })
    }

    chain = chain || ensureChain(threadId)
    return runContinuation(chain, diagnostic, candidate.kind)
  }

  return {
    handleDiagnostic,
    getState(threadId) {
      const id = normalizedOptionalTaskId(threadId)
      const chain = id ? chains.get(id) : null

      return chain
        ? {
            attempts: chain.attempts,
            pending: chain.pending,
            expectedTurnId: chain.expectedTurnId,
            lastTriggerTurnId: chain.lastTriggerTurnId,
            maxContinuations
          }
        : null
    },
    reset(threadId, reason = 'manual-reset') {
      const id = normalizedOptionalTaskId(threadId)

      if (id) reset(id, reason)
    }
  }
}

function desktopProxyUnavailable(error) {
  const text = String(error?.message || error || '').toLowerCase()

  return /failed to connect|control.*socket|socket.*(?:dead|closed|connect)|套接字|管道已关闭|\bepipe\b/.test(text)
}

function desktopTurnNeedsStart(error) {
  const text = String(error?.message || error || '').toLowerCase()

  return /no active turn|turn.*(?:completed|not found)|expected.*turn.*(?:mismatch|not found)|method not found|unknown method|unsupported.*turn\/steer|没有活动回合|回合.*(?:已结束|不存在)/.test(
    text
  )
}

function desktopTurnIsActive(error) {
  const text = String(error?.message || error || '').toLowerCase()

  if (desktopTurnNeedsStart(error)) return false
  return /active_turn|active turn|already.*(?:running|active)|turn.*in.?progress|仍在运行|正在运行|活动回合/.test(text)
}

function turnIdFromResponse(response) {
  return normalizedOptionalTaskId(response?.result?.turn?.id || response?.turn?.id)
}

async function startVisibleTaskContinuation(options = {}) {
  const threadId = normalizeTaskId(options.threadId)
  const prompt = String(options.prompt || AUTO_CONTINUATION_PROMPT)
  const inspectTask = options.inspectTask
  const runDesktopRequest = options.runDesktopRequest
  const runDesktopSteer = options.runDesktopSteer
  const startFallback = options.startFallback

  if (typeof inspectTask !== 'function') throw new Error('任务自动续接缺少状态检查器')
  if (typeof runDesktopRequest !== 'function') throw new Error('任务自动续接缺少桌面请求器')
  if (typeof runDesktopSteer !== 'function') throw new Error('任务自动续接缺少桌面注入请求器')
  if (typeof startFallback !== 'function') throw new Error('任务自动续接缺少备用启动器')

  // Resolve only the local executable and workspace. Do not make a status request first:
  // the diagnostic already identifies the source turn and continuation must be immediate.
  const inspection = await inspectTask(threadId, { allowActive: true, skipRuntimeInspection: true })
  const sourceTurnId = normalizedOptionalTaskId(options.sourceTurnId) || normalizedOptionalTaskId(inspection.lastTurnId)
  const input = [{ type: 'text', text: prompt }]
  const request = {
    codexPath: inspection.codexPath,
    cwd: inspection.cwd,
    threadId,
    input
  }

  const fallback = () => {
    const recovery = startFallback({
      codexPath: inspection.codexPath,
      cwd: inspection.cwd,
      threadId,
      prompt
    })

    recovery?.completion?.catch?.(() => {})
    return { mode: 'exec-resume', turnId: '' }
  }
  const startTurn = async () => {
    const response = await runDesktopRequest(request)

    return { mode: 'desktop-turn-start', turnId: turnIdFromResponse(response) }
  }
  const steerTurn = async () => {
    if (!sourceTurnId) throw new Error('无法向活动回合发送“继续”：缺少回合 ID')
    await runDesktopSteer({ ...request, expectedTurnId: sourceTurnId })

    return { mode: 'desktop-turn-steer', turnId: sourceTurnId }
  }
  const preferSteer =
    Boolean(sourceTurnId) && /^(?:blocked_tool_call|transport_interrupted)$/.test(String(options.terminationKind || ''))

  try {
    if (preferSteer) {
      try {
        return await steerTurn()
      } catch (error) {
        if (desktopProxyUnavailable(error)) return fallback()
        if (!desktopTurnNeedsStart(error)) throw error
        return await startTurn()
      }
    }

    try {
      return await startTurn()
    } catch (error) {
      if (desktopProxyUnavailable(error)) return fallback()
      if (!sourceTurnId || !desktopTurnIsActive(error)) throw error
      return await steerTurn()
    }
  } catch (error) {
    if (desktopProxyUnavailable(error)) return fallback()
    throw error
  }
}

module.exports = {
  AUTO_CONTINUATION_PROMPT,
  MAX_AUTO_CONTINUATIONS,
  continuationCandidate,
  createTaskAutoContinuationSupervisor,
  desktopProxyUnavailable,
  desktopTurnIsActive,
  desktopTurnNeedsStart,
  startVisibleTaskContinuation
}
