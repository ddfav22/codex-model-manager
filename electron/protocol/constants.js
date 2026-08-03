const DEFAULT_PROTOCOL_PROXY_PORT = 47891
const REASONING_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const ROUTING_METADATA_PREFIX = '[Runtime routing metadata]'
const AGENT_CONTINUATION_INSTRUCTION =
  'Codex owns the agent loop and will execute the tools supplied in this request. Never end a turn by only saying that you will inspect, check, read a skill, run, wait, or continue. Emit the required tool call in the same turn. After a function_call_output or custom_tool_call_output arrives, immediately continue the same task from that result until you provide a completed answer or another necessary tool call. If a real missing user decision or attachment blocks progress, call request_user_input when available or ask one concrete question; do not silently stop.'
const COMPACT_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another language model that will resume the task. Include current progress, key decisions, constraints, user preferences, completed tool results, remaining steps, and critical data or references. Be concise, structured, and focused on seamless continuation.'
const SUMMARY_PREFIX =
  'Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:'
const COMPACTION_PREFIX = 'cmm1:'

module.exports = {
  AGENT_CONTINUATION_INSTRUCTION,
  COMPACTION_PREFIX,
  COMPACT_PROMPT,
  DEFAULT_PROTOCOL_PROXY_PORT,
  REASONING_ORDER,
  ROUTING_METADATA_PREFIX,
  SUMMARY_PREFIX
}
