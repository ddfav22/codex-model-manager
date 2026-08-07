const CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata'
const CODEX_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}

  try {
    const parsed = JSON.parse(value)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function codexId(value) {
  const normalized = String(value || '').trim()

  return CODEX_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : ''
}

function codexRequestContext(body) {
  const clientMetadata =
    body?.client_metadata && typeof body.client_metadata === 'object' && !Array.isArray(body.client_metadata)
      ? body.client_metadata
      : {}
  const turnMetadata = parseMetadata(clientMetadata[CODEX_TURN_METADATA_KEY])

  return {
    codexThreadId: codexId(turnMetadata.thread_id || turnMetadata.threadId || clientMetadata.thread_id),
    codexTurnId: codexId(turnMetadata.turn_id || turnMetadata.turnId || clientMetadata.turn_id),
    codexSessionId: codexId(turnMetadata.session_id || turnMetadata.sessionId || clientMetadata.session_id)
  }
}

function diagnosticClassification(diagnostic) {
  const continuation = diagnostic?.emulation?.continuationRecovery

  if (diagnostic?.taskTermination?.shouldContinue) {
    return { diagnosticKind: 'task_terminated', diagnosticSeverity: 'warn' }
  }

  if (continuation?.exhausted) {
    if (continuation.recoveryCircuitBreaker === 'consecutive_transport_failures') {
      return { diagnosticKind: 'agent_loop_transport_stalled', diagnosticSeverity: 'warn' }
    }
    if (continuation.recoveryCircuitBreaker === 'identical_stalled_responses') {
      return { diagnosticKind: 'agent_loop_repeated_stall', diagnosticSeverity: 'warn' }
    }

    return { diagnosticKind: 'agent_loop_stalled', diagnosticSeverity: 'warn' }
  }

  if (diagnostic?.outcome === 'upstream_error') {
    const failureKind = String(diagnostic.upstreamFailureKind || 'invalid_upstream_response')

    return { diagnosticKind: failureKind, diagnosticSeverity: 'warn' }
  }

  if (diagnostic?.outcome === 'proxy_error') {
    return { diagnosticKind: 'proxy_transport_error', diagnosticSeverity: 'error' }
  }

  if (Number(diagnostic?.upstreamRetryCount || 0) > 0) {
    return { diagnosticKind: 'upstream_recovered', diagnosticSeverity: 'info' }
  }

  const continuationAttempts = Number(continuation?.recoveryAttempts || 0)

  if (continuationAttempts > 0 && continuation?.acceptedRetry) {
    return { diagnosticKind: 'agent_loop_recovered', diagnosticSeverity: 'info' }
  }

  return {
    diagnosticKind: String(diagnostic?.operation || 'proxy_request'),
    diagnosticSeverity: 'info'
  }
}

function annotateDiagnostic(diagnostic) {
  return { ...diagnostic, ...diagnosticClassification(diagnostic) }
}

function diagnosticMessage(diagnostic) {
  switch (diagnostic?.diagnosticKind) {
    case 'upstream_capacity':
      return '模型渠道负载过高，当前请求未完成。'
    case 'upstream_timeout':
      return '模型渠道响应超时，当前请求未完成。'
    case 'upstream_rate_limit':
      return '模型渠道请求过多，当前请求未完成。'
    case 'upstream_server_error':
      return '模型渠道服务异常，当前请求未完成。'
    case 'upstream_request_rejected':
      return '模型渠道拒绝了当前请求，请检查渠道和模型配置。'
    case 'context_too_large':
      return '当前对话上下文过大，请先让 Codex 压缩上下文或新建任务。'
    case 'proxy_transport_error':
      return '客户端与模型渠道的连接中断，详细信息已写入运行日志。'
    case 'agent_loop_transport_stalled':
      return 'Agent Loop 因连续连接失败而暂停，已保留当前任务。'
    case 'agent_loop_repeated_stall':
      return 'Agent Loop 连续返回相同的中间计划，已暂停并保留当前任务。'
    case 'agent_loop_stalled':
      return 'Agent Loop 未进入完成状态，已暂停并保留当前任务。'
    case 'task_terminated':
      return '当前任务异常终止，客户端将尝试在同一对话中继续。'
    default:
      return '模型请求出现异常，详细信息已写入运行日志。'
  }
}

function publicDiagnosticSummary(diagnostic) {
  if (!['warn', 'error'].includes(diagnostic?.diagnosticSeverity)) return null

  return {
    capturedAt: String(diagnostic.capturedAt || ''),
    severity: diagnostic.diagnosticSeverity,
    kind: String(diagnostic.diagnosticKind || ''),
    message: diagnosticMessage(diagnostic),
    channelId: String(diagnostic.channelId || '').slice(0, 128),
    model: String(diagnostic.model || diagnostic.requestedModel || '').slice(0, 128),
    codexThreadId: codexId(diagnostic.codexThreadId),
    codexTurnId: codexId(diagnostic.codexTurnId),
    upstreamStatus: Number(diagnostic.upstreamStatus || 0),
    upstreamRetryCount: Number(diagnostic.upstreamRetryCount || 0)
  }
}

module.exports = {
  CODEX_TURN_METADATA_KEY,
  annotateDiagnostic,
  codexRequestContext,
  diagnosticClassification,
  publicDiagnosticSummary
}
