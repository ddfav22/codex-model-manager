const { createTaskAutoContinuationSupervisor, startVisibleTaskContinuation } = require('./taskAutoContinuation')
const { redactedTaskId, startCodexExecRecovery } = require('./taskRecovery')

function createTaskAutoContinuationRuntime(options = {}) {
  const manager = options.manager
  const logEvent = typeof options.logEvent === 'function' ? options.logEvent : () => {}
  const getRuntimeTargets = typeof options.getRuntimeTargets === 'function' ? options.getRuntimeTargets : () => []
  const startRecovery = options.startRecovery || startCodexExecRecovery

  if (!manager || typeof manager.resolveCodexContinuationTarget !== 'function') {
    throw new Error('任务自动续接缺少 Codex 目标解析器')
  }
  if (typeof manager.runCodexAppServerRequest !== 'function') {
    throw new Error('任务自动续接缺少 Codex app-server 请求器')
  }
  if (typeof manager.getPaths !== 'function') throw new Error('任务自动续接缺少 Codex 路径配置')
  if (typeof startRecovery !== 'function') throw new Error('任务自动续接缺少 resume 兜底启动器')

  const requestEnvironment = () => ({ ...process.env, CODEX_HOME: manager.getPaths().codexHome })
  const startContinuation = request =>
    startVisibleTaskContinuation({
      ...request,
      inspectTask: () => manager.resolveCodexContinuationTarget({ codexTargets: getRuntimeTargets() }),
      runDesktopRequest: ({ codexPath, cwd, threadId, input }) =>
        manager.runCodexAppServerRequest(
          codexPath,
          'turn/start',
          { threadId, input },
          {
            cwd,
            env: requestEnvironment(),
            timeoutMs: 15000,
            connectDesktop: true
          }
        ),
      runDesktopSteer: ({ codexPath, cwd, threadId, input, expectedTurnId }) =>
        manager.runCodexAppServerRequest(
          codexPath,
          'turn/steer',
          { threadId, input, expectedTurnId },
          {
            cwd,
            env: requestEnvironment(),
            timeoutMs: 15000,
            connectDesktop: true
          }
        ),
      startFallback: ({ codexPath, cwd, threadId, prompt }) => {
        const recovery = startRecovery({
          taskId: threadId,
          codexPath,
          cwd,
          env: requestEnvironment(),
          prompt
        })

        recovery?.completion
          ?.then?.(result => {
            logEvent(result.ok ? 'info' : 'warn', 'task.autoContinue.fallbackComplete', {
              threadRef: redactedTaskId(threadId),
              ok: result.ok,
              turnStarted: result.turnStarted,
              workStarted: result.workStarted,
              failureCategory: result.failureCategory,
              exitCode: result.exitCode
            })
          })
          ?.catch?.(() => {})
        return recovery
      }
    })

  return createTaskAutoContinuationSupervisor({
    startContinuation,
    onEvent: event => {
      const severity = event.type === 'failed' || event.type === 'exhausted' ? 'warn' : 'info'

      logEvent(severity, `task.autoContinue.${event.type}`, {
        threadRef: redactedTaskId(event.threadId),
        attempt: Number(event.attempt || 0),
        attempts: Number(event.attempts || 0),
        maxContinuations: Number(event.maxContinuations || 0),
        mode: String(event.mode || ''),
        reason: String(event.reason || ''),
        terminationKind: String(event.terminationKind || ''),
        errorName: String(event.errorName || ''),
        errorCode: String(event.errorCode || ''),
        errorPhase: String(event.errorPhase || ''),
        errorMessage: String(event.errorMessage || '')
      })
    }
  })
}

module.exports = { createTaskAutoContinuationRuntime }
