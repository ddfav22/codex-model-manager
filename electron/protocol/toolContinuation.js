const AGENT_COMPLETION_SIGNAL = '[CODEX_AGENT_LOOP_COMPLETE]'
const AGENT_SAFETY_STOP_SIGNAL = '[CODEX_AGENT_LOOP_SAFETY_STOP]'

function hasAgentCompletionSignal(content) {
  const text = String(content || '').trim()

  return text === AGENT_COMPLETION_SIGNAL || text.endsWith(`\n${AGENT_COMPLETION_SIGNAL}`)
}

function agentCompletionResult(content) {
  const text = String(content || '').trim()

  if (!hasAgentCompletionSignal(text)) return ''

  return text.slice(0, -AGENT_COMPLETION_SIGNAL.length).trim()
}

function awaitsExplicitUserInput(content) {
  const text = String(content || '').trim()

  if (!text) return false

  return [
    /(?:请|需要你|需要用户|还请|请先)(?:提供|选择|确认|上传|附加|授权|告知|指定|重新发送|重新附加)/i,
    /(?:你希望|你要|你想)(?:使用|选择|保存到|我)(?:哪个|哪一个|什么|哪里).{0,60}[？?]$/i,
    /\b(?:please provide|please choose|please confirm|need you to|which .+ would you|do you want me to|could you (?:provide|attach|upload|choose|confirm))\b/i
  ].some(pattern => pattern.test(text))
}

function requiresAgentCompletionSignal(content, options = {}) {
  if (!options.afterToolResult) return false

  const text = String(content || '').trim()

  if (!text || isMalformedToolRecovery(text)) return false
  if (awaitsExplicitUserInput(text)) return hasAgentCompletionSignal(text)
  if (!hasAgentCompletionSignal(text)) return true

  return !agentCompletionResult(text)
}

function followsImmediateToolResult(messages) {
  if (!Array.isArray(messages)) return false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = String(messages[index]?.role || '').toLowerCase()

    if (!role || role === 'system' || role === 'developer') continue

    return role === 'tool'
  }

  return false
}

function responseMessageText(item) {
  if (typeof item?.content === 'string') return item.content
  if (!Array.isArray(item?.content)) return ''

  return item.content
    .map(part => {
      if (typeof part === 'string') return part
      if (['input_text', 'output_text', 'text'].includes(String(part?.type || ''))) return String(part?.text || '')

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function isSyntheticContinuationContext(item) {
  if (String(item?.type || 'message').toLowerCase() !== 'message') return false

  const role = String(item?.role || '').toLowerCase()

  if (role === 'system' || role === 'developer') return true
  if (role !== 'user') return false

  const text = responseMessageText(item).trim()

  return /^(?:<environment_context>|<app-context>|<permissions instructions>|<collaboration_mode>|<apps_instructions>|<plugins_instructions>|<skills_instructions>|# AGENTS\.md instructions for\b)/i.test(
    text
  )
}

function followsImmediateResponsesToolResult(input) {
  if (!Array.isArray(input)) return false

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    const type = String(item?.type || (item?.role ? 'message' : '')).toLowerCase()

    if (type === 'function_call_output' || type === 'custom_tool_call_output') return true
    if (type === 'compaction' || type === 'compaction_trigger' || type === 'reasoning') continue
    if (type === 'message' && isSyntheticContinuationContext(item)) continue

    return false
  }

  return false
}

function latestActionableUserText(messages) {
  if (!Array.isArray(messages)) return ''

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]

    if (String(message?.role || '').toLowerCase() !== 'user') continue

    const text = responseMessageText(message).trim()

    if (text && !isSyntheticContinuationContext(message)) return text
  }

  return ''
}

function requestLikelyRequiresTool(messages, allowedToolNames = []) {
  const text = latestActionableUserText(messages)
  const lowerText = text.toLowerCase()
  const names = [...allowedToolNames].map(name => String(name || '').toLowerCase()).filter(Boolean)

  if (!text || !names.length) return false

  const namedToolRequested = names.some(name =>
    name
      .split(/[^a-z0-9]+/)
      .filter(term => term.length >= 3)
      .some(term => lowerText.includes(term))
  )
  if (namedToolRequested) return true

  const canExecute = names.some(name => /(^|[._-])(?:exec|shell|shell_command)([._-]|$)/i.test(name))
  if (!canExecute) return false

  const currentInformation =
    /(?:(?:今日|今天|当前|现在|最新|实时|此刻|刚刚|本日).{0,80}(?:价格|价|金价|汇率|行情|天气|新闻|比分|赛程|库存|状态|数据)|(?:价格|金价|汇率|行情|天气|新闻|比分|赛程|库存).{0,80}(?:今日|今天|当前|现在|最新|实时|此刻|刚刚|本日))|(?:\b(?:today'?s?|current|latest|live|real[- ]?time|right now)\b.{0,100}\b(?:price|rate|quote|weather|news|score|schedule|availability|status|data)\b)|(?:\b(?:price|rate|quote|weather|news|score|schedule|availability)\b.{0,100}\b(?:today|current|latest|live|real[- ]?time|right now)\b)/i
  const explicitLocalAction =
    /(?:打开|保存|写入|创建|执行|运行|读取|检查|查询|搜索|获取|下载|安装|启动|生成|调用|编辑|删除|移动|复制|截图|浏览网页)|\b(?:open|save|write|create|execute|run|read|inspect|check|query|search|fetch|download|install|start|generate|call|edit|delete|move|copy|screenshot|browse)\b/i

  return currentInformation.test(text) || explicitLocalAction.test(text)
}

function isMalformedToolRecovery(content) {
  const text = String(content || '').trim()

  if (!text) return false
  if (/<codex_(?:tool_call|no_tool)\b/i.test(text)) return true

  if (/^[{[]/.test(text)) {
    try {
      const payload = JSON.parse(text)

      return Boolean(payload && typeof payload === 'object' && ('name' in payload || 'tool' in payload))
    } catch {
      return false
    }
  }

  return false
}

function looksLikePendingMultiStepAction(content) {
  const text = String(content || '')
    .trim()
    .replace(/\s+/g, ' ')

  if (!text || text.length > 800) return false

  const explicitTerminalOutcome =
    /(?:已经|已)(?:经)?(?:成功)?(?:完成|生成|保存|写入|打开|执行|处理)|(?:无法|不能|不支持|未能|失败|出错|不存在|没有可用|无需继续)|(?:请|需要你|需要用户)(?:提供|选择|确认|重新|授权)|\b(?:completed|finished|saved|unable|cannot|can't|failed|not supported|not available|need you to|please provide)\b/i
  const resumesAfterOutcome =
    /(?:接下来|下一步|然后|再|随后|接着|现在).{0,50}(?:会|将|准备|需要|继续|执行|调用|写|创建|获取|查询|打开|保存|运行|读取|检查|生成)/i

  if (explicitTerminalOutcome.test(text) && !resumesAfterOutcome.test(text)) return false

  const action =
    /(?:改用|采用|尝试|写|创建|获取|查询|打开|保存|执行|运行|调用|读取|检查|确认|查找|生成|下载|安装|启动|继续|等待|处理|完成|write|create|fetch|query|open|save|execute|run|call|read|inspect|check|find|generate|download|install|start|continue|wait|finish)/i
  const chineseLead = /^(?:(?:我)?(?:先|接下来|下一步|然后|随后|接着|现在|继续|正在|准备|计划|打算)|改用|采用|尝试)/
  const englishLead =
    /^(?:first|next|then|after that|i(?:'ll| will| am going to)|let me|continuing|preparing to|planning to)\b/i
  const multiStepSequence = /(?:先|首先|first).{0,260}(?:再|然后|随后|接着|并(?:且)?|next|then|after that).{0,260}/i

  return action.test(text) && (chineseLead.test(text) || englishLead.test(text) || multiStepSequence.test(text))
}

function looksLikeStalledToolContinuation(content, options = {}) {
  const text = String(content || '').trim()

  if (!text || /^(?:\{\}|\[\]|null)$/i.test(text)) return true
  if (text.length > 1600) return false
  if (hasAgentCompletionSignal(text)) {
    const result = agentCompletionResult(text)

    if (!result) return true

    return looksLikeStalledToolContinuation(result, { ...options, afterToolResult: options.afterToolResult })
  }

  const terminalConclusion =
    /(?:因此|所以|结论|结果|确认结果).{0,120}(?:无法|不能|不支持|不存在|没有可用|无需|已完成|完成了)|(?:unable|cannot|can't|not supported|not available).{0,120}(?:therefore|so|because)/i

  if (terminalConclusion.test(text)) return false
  if (options.afterToolResult && looksLikePendingMultiStepAction(text)) return true

  return [
    /(?:我|接下来|下一步).{0,40}(?:会|将|准备|需要|先|正在).{0,80}(?:读取|查看|加载|打开|检查|确认|查找|寻找|验证|分析|调用|生成|执行|继续|等待|遵循|按照)/i,
    /(?:我)?(?:先|现在|接下来|下一步)?(?:来)?(?:确认|检查|查看|加载|打开|查找|寻找|找一下|看看|验证|读取).{0,80}(?:是否|有没有|可用|存在|image[-_ ]?gen|图像|图片|工具|技能|skill)/i,
    /(?:按照|遵循|根据).{0,80}(?:图像|图片|image).{0,60}(?:流程|技能|skill).{0,80}(?:读取|查看|加载|打开|调用|执行|生成)/i,
    /(?:已经|已).{0,30}(?:读取|查看|加载|打开|检查).{0,60}(?:接下来|然后|现在).{0,50}(?:会|将|准备|需要)/i,
    /(?:已经|已).{0,30}(?:读取|查看|加载|打开|检查).{0,40}(?:技能|skill)(?:说明|文件|能力)?[。.!]?$/i,
    /\b(?:i(?:'ll| will| am going to)|let me|next i(?:'ll| will)|i need to|i am now going to)\b.{0,180}\b(?:read|inspect|check|confirm|locate|find|verify|analy[sz]e|call|generate|run|continue|wait|follow)\b/i,
    /\b(?:having|have)\s+(?:read|loaded|opened|checked|inspected).{0,160}\b(?:i(?:'ll| will)|next|now i)\b/i
  ].some(pattern => pattern.test(text))
}

function shouldAcceptContinuationRecovery({
  afterToolResult,
  stalledAfterToolResult,
  stalledContinuation,
  retryContent,
  retryToolCall
}) {
  if (retryToolCall) return true
  if (!(stalledContinuation ?? stalledAfterToolResult) || !String(retryContent || '').trim()) return false
  if (requiresAgentCompletionSignal(retryContent, { afterToolResult: Boolean(afterToolResult) })) return false
  if (looksLikeStalledToolContinuation(retryContent, { afterToolResult: Boolean(stalledAfterToolResult) })) return false

  return !isMalformedToolRecovery(retryContent)
}

module.exports = {
  AGENT_COMPLETION_SIGNAL,
  AGENT_SAFETY_STOP_SIGNAL,
  agentCompletionResult,
  awaitsExplicitUserInput,
  followsImmediateToolResult,
  followsImmediateResponsesToolResult,
  hasAgentCompletionSignal,
  isMalformedToolRecovery,
  isSyntheticContinuationContext,
  latestActionableUserText,
  looksLikePendingMultiStepAction,
  looksLikeStalledToolContinuation,
  requestLikelyRequiresTool,
  requiresAgentCompletionSignal,
  shouldAcceptContinuationRecovery
}
