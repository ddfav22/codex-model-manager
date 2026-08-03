import packageMetadata from '../../../package.json'
import { toUserFacingErrorMessage } from '../../../electron/features/userFacingErrors'

import type { CodexSession, CodexStatus, RelayInput, RelayProvider } from '@/types/codex-manager'

export type Section = 'channels' | 'conversations' | 'skills' | 'agents'
export type Message = { type: 'success' | 'error' | 'info' | 'warning'; text: string }
export type ConfirmState = {
  title: string
  body: string
  confirmText?: string
  action: () => Promise<void>
}
export type AddMode = 'manual' | 'newapi'
export type ConversationScope = 'active' | 'archived'
export type NewApiForm = {
  baseUrl: string
  relayBaseUrl: string
  username: string
  password: string
  rememberPassword: boolean
}

export const APP_VERSION = packageMetadata.version

export const defaultNewApiForm: NewApiForm = {
  baseUrl: '',
  relayBaseUrl: '',
  username: '',
  password: '',
  rememberPassword: true
}

export const emptyForm: RelayInput = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: 'gpt-5.6',
  models: ['gpt-5.6'],
  wireApi: 'chat'
}

export const manualModelSuggestions = [
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'grok-4.5',
  'grok-4.5-latest',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]

export const menuItems: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'channels', label: '渠道管理', icon: 'ri-route-line' },
  { id: 'conversations', label: '对话管理', icon: 'ri-chat-history-line' },
  { id: 'skills', label: 'Skill 管理', icon: 'ri-tools-line' },
  { id: 'agents', label: 'Agent 管理', icon: 'ri-robot-2-line' }
]

export const getBridge = () => window.codexManager

export const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`

  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const formatDate = (value: string) => (value ? new Date(value).toLocaleString('zh-CN') : '-')

export const currentChannel = (status?: CodexStatus) => {
  if (!status) return '读取中'
  if (status.isDefaultProvider) return 'OpenAI 默认渠道'

  return status.providers.find(item => item.active)?.name || status.currentProvider
}

export const providerSource = (provider: RelayProvider) => {
  if (provider.keySource === 'newapi') return 'NewAPI'
  if (provider.source === 'managed') return '本工具'
  if (provider.source === 'managed+codex-config') return '本工具 + Codex'

  return 'Codex 配置'
}

export const wireApiLabel = () => 'Chat Completions'

export const uniqueModels = (values: Array<string | undefined>) => {
  const seen = new Set<string>()
  const models: string[] = []

  values.forEach(value => {
    const model = String(value || '').trim()
    const key = model.toLowerCase()

    if (!model || seen.has(key)) return

    seen.add(key)
    models.push(model)
  })

  return models
}

export const providerModels = (provider: RelayProvider) => uniqueModels([...(provider.models || []), provider.model])

export const modelTest = (provider: RelayProvider, model: string) => provider.modelTests?.[model] || null
export const modelCapability = (provider: RelayProvider, model: string) => provider.modelCapabilities?.[model] || null

export const modelReady = (provider: RelayProvider, model: string) => {
  const test = modelTest(provider, model)
  const capability = modelCapability(provider, model)

  return (
    !provider.managed ||
    (capability?.available === true &&
      test?.ok === true &&
      test.chatOk === true &&
      test.streamOk === true &&
      test.agentToolOk === true)
  )
}

export const modelSummary = (provider: RelayProvider) => {
  const models = providerModels(provider)

  if (!models.length) return '沿用当前模型'
  if (models.length === 1) return models[0]

  const supported = models.filter(model => modelCapability(provider, model)?.available !== false).length
  const passed = models.filter(model => modelReady(provider, model)).length

  return `${models.length} 个模型，${supported} 个已适配，${passed} 个已通过完整检测`
}

export const cleanErrorMessage = (error: unknown) => {
  return toUserFacingErrorMessage(error)
}

export const sessionPlace = (session: CodexSession) => {
  if (session.location === 'archived') return '已归档'
  if (session.location === 'imported') return '已导入'

  return '普通对话'
}
