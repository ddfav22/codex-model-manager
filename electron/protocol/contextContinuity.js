const { SUMMARY_PREFIX } = require('./constants')
const { AGENT_COMPLETION_SIGNAL, AGENT_SAFETY_STOP_SIGNAL } = require('./toolContinuation')

const RECOVERY_TAIL_MESSAGES = 8
const RECOVERY_CONVERSATION_ANCHORS = 4
const RECOVERY_MESSAGE_CHARS = 3500

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const INTERNAL_AGENT_SIGNAL_PATTERN = new RegExp(
  `${escapeRegExp(AGENT_COMPLETION_SIGNAL)}|${escapeRegExp(AGENT_SAFETY_STOP_SIGNAL)}`,
  'gi'
)

function internalAgentSignalCount(content) {
  return [...String(content || '').matchAll(INTERNAL_AGENT_SIGNAL_PATTERN)].length
}

function stripAgentControlSignals(content) {
  return String(content || '')
    .replace(INTERNAL_AGENT_SIGNAL_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sanitizeChatMessage(message) {
  if (!message || typeof message !== 'object') return message

  const sanitized = { ...message }

  if (typeof message.content === 'string') sanitized.content = stripAgentControlSignals(message.content)
  else if (Array.isArray(message.content)) {
    sanitized.content = message.content.map(part => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part

      return { ...part, text: stripAgentControlSignals(part.text) }
    })
  }

  return sanitized
}

function isSyntheticChatUserMessage(message) {
  if (String(message?.role || '').toLowerCase() !== 'user') return false

  const text = String(message?.content || '').trim()

  return /^(?:\[Codex local tool result\b|\[Codex tool adapter\b|<environment_context>|<app-context>|<permissions instructions>|<collaboration_mode>|<apps_instructions>|<plugins_instructions>|<skills_instructions>|# AGENTS\.md instructions for\b)/i.test(
    text
  )
}

function isConversationAnchor(message) {
  const role = String(message?.role || '').toLowerCase()
  const text = String(message?.content || '').trim()

  if (!text) return false
  if (role === 'user') return !isSyntheticChatUserMessage(message)
  if (role !== 'assistant') return false

  return !/^\[Codex local tool calls\][\s\S]*$/i.test(text)
}

function truncateContextText(content, maximumChars = RECOVERY_MESSAGE_CHARS) {
  const text = String(content || '')

  if (text.length <= maximumChars) return text

  const headLength = Math.floor(maximumChars * 0.6)
  const tailLength = maximumChars - headLength

  return `${text.slice(0, headLength)}\n[...context shortened...]\n${text.slice(-tailLength)}`
}

function recoveryConversationContext(messages, options = {}) {
  const tailMessages = Math.max(1, Number(options.tailMessages || RECOVERY_TAIL_MESSAGES))
  const conversationAnchors = Math.max(1, Number(options.conversationAnchors || RECOVERY_CONVERSATION_ANCHORS))
  const maximumChars = Math.max(500, Number(options.maximumChars || RECOVERY_MESSAGE_CHARS))
  const source = (Array.isArray(messages) ? messages : [])
    .map(sanitizeChatMessage)
    .filter(message => message?.role !== 'system')
  const selected = new Set()

  for (let index = Math.max(0, source.length - tailMessages); index < source.length; index += 1) {
    selected.add(index)
  }

  let anchors = 0

  for (let index = source.length - 1; index >= 0 && anchors < conversationAnchors; index -= 1) {
    if (!isConversationAnchor(source[index])) continue
    selected.add(index)
    anchors += 1
  }

  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (!String(source[index]?.content || '').includes(SUMMARY_PREFIX)) continue
    selected.add(index)
    break
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map(index => ({
      role: source[index].role,
      content: truncateContextText(source[index].content, maximumChars)
    }))
}

module.exports = {
  RECOVERY_CONVERSATION_ANCHORS,
  RECOVERY_MESSAGE_CHARS,
  RECOVERY_TAIL_MESSAGES,
  internalAgentSignalCount,
  isSyntheticChatUserMessage,
  recoveryConversationContext,
  sanitizeChatMessage,
  stripAgentControlSignals,
  truncateContextText
}
