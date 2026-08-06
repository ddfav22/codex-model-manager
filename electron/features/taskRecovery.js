const fs = require('fs')
const readline = require('readline')
const { execFileSync, spawn } = require('child_process')

const CODEX_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEFAULT_RECOVERY_TIMEOUT_MS = 12 * 60 * 60 * 1000
const MAX_DIAGNOSTIC_TEXT = 8192
const TASK_RECOVERY_PROMPT = [
  '上次任务异常、中断或没有完成。请从当前任务现场继续，不要从头重做。',
  '先只读检查当前工作区、git status 和 git diff、已经生成或修改的文件，以及最近一次测试结果；明确哪些已经完成、哪些仍未完成。',
  '随后只继续尚未完成的工作，保留已有正确修改，不重复已经成功的命令，不擅自扩大任务范围。',
  '如果遇到认证、额度、权限、外部服务长期不可用，或确实需要用户选择，请停止并清楚说明阻塞原因；不要自动循环重试，也不要自行创建额外任务。'
].join('\n')

function normalizeTaskId(value) {
  const taskId = String(value || '')
    .trim()
    .toLowerCase()

  if (!CODEX_TASK_ID_PATTERN.test(taskId)) throw new Error('Codex 任务 ID 格式无效')

  return taskId
}

function redactedTaskId(value) {
  const taskId = normalizeTaskId(value)

  return `${taskId.slice(0, 8)}…${taskId.slice(-4)}`
}

function recoveryFailureCategory(value) {
  const text = String(value || '').toLowerCase()
  const matches = pattern => pattern.test(text)

  if (matches(/\b(?:401|403)\b|unauthori[sz]ed|authentication|api[ _-]?key|token expired|登录|认证|凭据/)) {
    return 'authentication'
  }
  if (matches(/\b429\b|high demand|rate.?limit|quota|credit|billing|capacity|额度|限流|繁忙|高负载/)) {
    return 'capacity'
  }
  if (matches(/permission|approval|sandbox|access denied|policy|权限|审批|沙箱|策略拒绝/)) return 'permission'
  if (matches(/fetch failed|timed? ?out|timeout|econn|enotfound|dns|network|socket|connect|网络|连接|超时/)) {
    return 'network'
  }
  if (
    matches(/resume|rollout|session|thread|history|corrupt|malformed|parse|not found|paginated|恢复|会话|任务记录|历史/)
  ) {
    return 'session'
  }

  return 'unknown'
}

function recoveryFailureMessage(category) {
  if (category === 'authentication') return '任务恢复因认证或凭据问题停止，请先重新登录或检查渠道授权。'
  if (category === 'capacity') return '任务恢复因额度、限流或服务高负载停止；客户端不会自动重试。'
  if (category === 'permission') return '任务恢复需要权限或审批，客户端已停止，未自动放行。'
  if (category === 'network') return '任务恢复因网络或连接问题停止；客户端不会在后台循环重试。'
  if (category === 'session') return '原任务记录无法恢复，可尝试从已保存历史创建 Fork。'

  return '任务恢复未能启动或完成，请查看运行日志中的分类信息。'
}

function recoveryEventType(event) {
  return String(event?.type || event?.method || '').trim()
}

function eventDiagnostic(event) {
  if (!event || typeof event !== 'object') return ''
  if (event.error && typeof event.error === 'object') return String(event.error.message || event.error.code || '')

  return String(event.message || '')
}

function startCodexExecRecovery(options = {}) {
  const taskId = normalizeTaskId(options.taskId)
  const codexPath = String(options.codexPath || '').trim()
  const spawnProcess = options.spawnProcess || spawn
  const prompt = String(options.prompt || TASK_RECOVERY_PROMPT)
  const timeoutMs = Number(options.timeoutMs || DEFAULT_RECOVERY_TIMEOUT_MS)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}

  if (!codexPath) throw new Error('没有找到 Codex 本地运行时')

  const child = spawnProcess(
    codexPath,
    ['exec', '--json', '--color', 'never', '--skip-git-repo-check', 'resume', taskId, '-'],
    {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let eventCount = 0
  let turnStarted = false
  let workStarted = false
  let terminalTurnStatus = ''
  let diagnosticText = ''
  let settled = false
  let timer
  const stopWithParent = () => {
    if (!child.killed) child.kill()
  }
  const appendDiagnostic = value => {
    const text = String(value || '').trim()

    if (!text) return
    diagnosticText = `${diagnosticText}\n${text}`.slice(-MAX_DIAGNOSTIC_TEXT)
  }
  const completion = new Promise(resolve => {
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', stopWithParent)
      output.close()
      resolve({
        ...result,
        eventCount,
        turnStarted,
        workStarted,
        terminalTurnStatus,
        failureCategory: result.ok ? '' : recoveryFailureCategory(diagnosticText)
      })
    }
    const output = readline.createInterface({ input: child.stdout })

    output.on('line', line => {
      let event

      try {
        event = JSON.parse(line)
      } catch {
        return
      }

      eventCount += 1
      const type = recoveryEventType(event)
      const diagnostic = eventDiagnostic(event)

      if (diagnostic) appendDiagnostic(diagnostic)
      if (/turn[/.]started/i.test(type)) {
        turnStarted = true
        onProgress({ stage: 'running', status: 'running', message: '原任务已恢复，正在继续未完成工作' })
      }
      if (/item[/.](?:started|completed)|command|file.?change|tool/i.test(type)) workStarted = true
      if (/turn[/.]completed/i.test(type)) {
        terminalTurnStatus = String(event?.turn?.status || event?.status || '').toLowerCase()
      }
    })
    child.stderr.on('data', chunk => appendDiagnostic(chunk.toString('utf8')))
    child.once('error', error => {
      appendDiagnostic(error?.message)
      finish({ ok: false, exitCode: null, signal: '', timedOut: false })
    })
    child.once('exit', (code, signal) => {
      const failedTerminal = terminalTurnStatus && !['completed', 'success', 'succeeded'].includes(terminalTurnStatus)

      finish({
        ok: code === 0 && !failedTerminal,
        exitCode: code,
        signal: String(signal || ''),
        timedOut: false
      })
    })
    timer = setTimeout(() => {
      if (!child.killed) child.kill()
      appendDiagnostic('task recovery timeout')
      finish({ ok: false, exitCode: null, signal: '', timedOut: true })
    }, timeoutMs)
  })

  process.once('exit', stopWithParent)
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  return { child, completion }
}

function shouldForkAfterFailure(result) {
  return (
    result?.ok === false &&
    result?.failureCategory === 'session' &&
    result?.turnStarted !== true &&
    result?.workStarted !== true
  )
}

function taskRecoveryWorkspaceSnapshot(session, options = {}) {
  const fileSystem = options.fsModule || fs
  const runGit = options.execFileSync || execFileSync
  const cwd = String(session?.cwd || '').trim()
  let cwdExists = false
  let gitRepository = false
  let dirtyEntryCount = 0

  try {
    cwdExists = Boolean(cwd && fileSystem.existsSync(cwd) && fileSystem.statSync(cwd).isDirectory())
  } catch {
    cwdExists = false
  }

  if (cwdExists) {
    try {
      const output = runGit('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=no'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      })

      gitRepository = true
      dirtyEntryCount = String(output || '')
        .split(/\r?\n/)
        .filter(Boolean).length
    } catch {
      // A non-Git task can still be resumed; the agent will inspect its files directly.
    }
  }

  return {
    cwdExists,
    gitRepository,
    dirtyEntryCount,
    sessionBytes: Number(session?.size || 0),
    sessionUpdatedAt: String(session?.updatedAt || '')
  }
}

module.exports = {
  CODEX_TASK_ID_PATTERN,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  TASK_RECOVERY_PROMPT,
  normalizeTaskId,
  recoveryFailureCategory,
  recoveryFailureMessage,
  redactedTaskId,
  shouldForkAfterFailure,
  startCodexExecRecovery,
  taskRecoveryWorkspaceSnapshot
}
