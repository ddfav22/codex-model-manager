const { AGENT_CONTINUATION_INSTRUCTION, REASONING_ORDER, ROUTING_METADATA_PREFIX } = require('./constants')

function safeModelId(model) {
  return String(model || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function modelIdentityLabel(model) {
  const id = safeModelId(model)

  if (/^grok(?:-|$)/i.test(id)) {
    return id.replace(/^grok/i, 'Grok').replace(/-/g, ' ')
  }
  if (/^gpt(?:-|$)/i.test(id)) {
    return id.replace(/^gpt/i, 'GPT').replace(/-(?=[A-Za-z])/g, ' ')
  }

  return id || 'the selected upstream model'
}

function modelIdentityInstruction(model) {
  const id = safeModelId(model)

  return (
    `${ROUTING_METADATA_PREFIX} selected_upstream_model_id=${JSON.stringify(id || 'unknown')}; ` +
    'host_agent_runtime="Codex". The selected model ID is generated from this request\'s current route, not from a fixed assistant identity. ' +
    'Codex supplies the desktop UI, conversation, permissions, skills, and tools but is not the upstream model. ' +
    'This metadata does not prescribe a canned identity answer; when identity is relevant, respond in your own words using the current route and provider-supplied self-knowledge.'
  )
}

function withModelIdentity(instructions, model) {
  const current = String(instructions || '').trim()
  const identity = modelIdentityInstruction(model)
  const markerPattern = /\[(?:Managed model identity|Runtime routing metadata)\][^\r\n]*/g
  const withoutPreviousIdentity = current.replace(markerPattern, '').trim()

  return withoutPreviousIdentity ? `${withoutPreviousIdentity}\n\n${identity}` : identity
}

function capabilityForModel(channel, model) {
  const capabilities =
    channel?.modelCapabilities && typeof channel.modelCapabilities === 'object' ? channel.modelCapabilities : {}
  const direct = capabilities[model]

  if (direct) return direct
  const matchedKey = Object.keys(capabilities).find(key => key.toLowerCase() === String(model || '').toLowerCase())

  return matchedKey ? capabilities[matchedKey] : null
}

function canonicalModelFor(channel, requestedModel) {
  const requested = String(requestedModel || '').trim()
  const aliases = channel?.modelAliases && typeof channel.modelAliases === 'object' ? channel.modelAliases : {}
  const direct = aliases[requested]

  if (direct) return String(direct)
  const matchedAlias = Object.keys(aliases).find(alias => alias.toLowerCase() === requested.toLowerCase())

  return matchedAlias ? String(aliases[matchedAlias]) : requested
}

function normalizeReasoningEffort(value, supported = []) {
  const requested = String(value || '').toLowerCase()
  const allowed = supported.filter(effort => REASONING_ORDER.includes(effort))

  if (!requested || !allowed.length) return ''
  if (allowed.includes(requested)) return requested

  const requestedIndex = REASONING_ORDER.indexOf(requested)

  if (requestedIndex < 0) return allowed.includes('medium') ? 'medium' : allowed[0]

  return [...allowed].sort(
    (left, right) =>
      Math.abs(REASONING_ORDER.indexOf(left) - requestedIndex) -
      Math.abs(REASONING_ORDER.indexOf(right) - requestedIndex)
  )[0]
}

function withAgentContinuation(instructions, body) {
  if (!Array.isArray(body?.tools) || !body.tools.length) return instructions
  const current = String(instructions || '').trim()

  if (current.includes(AGENT_CONTINUATION_INSTRUCTION)) return current

  return current ? `${current}\n\n${AGENT_CONTINUATION_INSTRUCTION}` : AGENT_CONTINUATION_INSTRUCTION
}

function managedInstructions(instructions, body, model) {
  return withModelIdentity(withAgentContinuation(instructions, body), model)
}

module.exports = {
  canonicalModelFor,
  capabilityForModel,
  managedInstructions,
  modelIdentityInstruction,
  modelIdentityLabel,
  normalizeReasoningEffort,
  safeModelId,
  withAgentContinuation,
  withModelIdentity
}
