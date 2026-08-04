const RECOVERY_DECISION = Object.freeze({
  COMPLETE: 'complete',
  NEEDS_INPUT: 'needs_input',
  TOOL: 'tool'
})

function firstBalancedJsonObject(text) {
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }

  return ''
}

function recoveryDecisionCandidates(content) {
  const text = String(content || '').slice(0, 1024 * 1024)
  const fenced = text.match(/```(?:json)?\s*([\s\S]{1,1048576}?)\s*```/i)

  return [...new Set([fenced?.[1], text.trim(), firstBalancedJsonObject(text)].filter(Boolean))]
}

function normalizeDecisionName(value) {
  const name = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

  if (['complete', 'completed', 'done', 'final', 'finished'].includes(name)) return RECOVERY_DECISION.COMPLETE
  if (['needs_input', 'need_input', 'ask', 'question', 'user_input'].includes(name)) {
    return RECOVERY_DECISION.NEEDS_INPUT
  }
  if (['tool', 'tool_call', 'call_tool', 'continue'].includes(name)) return RECOVERY_DECISION.TOOL

  return ''
}

function parseAgentRecoveryDecision(content) {
  for (const raw of recoveryDecisionCandidates(content)) {
    try {
      const parsed = JSON.parse(raw)
      const envelope = parsed?.recovery_decision || parsed?.decision_payload || parsed
      const type = normalizeDecisionName(
        typeof envelope?.decision === 'string'
          ? envelope.decision
          : envelope?.status || envelope?.action || envelope?.kind
      )

      if (!type) continue
      if (type === RECOVERY_DECISION.TOOL) return { type, content: '' }

      const value = String(
        type === RECOVERY_DECISION.COMPLETE
          ? (envelope?.answer ?? envelope?.result ?? envelope?.content ?? '')
          : (envelope?.question ?? envelope?.message ?? envelope?.content ?? '')
      ).trim()

      if (!value) continue

      return { type, content: value }
    } catch {
      // Try the next common JSON envelope.
    }
  }

  return null
}

function recoveryDecisionContract(completionSignal) {
  return [
    'Return exactly one JSON object representing the next agent decision. Do not return a plan, progress sentence, markdown, or additional prose.',
    'To execute another allowed tool: {"decision":"tool","name":"TOOL_NAME","arguments":{}}.',
    'Only when every requested action has a verified result: {"decision":"complete","answer":"the complete user-facing final answer"}.',
    'Only when a genuinely missing user value blocks progress: {"decision":"needs_input","question":"one concrete question"}.',
    `The adapter converts a complete decision into the private ${completionSignal} signal; never place that signal inside JSON.`,
    'A plan-only answer is invalid. Choose the next executable tool whenever work remains and its inputs are already available.'
  ].join(' ')
}

module.exports = {
  RECOVERY_DECISION,
  parseAgentRecoveryDecision,
  recoveryDecisionContract
}
