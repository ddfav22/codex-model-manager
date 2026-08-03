const DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS = 1024
const GPT_56_MODEL_PATTERN = /^gpt-5\.6(?:-|$)/i
const RESPONSES_PROBE_MAX_ATTEMPTS = 3
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504])
const TRANSIENT_RESPONSES_CODES = new Set([
  'internal_server_error',
  'rate_limit_exceeded',
  'server_error',
  'server_is_overloaded',
  'service_unavailable_error',
  'temporarily_unavailable'
])

function responsesProbeRuntimeOptions(model, options = {}) {
  const maxOutputTokens = Math.max(DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS, Number(options.maxOutputTokens) || 0)
  const runtime = {
    max_output_tokens: maxOutputTokens,
    stream: true
  }

  // GPT-5.6 defaults to medium reasoning. Tiny compatibility probes can
  // otherwise consume their entire output budget before emitting final text.
  // Low still exercises the Responses reasoning/tool path without turning a
  // health check into a long or expensive generation.
  if (GPT_56_MODEL_PATTERN.test(String(model || '').trim())) {
    runtime.reasoning = { effort: 'low' }
  }

  return runtime
}

function isTransientResponsesProbeFailure(parsed, httpStatus = 0) {
  if (TRANSIENT_HTTP_STATUSES.has(Number(httpStatus))) return true

  const failure = parsed?.failure
  const codes = [failure?.code, failure?.type].map(value =>
    String(value || '')
      .trim()
      .toLowerCase()
  )

  if (codes.some(value => TRANSIENT_RESPONSES_CODES.has(value))) return true

  return /overload|temporar(?:y|ily) unavailable|try again later|service unavailable/i.test(
    String(failure?.message || '')
  )
}

module.exports = {
  DEFAULT_RESPONSES_PROBE_MAX_OUTPUT_TOKENS,
  RESPONSES_PROBE_MAX_ATTEMPTS,
  isTransientResponsesProbeFailure,
  responsesProbeRuntimeOptions
}
