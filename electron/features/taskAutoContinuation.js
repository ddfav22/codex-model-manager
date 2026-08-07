const { normalizeTaskId } = require('./taskRecovery')

const AUTO_CONTINUATION_PROMPT = '继续'
const MAX_AUTO_CONTINUATIONS = 3
const DEFAULT_IDLE_ATTEMPTS = 20
const DEFAULT_IDLE_DELAY_MS = 500

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

  const handleDiagnostic = diagnostic => {
    const threadId = normalizedOptionalTaskId(diagnostic?.codexThreadId)
    const turnId = normalizedOptionalTaskId(diagnostic?.codexTurnId)

    if (!threadId) return Promise.resolve({ action: 'ignored', reason: 'missing-thread' })
    let chain = chains.get(threadId)

    if (chain && turnId && turnId !== chain.lastTriggerTurnId) {
      if (chain.acceptNextTurn) {
        chain.expectedTurnId = turnId
        chain.acceptNextTurn = false
      } else if (chain.expectedTurnId && turnId !== chain.expectedTurnId && !chain.pending) {
        reset(threadId, 'user-turn')
        chain = null
      }
    }

    if (chain && ['upstream_error', 'proxy_error'].includes(String(diagnostic?.outcome || ''))) {
      reset(threadId, 'non-recoverable-error')
      return Promise.resolve({ action: 'stopped', reason: 'non-recoverable-error' })
    }

    const termination = diagnostic?.taskTermination

    if (!termination?.shouldContinue) {
      if (termination?.normalCompletion) reset(threadId, 'normal-completion')
      return Promise.resolve({ action: 'observed' })
    }

    if (!chain) {
      chain = {
        attempts: 0,
        pending: false,
        expectedTurnId: '',
        acceptNextTurn: false,
        lastTriggerTurnId: ''
      }
      chains.set(threadId, chain)
    }
    if (chain.pending) return chain.operation || Promise.resolve({ action: 'pending' })
    if (turnId && chain.lastTriggerTurnId === turnId) {
      return Promise.resolve({ action: 'ignored', reason: 'duplicate-termination' })
    }

    chain.lastTriggerTurnId = turnId
    if (chain.attempts >= maxContinuations) {
      safeEvent(onEvent, {
        type: 'exhausted',
        threadId,
        turnId,
        attempts: chain.attempts,
        maxContinuations,
        terminationKind: String(termination.kind || '')
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
          terminationKind: String(termination.kind || '')
        })
      )
      .then(result => {
        chain.attempts = nextAttempt
        chain.pending = false
        chain.operation = null
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
          terminationKind: String(termination.kind || '')
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

async function waitForTaskIdle(threadId, inspectTask, options = {}) {
  const delay =
    typeof options.delay === 'function' ? options.delay : ms => new Promise(resolve => setTimeout(resolve, ms))
  const attempts = Number(options.idleAttempts || DEFAULT_IDLE_ATTEMPTS)
  const delayMs = Number(options.idleDelayMs || DEFAULT_IDLE_DELAY_MS)
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await inspectTask(threadId)
    } catch (error) {
      lastError = error
      if (!/仍在运行|in.?progress|running|active turn/i.test(String(error?.message || error))) throw error
      if (attempt + 1 < attempts) await delay(delayMs)
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

  try {
    const response = await runDesktopRequest({
      codexPath: inspection.codexPath,
      cwd: inspection.cwd,
      threadId,
      input: [{ type: 'text', text: prompt }]
    })
    const turn = response?.result?.turn || response?.turn || {}

    return { mode: 'desktop-app-server', turnId: normalizedOptionalTaskId(turn.id) }
  } catch (error) {
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
  MAX_AUTO_CONTINUATIONS,
  createTaskAutoContinuationSupervisor,
  desktopProxyUnavailable,
  startVisibleTaskContinuation,
  waitForTaskIdle
}
