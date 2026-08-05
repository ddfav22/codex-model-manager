const { SUMMARY_PREFIX } = require('./constants')
const { AGENT_COMPLETION_SIGNAL, AGENT_SAFETY_STOP_SIGNAL } = require('./toolContinuation')
const { hasInternalToolResult, isInternalToolCallsOnly } = require('./internalToolTranscript')

const RECOVERY_TAIL_MESSAGES = 8
const RECOVERY_CONVERSATION_ANCHORS = 4
const RECOVERY_MESSAGE_CHARS = 3500
const LEGACY_AGENT_FAILURE_TEXT = '上游模型未能完成剩余步骤，请重试本轮任务。'
const TURN_ABORTED_PATTERN = /<turn_aborted>[\s\S]*?<\/turn_aborted>/gi

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
    .replaceAll(LEGACY_AGENT_FAILURE_TEXT, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function hasTurnAbortedSignal(content) {
  return /<turn_aborted\b/i.test(String(content || ''))
}

function stripTurnAbortedSignal(content) {
  return String(content || '')
    .replace(TURN_ABORTED_PATTERN, '')
    .trim()
}

function isShortContinuationText(content) {
  const text = stripAgentControlSignals(content)
    .replace(/[。！!？?，,；;：:~～\s]+$/g, '')
    .trim()

  if (!text || text.length > 32) return false

  return /^(?:继续|接着|继续吧|接着来|继续做|继续执行|然后呢|往下做|go on|continue|keep going|proceed)$/i.test(text)
}

function isInterruptedContinuationText(content) {
  const text = stripAgentControlSignals(content)
    .replace(/[。！!？?，,；;：:~～\s]+$/g, '')
    .trim()

  if (!text || text.length > 80) return false

  return /^(?:继续|接着|恢复|重试|往下)/i.test(text)
}

function hasRecentInterruptedTurn(messages, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = String(message?.role || '').toLowerCase()

    if (hasTurnAbortedSignal(message?.content)) return true
    if (role === 'user' && !isSyntheticChatUserMessage(message)) return false
  }

  return false
}

function anchorShortContinuation(messages) {
  const rawSource = Array.isArray(messages) ? messages : []
  const source = rawSource.map(sanitizeChatMessage)
  let currentIndex = -1

  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (String(source[index]?.role || '').toLowerCase() !== 'user') continue
    if (isSyntheticChatUserMessage(source[index])) continue
    currentIndex = index
    break
  }

  const interrupted = currentIndex >= 0 && hasRecentInterruptedTurn(rawSource, currentIndex)
  const continuationRequested =
    currentIndex >= 0 &&
    (isShortContinuationText(source[currentIndex]?.content) ||
      (interrupted && isInterruptedContinuationText(source[currentIndex]?.content)))

  if (!continuationRequested) {
    return { messages: source, anchored: false, interrupted: false, task: '', assistantState: '', toolResultCount: 0 }
  }

  let task = ''
  let taskIndex = -1

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const message = source[index]

    if (String(message?.role || '').toLowerCase() !== 'user' || isSyntheticChatUserMessage(message)) continue
    if (isShortContinuationText(message?.content) || isInterruptedContinuationText(message?.content)) continue

    task = truncateContextText(message?.content, 3000)
    taskIndex = index
    break
  }

  if (!task) {
    return { messages: source, anchored: false, interrupted, task: '', assistantState: '', toolResultCount: 0 }
  }

  let assistantState = ''

  for (let index = currentIndex - 1; index > taskIndex; index -= 1) {
    const message = source[index]

    if (String(message?.role || '').toLowerCase() !== 'assistant') continue
    const text = truncateContextText(message?.content, 1800)

    if (!text || isInternalToolCallsOnly(text)) continue
    assistantState = text
    break
  }
  const toolResultCount = source
    .slice(taskIndex + 1, currentIndex)
    .filter(message => String(message?.role || '').toLowerCase() === 'tool').length

  const anchor = [
    interrupted
      ? '[Codex continuation context: the prior turn was manually interrupted and the latest user message means resume that unresolved task; it is not a new task.]'
      : '[Codex continuation context: the short user message above means resume the unresolved prior task; it is not a new task.]',
    `Original task: ${task}`,
    assistantState ? `Latest visible assistant state: ${assistantState}` : '',
    toolResultCount
      ? `Completed tool results already preserved in this conversation: ${toolResultCount}. Continue from the latest result instead of restarting.`
      : '',
    'Continue from that exact task state. Do not ask the user to repeat information already present in the conversation.'
  ]
    .filter(Boolean)
    .join('\n')

  source[currentIndex] = {
    ...source[currentIndex],
    content: `${String(source[currentIndex].content || '').trim()}\n\n${anchor}`
  }

  return { messages: source, anchored: true, interrupted, task, assistantState, toolResultCount }
}

function sanitizeChatMessage(message) {
  if (!message || typeof message !== 'object') return message

  const sanitized = { ...message }

  if (typeof message.content === 'string') {
    sanitized.content = stripTurnAbortedSignal(stripAgentControlSignals(message.content))
  } else if (Array.isArray(message.content)) {
    sanitized.content = message.content.map(part => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part

      return { ...part, text: stripTurnAbortedSignal(stripAgentControlSignals(part.text)) }
    })
  }

  return sanitized
}

function isSyntheticChatUserMessage(message) {
  if (String(message?.role || '').toLowerCase() !== 'user') return false

  const text = String(message?.content || '').trim()

  return (
    hasInternalToolResult(text) ||
    /^(?:<codex_internal_adapter>|\[Codex tool adapter\b|<environment_context>|<app-context>|<permissions instructions>|<collaboration_mode>|<apps_instructions>|<plugins_instructions>|<skills_instructions>|# AGENTS\.md instructions for\b)/i.test(
      text
    )
  )
}

function isConversationAnchor(message) {
  const role = String(message?.role || '').toLowerCase()
  const text = String(message?.content || '').trim()

  if (!text) return false
  if (role === 'user') return !isSyntheticChatUserMessage(message)
  if (role !== 'assistant') return false

  return !isInternalToolCallsOnly(text)
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
  anchorShortContinuation,
  hasTurnAbortedSignal,
  internalAgentSignalCount,
  isInterruptedContinuationText,
  isShortContinuationText,
  isSyntheticChatUserMessage,
  recoveryConversationContext,
  sanitizeChatMessage,
  stripAgentControlSignals,
  truncateContextText
}
