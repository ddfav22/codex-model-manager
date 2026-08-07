const { normalizeTaskId } = require('./taskRecovery')

const AUTO_CONTINUATION_PROMPT = '继续'
const MAX_AUTO_CONTINUATIONS = 3
const DEFAULT_IDLE_ATTEMPTS = 150
const DEFAULT_IDLE_DELAY_MS = 2000
const DEFAULT_WATCH_GRACE_MS = 1500
const AUTO_CONTINUATION_CANCELLED = 'EAUTOCONTINUECANCELLED'

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

function unrefDelay(delayMs) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, delayMs)

    timer.unref?.()
  })
}

function cancellationError(reason = 'task progress resumed') {
  return Object.assign(new Error(reason), { code: AUTO_CONTINUATION_CANCELLED })
}

function throwIfCancelled(signal) {
  if (signal?.aborted)
    throw cancellationError(String(signal.reason?.message || signal.reason || 'task progress resumed'))
}

function waitWithSignal(delay, delayMs, signal) {
  throwIfCancelled(signal)
  if (!signal) return Promise.resolve(delay(delayMs))

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = callback => value => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject)(cancellationError(String(signal.reason?.message || signal.reason || '')))

    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(delay(delayMs)).then(finish(resolve), finish(reject))
  })
}

function continuationCandidate(diagnostic) {
  const termination = diagnostic?.taskTermination
  const kind = String(termination?.kind || '')

  if (termination?.shouldContinue) return { immediate: true, kind: kind || 'terminated' }
  if (termination?.terminal && kind === 'tool_call') return { immediate: false, kind: 'blocked_tool_call' }
  if (
    diagnostic?.outcome === 'proxy_error' &&
    diagnostic?.diagnosticKind === 'proxy_transport_error' &&
    /^(?:network_error|upstream_timeout)$/.test(String(diagnostic?.transportFailureKind || ''))
  ) {
    return { immediate: false, kind: 'transport_interrupted' }
  }

  return null
}

function diagnosticFingerprint(diagnostic, candidate) {
  return [
    String(diagnostic?.codexTurnId || ''),
    String(diagnostic?.capturedAt || ''),
    String(candidate?.kind || ''),
    String(diagnostic?.taskTermination?.observedBytes || ''),
    String(diagnostic?.transportFailureKind || '')
  ].join('|')
}

function createTaskAutoContinuationSupervisor(options = {}) {
  const startContinuation = options.startContinuation
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const maxContinuations = Number(options.maxContinuations || MAX_AUTO_CONTINUATIONS)
  const delay = typeof options.delay === 'function' ? options.delay : unrefDelay
  const watchGraceMs = Number(options.watchGraceMs ?? DEFAULT_WATCH_GRACE_MS)
  const chains = new Map()

  if (typeof startContinuation !== 'function') throw new Error('任务自动续接缺少启动器')
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 10) {
    throw new Error('任务自动续接次数无效')
  }
  if (!Number.isFinite(watchGraceMs) || watchGraceMs < 0 || watchGraceMs > 60000) {
    throw new Error('任务自动续接观察延迟无效')
  }

  const cancelWatch = (chain, reason) => {
    if (!chain?.watch) return
    const watch = chain.watch

    chain.watch = null
    watch.controller.abort(cancellationError(reason))
    safeEvent(onEvent, {
      type: 'watchCancelled',
      threadId: chain.threadId,
      sourceTurnId: watch.turnId,
      reason,
      terminationKind: watch.terminationKind,
      attempts: chain.attempts,
      maxContinuations
    })
  }

  const reset = (threadId, reason) => {
    const chain = chains.get(threadId)

    if (!chain) return
    cancelWatch(chain, reason)
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
        watch: null,
        expectedTurnId: '',
        acceptNextTurn: false,
        lastTriggerTurnId: ''
      }
      chains.set(threadId, chain)
    }

    return chain
  }

  const runContinuation = (chain, diagnostic, terminationKind, signal) => {
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
      .then(() => {
        throwIfCancelled(signal)
        return startContinuation({
          threadId,
          sourceTurnId: turnId,
          prompt: AUTO_CONTINUATION_PROMPT,
          attempt: nextAttempt,
          maxContinuations,
          terminationKind,
          signal
        })
      })
      .then(result => {
        throwIfCancelled(signal)
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
        if (error?.code === AUTO_CONTINUATION_CANCELLED) {
          return { action: 'ignored', reason: 'progress-resumed' }
        }
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

  const watchCandidate = (chain, diagnostic, candidate, fingerprint) => {
    const controller = new AbortController()
    const turnId = normalizedOptionalTaskId(diagnostic?.codexTurnId)
    const watch = {
      controller,
      fingerprint,
      turnId,
      terminationKind: candidate.kind,
      operation: null
    }

    chain.watch = watch
    safeEvent(onEvent, {
      type: 'watching',
      threadId: chain.threadId,
      sourceTurnId: turnId,
      terminationKind: candidate.kind,
      attempts: chain.attempts,
      maxContinuations
    })
    const operation = waitWithSignal(delay, watchGraceMs, controller.signal)
      .then(() => runContinuation(chain, diagnostic, candidate.kind, controller.signal))
      .catch(error =>
        error?.code === AUTO_CONTINUATION_CANCELLED
          ? { action: 'ignored', reason: 'progress-resumed' }
          : { action: 'failed', error }
      )
      .finally(() => {
        if (chain.watch === watch) chain.watch = null
      })

    watch.operation = operation
    return operation
  }

  const handleDiagnostic = diagnostic => {
    const threadId = normalizedOptionalTaskId(diagnostic?.codexThreadId)
    const turnId = normalizedOptionalTaskId(diagnostic?.codexTurnId)

    if (!threadId) return Promise.resolve({ action: 'ignored', reason: 'missing-thread' })
    let chain = chains.get(threadId)
    const candidate = continuationCandidate(diagnostic)
    const fingerprint = candidate ? diagnosticFingerprint(diagnostic, candidate) : ''

    if (chain?.watch) {
      if (chain.watch.fingerprint === fingerprint) return chain.watch.operation
      cancelWatch(chain, 'task-progress')
    }

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
    return candidate.immediate
      ? runContinuation(chain, diagnostic, candidate.kind)
      : watchCandidate(chain, diagnostic, candidate, fingerprint)
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
            watching: Boolean(chain.watch),
            watchKind: String(chain.watch?.terminationKind || ''),
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

async function waitForTaskIdle(threadId, inspectTask, options = {}) {
  const delay = typeof options.delay === 'function' ? options.delay : unrefDelay
  const attempts = Number(options.idleAttempts || DEFAULT_IDLE_ATTEMPTS)
  const delayMs = Number(options.idleDelayMs || DEFAULT_IDLE_DELAY_MS)
  const signal = options.signal
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfCancelled(signal)
    try {
      return await inspectTask(threadId)
    } catch (error) {
      lastError = error
      if (!/仍在运行|in.?progress|running|active turn/i.test(String(error?.message || error))) throw error
      if (attempt + 1 < attempts) await waitWithSignal(delay, delayMs, signal)
    }
  }

  throw lastError || new Error('等待当前任务结束超时')
}

async function startVisibleTaskContinuation(options = {}) {
  const threadId = normalizeTaskId(options.threadId)
  const prompt = String(options.prompt || AUTO_CONTINUATION_PROMPT)
  const inspectTask = options.inspectTask
  const runDesktopRequest = options.runDesktopRequest
  const startFallback = options.startFallback

  if (typeof inspectTask !== 'function') throw new Error('任务自动续接缺少状态检查器')
  if (typeof runDesktopRequest !== 'function') throw new Error('任务自动续接缺少桌面请求器')
  if (typeof startFallback !== 'function') throw new Error('任务自动续接缺少备用启动器')

  const inspection = await waitForTaskIdle(threadId, inspectTask, options)

  throwIfCancelled(options.signal)

  try {
    const response = await runDesktopRequest({
      codexPath: inspection.codexPath,
      cwd: inspection.cwd,
      threadId,
      input: [{ type: 'text', text: prompt }]
    })
    const turn = response?.result?.turn || response?.turn || {}

    throwIfCancelled(options.signal)
    return { mode: 'desktop-app-server', turnId: normalizedOptionalTaskId(turn.id) }
  } catch (error) {
    if (error?.code === AUTO_CONTINUATION_CANCELLED) throw error
    if (!desktopProxyUnavailable(error)) throw error
    const fallback = startFallback({
      codexPath: inspection.codexPath,
      cwd: inspection.cwd,
      threadId,
      prompt
    })

    fallback?.completion?.catch?.(() => {})
    return { mode: 'exec-resume', turnId: '' }
  }
}

module.exports = {
  AUTO_CONTINUATION_PROMPT,
  DEFAULT_IDLE_ATTEMPTS,
  DEFAULT_IDLE_DELAY_MS,
  DEFAULT_WATCH_GRACE_MS,
  MAX_AUTO_CONTINUATIONS,
  AUTO_CONTINUATION_CANCELLED,
  continuationCandidate,
  createTaskAutoContinuationSupervisor,
  desktopProxyUnavailable,
  startVisibleTaskContinuation,
  waitForTaskIdle
}
