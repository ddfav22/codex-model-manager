'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'

import type {
  AppUpdateState,
  CodexActivationProgress,
  CodexDiskUsage,
  CodexProject,
  CodexSession,
  CodexStatus,
  ConversationDeleteFilters,
  ConversationTransferKind,
  LocalToolRuntimeStatus,
  RelayInput,
  RelayProvider,
  RuntimeDiagnosticSummary
} from '@/types/codex-manager'
import {
  APP_VERSION,
  cleanErrorMessage,
  currentChannel,
  defaultNewApiForm,
  emptyForm,
  formatBytes,
  getBridge,
  manualModelSuggestions,
  menuItems,
  modelCapability,
  modelReady,
  providerModels,
  uniqueModels,
  wireApiLabel
} from './modelManagerCore'
import type { AddMode, ConfirmState, ConversationScope, Message, NewApiForm, Section } from './modelManagerCore'
import {
  channelGridColumns,
  channelGridMinWidth,
  EmptyState,
  listSurfaceSx,
  SectionHeader
} from './components/ManagerLayout'
import { ProjectRow, SessionRow } from './components/ConversationRows'
import { ConversationTransferDialog } from './components/ConversationTransferDialog'
import { ChannelRow } from './components/ChannelRow'
import { PackageRow } from './components/PackageRow'
import { PathDisclosure } from './components/PathDisclosure'
import { UpdateButton } from './components/UpdateButton'

const ModelManager = () => {
  const [status, setStatus] = useState<CodexStatus>()
  const [section, setSection] = useState<Section>('channels')
  const [form, setForm] = useState<RelayInput>(emptyForm)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('manual')
  const [newApiForm, setNewApiForm] = useState<NewApiForm>(defaultNewApiForm)
  const [savedApiKey, setSavedApiKey] = useState('')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [helpOpen, setHelpOpen] = useState<Section>()
  const [githubOpen, setGithubOpen] = useState<'skills' | 'agents'>()
  const [githubUrl, setGithubUrl] = useState('')
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState>()
  const [testingChannelId, setTestingChannelId] = useState<string>()
  const [selectingKeyId, setSelectingKeyId] = useState<string>()
  const [refreshingChannelId, setRefreshingChannelId] = useState<string>()
  const [selectedKeys, setSelectedKeys] = useState<Record<string, string>>({})
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({})
  const [pendingApply, setPendingApply] = useState<Record<string, boolean>>({})
  const [conversationScope, setConversationScope] = useState<ConversationScope>('active')
  const [conversationQuery, setConversationQuery] = useState('')
  const [conversationProject, setConversationProject] = useState('')
  const [conversationTransferMode, setConversationTransferMode] = useState<'import' | 'export'>()
  const [busy, setBusy] = useState(false)
  const [activationProgress, setActivationProgress] = useState<CodexActivationProgress>()
  const [activationElapsedMs, setActivationElapsedMs] = useState(0)
  const [message, setMessage] = useState<Message>()
  const [bridgeReady, setBridgeReady] = useState(false)
  const [toolRuntimeOpen, setToolRuntimeOpen] = useState(false)
  const [toolRuntimeBusy, setToolRuntimeBusy] = useState(false)
  const [toolRuntime, setToolRuntime] = useState<LocalToolRuntimeStatus>()
  const [diskMaintenanceOpen, setDiskMaintenanceOpen] = useState(false)
  const [diskMaintenanceBusy, setDiskMaintenanceBusy] = useState(false)
  const [diskUsage, setDiskUsage] = useState<CodexDiskUsage>()
  const [runtimeDiagnostic, setRuntimeDiagnostic] = useState<RuntimeDiagnosticSummary>()

  const [updateState, setUpdateState] = useState<AppUpdateState>({
    stage: 'idle',
    currentVersion: APP_VERSION,
    latestVersion: '',
    message: '尚未检查更新',
    manual: false,
    downloadPercent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    releaseUrl: '',
    releaseNotes: ''
  })

  const keySelectionQueue = useRef<Record<string, string | undefined>>({})
  const keySelectionRunning = useRef(new Set<string>())
  const activeActivationOperation = useRef('')
  const activationStartedAt = useRef(0)
  const activationClearTimer = useRef<ReturnType<typeof setTimeout>>()
  const previousUpdateStage = useRef(updateState.stage)

  const activeLabel = useMemo(() => currentChannel(status), [status])
  const activationOperationId = activationProgress?.operationId
  const activationRunning = activationProgress?.status === 'running'
  const issues = status?.diagnostics.issues || []
  const editingProvider = form.id ? status?.providers.find(provider => provider.id === form.id) : undefined
  const displayedApiKey = form.apiKey || (apiKeyVisible ? savedApiKey : '')

  const sessionCounts = useMemo(
    () => ({
      active: status?.sessions.filter(session => session.location !== 'archived').length || 0,
      archived: status?.sessions.filter(session => session.location === 'archived').length || 0
    }),
    [status]
  )

  const filteredSessions = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase()
    const selectedProject = conversationProject.toLowerCase()

    return (status?.sessions || []).filter(session => {
      const inScope =
        conversationScope === 'archived' ? session.location === 'archived' : session.location !== 'archived'

      const cwd = session.cwd.toLowerCase()

      const inProject =
        !selectedProject ||
        cwd === selectedProject ||
        cwd.startsWith(`${selectedProject}\\`) ||
        cwd.startsWith(`${selectedProject}/`)

      const matchesQuery =
        !query ||
        [session.title, session.id, session.cwd, session.path].some(value => value.toLowerCase().includes(query))

      return inScope && inProject && matchesQuery
    })
  }, [conversationProject, conversationQuery, conversationScope, status])

  const filteredProjects = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase()
    const selectedProject = conversationProject.toLowerCase()

    return (status?.projects || []).filter(project => {
      const inProject = !selectedProject || project.path.toLowerCase() === selectedProject

      const matchesQuery =
        !query || [project.name, project.path, project.trustLevel].some(value => value.toLowerCase().includes(query))

      return inProject && matchesQuery
    })
  }, [conversationProject, conversationQuery, status])

  const requireBridge = () => {
    const bridge = getBridge()

    if (!bridge) throw new Error('请通过桌面程序打开，不要直接用浏览器打开。')

    return bridge
  }

  const refresh = async (forceCodexTargetScan = false) => {
    const bridge = getBridge()

    if (!bridge) return

    setStatus(await bridge.getStatus(forceCodexTargetScan))
  }

  const inspectToolRuntime = async () => {
    setToolRuntimeOpen(true)
    setToolRuntimeBusy(true)

    try {
      setToolRuntime(await requireBridge().inspectLocalToolRuntime())
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    } finally {
      setToolRuntimeBusy(false)
    }
  }

  const inspectDiskUsage = async () => {
    setDiskMaintenanceOpen(true)
    setDiskMaintenanceBusy(true)

    try {
      setDiskUsage(await requireBridge().inspectDiskUsage())
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    } finally {
      setDiskMaintenanceBusy(false)
    }
  }

  const openRuntimeLog = async () => {
    try {
      const result = await requireBridge().openRuntimeLog()

      if (!result.ok) throw new Error(result.error || '运行日志暂不可用')
      setMessage({ type: 'success', text: `已定位运行日志：${result.path}` })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    }
  }

  const maintainDisk = async () => {
    setDiskMaintenanceBusy(true)

    try {
      const result = await requireBridge().maintainDisk()

      const restartText = result.restart?.ok
        ? result.restart.skipped
          ? ''
          : '，Codex 已重新启动'
        : `；Codex 自动重启未完成：${
            result.restart?.error ? cleanErrorMessage(result.restart.error) : '请手动重新打开'
          }`

      setDiskUsage(result.after)
      setMessage({
        type: result.errors.length || result.restart?.ok === false ? 'warning' : 'success',
        text: `磁盘维护完成，已回收 ${formatBytes(result.removedBytes)}，会话、项目和登录数据均已保留${restartText}${
          result.errors.length ? `；${result.errors.length} 项因占用或权限不足未清理` : ''
        }。`
      })
    } finally {
      setDiskMaintenanceBusy(false)
    }
  }

  const confirmDiskMaintenance = () => {
    if (!diskUsage?.reclaimableBytes) return

    setConfirmDialog({
      title: '确认一键磁盘维护',
      body: [
        `预计可回收：${formatBytes(diskUsage.reclaimableBytes)}`,
        '',
        '将关闭 Codex，删除可重建的日志数据库、旧日志、临时目录和普通缓存，然后重新启动 Codex。',
        '',
        `不会删除：${formatBytes(diskUsage.sessionBytes + diskUsage.archivedSessionBytes)} 的对话记录、项目、登录、Provider、API Key、Skills 或 Agents。`
      ].join('\n'),
      confirmText: '开始维护',
      action: maintainDisk
    })
  }

  const initializeToolRuntime = async (mode: 'elevated' | 'unelevated') => {
    setToolRuntimeBusy(true)
    setMessage(undefined)

    try {
      const result = await requireBridge().initializeLocalToolRuntime(mode)

      setToolRuntime(result.after)
      setMessage({
        type: 'success',
        text: result.initialized
          ? `本地工具环境已用${mode === 'elevated' ? '管理员' : '兼容'}模式初始化，PowerShell 沙箱自检通过。`
          : '本地工具环境已经就绪，无需重复初始化。'
      })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })

      try {
        setToolRuntime(await requireBridge().inspectLocalToolRuntime())
      } catch {
        // Keep the original setup error visible.
      }
    } finally {
      setToolRuntimeBusy(false)
    }
  }

  const repairToolRuntime = async () => {
    setToolRuntimeBusy(true)
    setMessage(undefined)

    try {
      const result = await requireBridge().repairLocalToolRuntime('elevated')

      setToolRuntime(result.after)
      const repairedFiles = result.configRepair?.files?.length ? `；已重置 ${result.configRepair.files.join('、')}` : ''

      const restartText = result.restart?.ok
        ? '；ChatGPT 已重启'
        : result.restart?.error
          ? `；重启提示：${cleanErrorMessage(result.restart.error)}`
          : ''

      setMessage({
        type: result.after.healthy ? (result.after.doctorProviderIssues?.length ? 'warning' : 'success') : 'error',
        text: result.after.healthy
          ? result.after.doctorProviderIssues?.length
            ? `本地 Shell 与 Sandbox 已通过，无需重复修复；当前渠道存在异常：${
                result.after.doctorProviderIssues.map(item => cleanErrorMessage(item.summary)).join('；') ||
                (result.warning ? cleanErrorMessage(result.warning) : '') ||
                '请启用已测试通过的渠道'
              }`
            : result.repaired
              ? `本地工具环境修复完成，Windows Sandbox、PowerShell 和本地命令均通过${repairedFiles}${restartText}。`
              : result.warning
                ? cleanErrorMessage(result.warning)
                : '本地工具环境已经正常，无需修复。'
          : result.warning
            ? cleanErrorMessage(result.warning)
            : '本地工具环境修复后仍未通过，请查看错误明细。'
      })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })

      try {
        setToolRuntime(await requireBridge().inspectLocalToolRuntime())
      } catch {
        // Keep the original repair error visible.
      }
    } finally {
      setToolRuntimeBusy(false)
    }
  }

  useEffect(() => {
    setBridgeReady(Boolean(getBridge()))
    refresh(false).catch(error => setMessage({ type: 'error', text: cleanErrorMessage(error) }))
  }, [])

  useEffect(() => {
    const bridge = getBridge()

    if (!bridge) return

    bridge
      .getUpdateState()
      .then(setUpdateState)
      .catch(error => setMessage({ type: 'error', text: cleanErrorMessage(error) }))

    return bridge.onUpdateState(nextState => {
      const lastStage = previousUpdateStage.current

      previousUpdateStage.current = nextState.stage
      setUpdateState(nextState)

      if (nextState.stage === 'ready' && lastStage !== 'ready') {
        setMessage({ type: 'info', text: `新版本 ${nextState.latestVersion} 已下载，点击“重启更新”即可安装。` })
      }
    })
  }, [])

  useEffect(() => {
    const bridge = getBridge()

    if (!bridge?.getRuntimeDiagnosticSummary || !bridge.onRuntimeDiagnostic) return

    bridge
      .getRuntimeDiagnosticSummary()
      .then(diagnostic => setRuntimeDiagnostic(diagnostic || undefined))
      .catch(() => {})

    return bridge.onRuntimeDiagnostic(setRuntimeDiagnostic)
  }, [])

  useEffect(() => {
    const bridge = getBridge()

    if (!bridge?.onApplyRelayProgress) return

    return bridge.onApplyRelayProgress(progress => {
      if (!activeActivationOperation.current || progress.operationId !== activeActivationOperation.current) return

      setActivationProgress(current => {
        if (current && current.status !== 'running' && progress.status === 'running') return current
        if (current && progress.progress < current.progress) return current

        return {
          ...progress,
          progress: Math.min(100, Math.max(0, progress.progress))
        }
      })
    })
  }, [])

  useEffect(() => {
    if (!activationRunning) return

    const updateElapsed = () => setActivationElapsedMs(Math.max(0, Date.now() - activationStartedAt.current))

    updateElapsed()
    const timer = window.setInterval(updateElapsed, 500)

    return () => window.clearInterval(timer)
  }, [activationOperationId, activationRunning])

  useEffect(
    () => () => {
      if (activationClearTimer.current) clearTimeout(activationClearTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!status) return

    setSelectedModels(current => {
      const next = { ...current }

      status.providers.forEach(provider => {
        const models = providerModels(provider)
        const selected = next[provider.id]
        const supported = models.filter(model => modelCapability(provider, model)?.available !== false)

        const preferred =
          provider.model && modelCapability(provider, provider.model)?.available !== false
            ? provider.model
            : supported[0] || models[0] || ''

        if (!selected || !models.includes(selected) || modelCapability(provider, selected)?.available === false) {
          next[provider.id] = preferred
        }
      })

      return next
    })
  }, [status])

  useEffect(() => {
    if (!status) return

    setSelectedKeys(current => {
      const next = { ...current }

      status.providers.forEach(provider => {
        if (provider.keySource !== 'newapi' || keySelectionRunning.current.has(provider.id)) return

        const available = (provider.newApi?.keys || []).map(key => String(key.id ?? key.name))
        const selected = String(provider.newApi?.selectedTokenId ?? provider.newApi?.tokenId ?? '')

        next[provider.id] = available.includes(selected) ? selected : available[0] || ''
      })

      return next
    })
  }, [status])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage(undefined)

    try {
      await action()
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const rememberedNewApiForm = (): NewApiForm => ({
    baseUrl: status?.newApi?.baseUrl || defaultNewApiForm.baseUrl,
    relayBaseUrl: status?.newApi?.relayBaseUrl || defaultNewApiForm.relayBaseUrl,
    username: status?.newApi?.username || '',
    password: '',
    rememberPassword: status?.newApi?.rememberPassword !== false
  })

  const openAddDialog = (provider?: RelayProvider) => {
    setAddMode('manual')
    setForm(
      provider
        ? {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            apiKey: '',
            model: provider.model || 'gpt-5.6',
            models: providerModels(provider).length ? providerModels(provider) : [provider.model || 'gpt-5.6'],
            wireApi: 'chat'
          }
        : emptyForm
    )
    setNewApiForm(rememberedNewApiForm())
    setSavedApiKey('')
    setApiKeyVisible(false)
    setAddOpen(true)
  }

  const toggleApiKeyVisibility = async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false)

      return
    }

    try {
      if (form.id && !form.apiKey && !savedApiKey) {
        const result = await requireBridge().getRelayApiKey(form.id)

        setSavedApiKey(result.apiKey)
      }

      setApiKeyVisible(true)
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    }
  }

  const changeAddMode = (mode: AddMode) => {
    setAddMode(mode)

    if (mode === 'newapi') {
      setNewApiForm(current => ({
        ...rememberedNewApiForm(),
        ...current,
        baseUrl: current.baseUrl || status?.newApi?.baseUrl || defaultNewApiForm.baseUrl,
        relayBaseUrl: current.relayBaseUrl || status?.newApi?.relayBaseUrl || defaultNewApiForm.relayBaseUrl
      }))
    }
  }

  const syncNewApi = () =>
    run(async () => {
      const result = await requireBridge().syncNewApi(newApiForm)
      const usableCount = result.tokens.filter(token => token.status === 1 && token.apiKey).length

      setStatus(await requireBridge().getStatus())
      setAddOpen(false)
      setMessage({
        type: 'success',
        text: `在线平台已同步，共发现 ${usableCount} 个可用 Key；每个 Key 的 /v1/models 模型会全部列出，完整检测通过的模型才同步到 Codex。`
      })
    })

  const saveRelay = () =>
    run(async () => {
      const models = uniqueModels(form.models?.length ? form.models : [form.model])
      const result = await requireBridge().saveRelay({ ...form, model: models[0] || form.model, models })

      setStatus(result.status)
      setForm(emptyForm)
      setAddOpen(false)
      setMessage({ type: 'success', text: `已保存：${result.channel.name}，请在列表中测试全部模型后启用。` })
    })

  const runOnlineKeyQueue = async (id: string) => {
    if (keySelectionRunning.current.has(id)) return

    keySelectionRunning.current.add(id)
    setSelectingKeyId(id)
    setMessage(undefined)

    try {
      while (keySelectionQueue.current[id]) {
        const tokenId = keySelectionQueue.current[id] as string

        keySelectionQueue.current[id] = undefined

        try {
          const result = await requireBridge().selectNewApiKey(id, tokenId)

          if (keySelectionQueue.current[id]) continue

          const isActive = result.status.providers.some(provider => provider.id === id && provider.active)

          setStatus(result.status)
          setSelectedModels(current => ({ ...current, [id]: result.models[0] || '' }))
          if (isActive) setPendingApply(current => ({ ...current, [id]: true }))
          setMessage({
            type: 'success',
            text: `已读取该 Key 的全部 ${result.models.length} 个模型；请点击“检测全部”，通过完整检测的模型会一起进入 Codex 内部切换列表。`
          })
        } catch (error) {
          if (keySelectionQueue.current[id]) continue

          const latestStatus = await requireBridge().getStatus()
          const provider = latestStatus.providers.find(item => item.id === id)
          const selected = String(provider?.newApi?.selectedTokenId ?? provider?.newApi?.tokenId ?? '')

          setStatus(latestStatus)
          setSelectedKeys(current => ({ ...current, [id]: selected }))
          setMessage({ type: 'error', text: cleanErrorMessage(error) })
        }
      }
    } finally {
      keySelectionRunning.current.delete(id)
      setSelectingKeyId(current => (current === id ? undefined : current))
    }
  }

  const selectOnlineKey = (id: string, tokenId: string | number) => {
    const selected = String(tokenId)

    setSelectedKeys(current => ({ ...current, [id]: selected }))
    keySelectionQueue.current[id] = selected
    void runOnlineKeyQueue(id)
  }

  const refreshOnlineChannel = async (id: string) => {
    setRefreshingChannelId(id)
    setMessage(undefined)

    try {
      const result = await requireBridge().refreshNewApiChannel(id)
      const isActive = result.status.providers.some(provider => provider.id === id && provider.active)

      setStatus(result.status)
      if (isActive) setPendingApply(current => ({ ...current, [id]: true }))
      setMessage({
        type: 'success',
        text: result.refreshedKeys
          ? `在线平台刷新完成：${result.tokens.length} 个 Key，当前 Key 有 ${result.modelCount || 0} 个实际模型。`
          : `当前 Key 的模型刷新完成：读取到 ${result.modelCount || 0} 个实际模型，请重新测试后同步。`
      })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    } finally {
      setRefreshingChannelId(undefined)
    }
  }

  const testChannel = async (id: string) => {
    setTestingChannelId(id)
    setMessage(undefined)

    try {
      const result = await requireBridge().testSavedRelay(id)
      const provider = result.status.providers.find(item => item.id === id)

      const eligibleModels = provider
        ? providerModels(provider).filter(model => modelCapability(provider, model)?.available === true)
        : []

      const readyModels = provider ? eligibleModels.filter(model => modelReady(provider, model)) : []

      setStatus(result.status)

      if (!result.test.ok) {
        setMessage({
          type: 'error',
          text: `全模型兼容性检测完成：${readyModels.length}/${eligibleModels.length} 个已适配模型通过。${cleanErrorMessage(
            result.test.message
          )}`
        })

        return
      }

      setMessage({
        type: 'success',
        text: `当前 Key 的 ${readyModels.length} 个已适配模型全部通过聊天、流式响应和工具续答检测；同步并重启后会一起进入 Codex 内部切换列表。总耗时 ${
          result.test.latencyMs || 0
        } ms。`
      })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) || '测试失败' })
    } finally {
      setTestingChannelId(undefined)
    }
  }

  const applyRelay = async (id: string, model: string) => {
    const operationId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const startedAt = new Date().toISOString()

    if (activationClearTimer.current) clearTimeout(activationClearTimer.current)
    activeActivationOperation.current = operationId
    activationStartedAt.current = Date.now()
    setActivationElapsedMs(0)
    setActivationProgress({
      operationId,
      channelId: id,
      model,
      stage: 'starting',
      progress: 1,
      message: '正在提交配置并启动 Codex',
      status: 'running',
      updatedAt: startedAt
    })
    setBusy(true)
    setMessage(undefined)

    try {
      const result = await requireBridge().applyRelay(id, model, operationId)
      const restartOk = result.restart?.ok === true

      const finalProgress: CodexActivationProgress = {
        operationId,
        channelId: id,
        model,
        stage: restartOk ? 'complete' : 'manual-restart-required',
        progress: 100,
        message: restartOk ? 'Codex 已启动，可以开始使用' : '配置已完成，但自动启动未完成',
        status: restartOk ? 'success' : 'warning',
        updatedAt: new Date().toISOString()
      }

      setStatus(result.status)
      setPendingApply(current => ({ ...current, [id]: false }))
      setActivationElapsedMs(Date.now() - activationStartedAt.current)
      setActivationProgress(finalProgress)
      setMessage(
        restartOk
          ? {
              type: 'success',
              text: `已同步模型 ${model}，API Key 登录已自动写入，Codex 已重新启动。历史任务、Projects 和动态模型目录均保留。`
            }
          : {
              type: 'info',
              text: `渠道、API Key 和模型 ${model} 已写入，但自动重启未完成：${
                result.restart?.error ? cleanErrorMessage(result.restart.error) : '请手动重新打开 Codex。'
              }`
            }
      )
      activationClearTimer.current = setTimeout(
        () => {
          if (activeActivationOperation.current !== operationId) return
          setActivationProgress(undefined)
          activeActivationOperation.current = ''
        },
        restartOk ? 5000 : 10000
      )
    } catch (error) {
      const errorText = cleanErrorMessage(error)

      setActivationElapsedMs(Date.now() - activationStartedAt.current)
      setActivationProgress({
        operationId,
        channelId: id,
        model,
        stage: 'failed',
        progress: 100,
        message: 'Codex 配置或启动失败，请查看下方错误提示',
        status: 'error',
        updatedAt: new Date().toISOString()
      })
      setMessage({ type: 'error', text: errorText })
    } finally {
      setBusy(false)
    }
  }

  const selectModel = (id: string, model: string) => setSelectedModels(current => ({ ...current, [id]: model }))

  const restoreDefault = () =>
    run(async () => {
      const result = await requireBridge().restoreDefault()

      setStatus(result.status)
      setMessage({
        type: 'success',
        text: '已恢复 OpenAI 默认渠道。程序不会自动打开 Codex，请手动关闭并重新打开 Codex。'
      })
    })

  const restoreInitialBackup = () =>
    setConfirmDialog({
      title: '恢复初始 Codex 状态',
      body: '将恢复本工具第一次运行时的 Provider、API 登录状态、config.toml 和模型目录。\n\n如果当时是全新、未登录的 ChatGPT.exe，恢复后也会回到未登录状态。项目与历史对话不会删除。',
      confirmText: '恢复初始状态',
      action: async () => {
        const result = await requireBridge().restoreInitialBackup()

        setStatus(result.status)
        setMessage({
          type: 'success',
          text: '已恢复初始 Codex 状态。程序不会自动打开 Codex，请手动关闭并重新打开 Codex。'
        })
      }
    })

  const removeRelay = (id: string) =>
    run(async () => {
      setStatus(await requireBridge().removeRelay(id))
      setMessage({ type: 'success', text: '中转站已删除。' })
    })

  const openPath = (targetPath: string) =>
    run(async () => {
      const result = await requireBridge().openPath(targetPath)

      if (!result.ok) throw new Error(result.error || '无法打开位置')
    })

  const deleteSession = (session: CodexSession) =>
    setConfirmDialog({
      title: '永久删除对话',
      body: `将永久删除“${session.title}”的本地对话记录。\n\n如果文件正被 Codex 使用，程序会提示你先关闭相关程序后重试。\n\n此操作不可恢复。`,
      confirmText: '永久删除',
      action: async () => {
        const result = await requireBridge().deleteSession(session.path)

        setStatus(result.status)
        setMessage({ type: 'success', text: '对话文件已永久删除。' })
      }
    })

  const deleteFilteredConversationData = () => {
    const filters: ConversationDeleteFilters = {
      scope: conversationScope,
      query: conversationQuery,
      projectPath: conversationProject
    }

    const projectText = conversationProject
      ? `当前项目：${conversationProject}`
      : conversationQuery
        ? `当前搜索：${conversationQuery}`
        : conversationScope === 'archived'
          ? '当前范围：全部已归档对话'
          : '当前范围：全部未归档对话'

    setConfirmDialog({
      title: '一键删除对话和项目文件夹',
      body:
        `${projectText}\n\n` +
        `将永久删除当前筛选范围内的 ${filteredSessions.length} 个对话文件，并删除相关项目文件夹/项目记录（当前列表 ${filteredProjects.length} 个项目）。\n\n` +
        '项目文件夹会从磁盘删除；受保护目录会被自动跳过。如果对话文件正被 Codex 占用，程序会关闭 Codex 后重试。此操作不可恢复。',
      confirmText: '永久删除',
      action: async () => {
        const result = await requireBridge().deleteConversationData(filters)

        const hasWarnings =
          result.skippedSessionCount > 0 ||
          result.skippedProjectCount > 0 ||
          Boolean(result.configurationError) ||
          result.indexRefresh?.ok === false

        const warningParts = [
          result.skippedSessionCount ? `${result.skippedSessionCount} 个对话因占用或权限问题未删除` : '',
          result.skippedProjectCount ? `${result.skippedProjectCount} 个项目因路径保护或占用被跳过` : '',
          result.configurationError ? '项目配置更新失败' : '',
          result.indexRefresh?.ok === false ? 'Codex 对话索引未能自动刷新，请手动重启 Codex' : '',
          result.stoppedProcessCount ? `为释放占用已关闭 ${result.stoppedProcessCount} 个 Codex 进程` : ''
        ].filter(Boolean)

        setStatus(result.status)
        setMessage({
          type: hasWarnings ? 'warning' : 'success',
          text: `已删除 ${result.deletedSessionCount} 个对话、${result.deletedProjectCount} 个项目文件夹${
            warningParts.length ? `；${warningParts.join('；')}。` : '。'
          }`
        })
      }
    })
  }

  const importConversationData = (kind: ConversationTransferKind) =>
    run(async () => {
      const result = await requireBridge().importConversationData(kind)

      setConversationTransferMode(undefined)
      if (!result) return
      setStatus(result.status)
      setMessage({ type: 'success', text: kind === 'session' ? '会话导入完成。' : '项目导入完成。' })
    })

  const repairConversationIndex = () =>
    run(async () => {
      const result = await requireBridge().repairConversationIndex()

      setStatus(result.status)

      if (!result.ok) {
        throw new Error(`仍有 ${result.missingSessionCount} 个本地对话未写入 Codex 客户端索引。`)
      }

      setMessage(
        result.restart?.ok === false
          ? {
              type: 'info',
              text: `客户端索引已处理，但仍有异常；请查看日志后手动重新打开 Codex。`
            }
          : {
              type: 'success',
              text: `客户端索引已修复：${result.indexedAfterCount} 个对话。请手动关闭并重新打开 Codex。`
            }
      )
    })

  const exportConversationData = (kind: ConversationTransferKind, sourcePath: string) =>
    run(async () => {
      const result = await requireBridge().exportConversationData(kind, sourcePath)

      setConversationTransferMode(undefined)
      if (!result) return
      setMessage({ type: 'success', text: kind === 'session' ? '会话已导出。' : '项目压缩包已导出。' })
    })

  const deleteProject = (project: CodexProject) =>
    setConfirmDialog({
      title: '删除项目记录',
      body: `${project.name}\n只会从 Codex 项目列表删除，不会删除磁盘上的项目文件。`,
      confirmText: '删除',
      action: async () => {
        setStatus(await requireBridge().deleteProject(project.path))
        setMessage({ type: 'success', text: '项目已从配置中删除。' })
      }
    })

  const importZip = (kind: 'skills' | 'agents') =>
    run(async () => {
      const bridge = requireBridge()
      const nextStatus = kind === 'skills' ? await bridge.importSkillZip() : await bridge.importAgentZip()

      if (!nextStatus) return
      setStatus(nextStatus)
      setMessage({ type: 'success', text: `${kind === 'skills' ? 'Skill' : 'Agent'} 导入完成。` })
    })

  const importFromGithub = () =>
    run(async () => {
      const bridge = requireBridge()

      if (!githubUrl.trim()) throw new Error('请输入 GitHub zip 下载地址')

      setStatus(
        githubOpen === 'skills'
          ? await bridge.importSkillFromGithub(githubUrl.trim())
          : await bridge.importAgentFromGithub(githubUrl.trim())
      )
      setGithubUrl('')
      setGithubOpen(undefined)
      setMessage({ type: 'success', text: 'GitHub zip 已导入。' })
    })

  const exportPackage = (kind: 'skills' | 'agents', identifier: string) =>
    run(async () => {
      const bridge = requireBridge()
      const result = kind === 'skills' ? await bridge.exportSkill(identifier) : await bridge.exportAgent(identifier)
      const displayName = identifier.split(/[\\/]/).pop() || identifier

      if (result) setMessage({ type: 'success', text: `${displayName} 已导出。` })
    })

  const checkForUpdates = async () => {
    setMessage(undefined)

    try {
      const nextState = await requireBridge().checkForUpdates(true)

      setUpdateState(nextState)
      if (nextState.stage === 'up-to-date') setMessage({ type: 'success', text: nextState.message })
      else if (nextState.stage === 'ready') setMessage({ type: 'info', text: nextState.message })
      else if (nextState.stage === 'error') setMessage({ type: 'error', text: cleanErrorMessage(nextState.message) })
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    }
  }

  const installUpdate = async () => {
    setMessage({ type: 'info', text: '正在关闭程序并安装更新，请稍候。' })

    try {
      await requireBridge().installUpdate()
    } catch (error) {
      setMessage({ type: 'error', text: cleanErrorMessage(error) })
    }
  }

  const renderChannels = () => (
    <Stack spacing={4}>
      <SectionHeader
        title={`渠道管理 · v${APP_VERSION}`}
        count={(status?.providers.length || 0) + 1}
        onHelp={() => setHelpOpen('channels')}
        action={
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <UpdateButton state={updateState} onCheck={checkForUpdates} onInstall={installUpdate} />
            <Button
              variant='contained'
              disabled={busy}
              startIcon={<i className='ri-add-line' />}
              onClick={() => openAddDialog()}
            >
              添加渠道
            </Button>
          </Stack>
        }
      />
      <Divider />
      <Box sx={{ ...listSurfaceSx, overflowX: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: channelGridColumns,
            gap: 1.5,
            minInlineSize: channelGridMinWidth,
            px: 3,
            py: 2,
            bgcolor: 'action.hover'
          }}
        >
          {['渠道', 'URL', 'Key', '模型', '状态', '操作'].map(label => (
            <Typography key={label} variant='caption' color='text.secondary' fontWeight={600}>
              {label}
            </Typography>
          ))}
        </Box>
        <Divider />
        <Box sx={{ px: 3, py: 1.5, bgcolor: 'background.paper' }}>
          <Typography variant='caption' color='text.secondary' fontWeight={700} letterSpacing={0.8}>
            本地渠道
          </Typography>
        </Box>
        <Divider />
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: channelGridColumns,
            gap: 1.5,
            alignItems: 'center',
            minInlineSize: channelGridMinWidth,
            mx: 2,
            my: 1.5,
            px: 2.5,
            py: 2.5,
            border: 1,
            borderColor: status?.isDefaultProvider ? 'success.main' : 'divider',
            borderRadius: 2,
            bgcolor: status?.isDefaultProvider ? 'success.lighterOpacity' : 'background.paper',
            boxShadow: '0 2px 10px rgba(47, 43, 61, 0.05)'
          }}
        >
          <Stack spacing={0.5} sx={{ minInlineSize: 0 }}>
            <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
              <Typography variant='body2' fontWeight={600} noWrap>
                OpenAI 默认渠道
              </Typography>
              {status?.isDefaultProvider && <Chip color='success' size='small' variant='tonal' label='使用中' />}
            </Stack>
            <Typography variant='caption' color='text.secondary' noWrap>
              原生
            </Typography>
          </Stack>
          <Typography variant='body2' color='text.secondary'>
            Codex 原生配置
          </Typography>
          <Typography variant='body2' color='text.secondary'>
            ChatGPT 登录
          </Typography>
          <Typography variant='body2' noWrap>
            {status?.isDefaultProvider ? status.currentModel || '默认模型' : '默认模型'}
          </Typography>
          <Chip size='small' variant='outlined' label='可用' sx={{ justifySelf: 'flex-start' }} />
          <Stack direction='row' spacing={1} justifyContent='flex-end' alignItems='center'>
            <Button
              size='small'
              variant='outlined'
              sx={{ minInlineSize: 48, px: 1.5 }}
              disabled={busy || status?.isDefaultProvider}
              onClick={restoreDefault}
            >
              启用
            </Button>
          </Stack>
        </Box>
        {!!status?.providers.filter(provider => provider.keySource !== 'newapi').length && <Divider />}
        {status?.providers
          .filter(provider => provider.keySource !== 'newapi')
          .map(provider => (
            <Box key={provider.id}>
              <ChannelRow
                provider={provider}
                busy={busy}
                testing={testingChannelId === provider.id}
                selectingKey={selectingKeyId === provider.id}
                refreshing={refreshingChannelId === provider.id}
                activating={activationProgress?.channelId === provider.id && activationProgress.status === 'running'}
                pendingApply={Boolean(pendingApply[provider.id])}
                selectedKeyId={selectedKeys[provider.id] || ''}
                selectedModel={selectedModels[provider.id] || provider.model}
                onSelectedModelChange={selectModel}
                onKeyChange={selectOnlineKey}
                onRefresh={refreshOnlineChannel}
                onTest={testChannel}
                onApply={applyRelay}
                onEdit={openAddDialog}
                onRemove={removeRelay}
              />
            </Box>
          ))}
        {!!status?.providers.filter(provider => provider.keySource === 'newapi').length && (
          <>
            <Divider />
            <Box sx={{ px: 3, py: 1.5, bgcolor: 'primary.lighterOpacity' }}>
              <Typography variant='caption' color='primary.main' fontWeight={700} letterSpacing={0.8}>
                在线渠道
              </Typography>
            </Box>
            <Divider />
            {status.providers
              .filter(provider => provider.keySource === 'newapi')
              .map(provider => (
                <Box key={provider.id}>
                  <ChannelRow
                    provider={provider}
                    busy={busy}
                    testing={testingChannelId === provider.id}
                    selectingKey={selectingKeyId === provider.id}
                    refreshing={refreshingChannelId === provider.id}
                    activating={
                      activationProgress?.channelId === provider.id && activationProgress.status === 'running'
                    }
                    pendingApply={Boolean(pendingApply[provider.id])}
                    selectedKeyId={selectedKeys[provider.id] || ''}
                    selectedModel={selectedModels[provider.id] || provider.model}
                    onSelectedModelChange={selectModel}
                    onKeyChange={selectOnlineKey}
                    onRefresh={refreshOnlineChannel}
                    onTest={testChannel}
                    onApply={applyRelay}
                    onEdit={openAddDialog}
                    onRemove={removeRelay}
                  />
                </Box>
              ))}
          </>
        )}
      </Box>
    </Stack>
  )

  const renderConversations = () => (
    <Stack spacing={5}>
      <SectionHeader
        title='对话管理'
        count={(status?.sessions.length || 0) + (status?.projects.length || 0)}
        onHelp={() => setHelpOpen('conversations')}
        action={
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button
              variant='outlined'
              color='secondary'
              disabled={busy}
              startIcon={<i className='ri-database-2-line' />}
              onClick={repairConversationIndex}
            >
              修复客户端索引
            </Button>
            <Button
              variant='outlined'
              disabled={busy || (!status?.sessions.length && !status?.projects.some(project => project.exists))}
              startIcon={<i className='ri-download-2-line' />}
              onClick={() => setConversationTransferMode('export')}
            >
              导出
            </Button>
            <Button
              variant='outlined'
              color='error'
              disabled={busy || (!filteredSessions.length && !filteredProjects.length)}
              startIcon={<i className='ri-delete-bin-2-line' />}
              onClick={deleteFilteredConversationData}
            >
              一键删除
            </Button>
            <Button
              variant='contained'
              disabled={busy}
              startIcon={<i className='ri-file-upload-line' />}
              onClick={() => setConversationTransferMode('import')}
            >
              导入
            </Button>
          </Stack>
        }
      />
      <Divider />
      <Box sx={{ ...listSurfaceSx, p: 3 }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems={{ xs: 'stretch', lg: 'center' }}>
          <ToggleButtonGroup
            exclusive
            size='small'
            value={conversationScope}
            onChange={(_event, value: ConversationScope | null) => value && setConversationScope(value)}
            aria-label='对话归档状态'
            sx={{ flexShrink: 0 }}
          >
            <ToggleButton value='active' sx={{ minInlineSize: 132 }}>
              未归档 {sessionCounts.active}
            </ToggleButton>
            <ToggleButton value='archived' sx={{ minInlineSize: 132 }}>
              已归档 {sessionCounts.archived}
            </ToggleButton>
          </ToggleButtonGroup>
          <TextField
            select
            size='small'
            label='项目'
            value={conversationProject}
            onChange={event => setConversationProject(event.target.value)}
            sx={{ minInlineSize: { lg: 230 } }}
          >
            <MenuItem value=''>全部项目</MenuItem>
            {(status?.projects || []).map(project => (
              <MenuItem key={project.path} value={project.path}>
                {project.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            fullWidth
            size='small'
            label='搜索对话或项目'
            value={conversationQuery}
            onChange={event => setConversationQuery(event.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position='start'>
                  <i className='ri-search-line' />
                </InputAdornment>
              )
            }}
          />
          {(conversationProject || conversationQuery) && (
            <Button
              variant='text'
              color='secondary'
              startIcon={<i className='ri-filter-off-line' />}
              onClick={() => {
                setConversationProject('')
                setConversationQuery('')
              }}
              sx={{ flexShrink: 0 }}
            >
              清除筛选
            </Button>
          )}
        </Stack>
      </Box>
      <Box sx={listSurfaceSx}>
        <Box
          sx={{
            px: 3,
            py: 2,
            bgcolor: 'action.hover',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2
          }}
        >
          <Typography variant='subtitle1'>{conversationScope === 'archived' ? '已归档对话' : '未归档对话'}</Typography>
          <Typography variant='caption' color='text.secondary'>
            显示 {filteredSessions.length} 个
          </Typography>
        </Box>
        <Divider />
        {!filteredSessions.length ? (
          <EmptyState
            icon={conversationScope === 'archived' ? 'ri-archive-line' : 'ri-chat-history-line'}
            text={
              conversationQuery || conversationProject
                ? '当前筛选条件下没有对话'
                : conversationScope === 'archived'
                  ? '没有已归档对话'
                  : '没有未归档对话'
            }
          />
        ) : (
          filteredSessions.map((session, index) => (
            <Box key={`${session.path}-${session.updatedAt}`}>
              <SessionRow session={session} busy={busy} onOpen={openPath} onDelete={deleteSession} />
              {index < filteredSessions.length - 1 && <Divider />}
            </Box>
          ))
        )}
      </Box>
      <Box sx={listSurfaceSx}>
        <Box
          sx={{
            px: 3,
            py: 2,
            bgcolor: 'action.hover',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2
          }}
        >
          <Typography variant='subtitle1'>项目文件</Typography>
          <Typography variant='caption' color='text.secondary'>
            显示 {filteredProjects.length} 个
          </Typography>
        </Box>
        <Divider />
        {!filteredProjects.length ? (
          <EmptyState
            icon='ri-folder-settings-line'
            text={conversationQuery || conversationProject ? '当前筛选条件下没有项目' : '没有发现项目'}
          />
        ) : (
          filteredProjects.map((project, index) => (
            <Box key={project.path}>
              <ProjectRow project={project} busy={busy} onOpen={openPath} onDelete={deleteProject} />
              {index < filteredProjects.length - 1 && <Divider />}
            </Box>
          ))
        )}
      </Box>
    </Stack>
  )

  const renderPackages = (kind: 'skills' | 'agents') => {
    const items = kind === 'skills' ? status?.skills || [] : status?.agents || []
    const label = kind === 'skills' ? 'Skill' : 'Agent'

    return (
      <Stack spacing={4}>
        <SectionHeader
          title={`${label} 管理`}
          count={items.length}
          onHelp={() => setHelpOpen(kind)}
          action={
            <Stack direction='row' spacing={2}>
              <Button
                variant='outlined'
                disabled={busy}
                startIcon={<i className='ri-github-line' />}
                onClick={() => setGithubOpen(kind)}
              >
                GitHub zip
              </Button>
              <Button
                variant='contained'
                disabled={busy}
                startIcon={<i className='ri-file-zip-line' />}
                onClick={() => importZip(kind)}
              >
                {kind === 'skills' ? '导入 zip' : '导入 TOML / zip'}
              </Button>
            </Stack>
          }
        />
        <Divider />
        <Box sx={listSurfaceSx}>
          {!items.length ? (
            <EmptyState icon={kind === 'skills' ? 'ri-tools-line' : 'ri-robot-2-line'} text={`没有发现 ${label}`} />
          ) : (
            items.map((item, index) => (
              <Box key={item.path}>
                <PackageRow
                  item={item}
                  busy={busy}
                  onOpen={openPath}
                  onExport={identifier => exportPackage(kind, identifier)}
                />
                {index < items.length - 1 && <Divider />}
              </Box>
            ))
          )}
        </Box>
      </Stack>
    )
  }

  const helpText: Record<Section, string> = {
    channels:
      '本地渠道和在线渠道分区显示。在线渠道启用后仍可更换 Key；模型以该 Key 的 /v1/models 实际结果为准。“检测全部”会逐个验证当前 Key 的已适配模型；通过普通聊天、流式响应、工具调用和工具结果续答的模型会一起进入 Codex 内部切换列表。当前已适配 GPT 与 Grok；未知接口会显示“适配未完成，暂不可用”。Codex 内部下拉框使用原生模型槽位别名映射到实际模型，并按模型分别适配推理强度、推理摘要和速度服务等级。',
    conversations:
      '未归档包含正在使用和导入的对话，已归档来自 archived_sessions。统一导入支持对话 JSONL 或项目文件夹；统一导出支持会话 JSONL 或完整项目 ZIP。可以按项目或关键词筛选；永久删除会直接删除电脑上的对话 JSONL 文件且无法恢复。项目删除只移除配置记录，不会删除整个项目文件夹。',
    skills:
      '用户 Skill 安装到当前 Codex 使用的 ~/.agents/skills，并兼容显示旧 ~/.codex/skills；导入时校验 SKILL.md 的 name 和 description。',
    agents:
      '自定义 Agent 使用 ~/.codex/agents/*.toml。可导入单个 TOML 或包含 TOML 的 zip；每个配置必须包含 name、description 和 developer_instructions。AGENTS.md 是指令文件，不是自定义 Agent。'
  }

  return (
    <Stack spacing={4}>
      {busy && !testingChannelId && !activationRunning && <LinearProgress />}

      {activationProgress && (
        <Card
          variant='outlined'
          role='status'
          aria-live='polite'
          sx={{
            borderColor:
              activationProgress.status === 'error'
                ? 'error.main'
                : activationProgress.status === 'warning'
                  ? 'warning.main'
                  : activationProgress.status === 'success'
                    ? 'success.main'
                    : 'primary.main'
          }}
        >
          <CardContent sx={{ '&:last-child': { pb: 3 } }}>
            <Stack spacing={2}>
              <Stack direction='row' spacing={2} alignItems='center'>
                {activationProgress.status === 'running' ? (
                  <CircularProgress size={24} />
                ) : (
                  <i
                    className={
                      activationProgress.status === 'success'
                        ? 'ri-checkbox-circle-line'
                        : activationProgress.status === 'warning'
                          ? 'ri-error-warning-line'
                          : 'ri-close-circle-line'
                    }
                    style={{ fontSize: 26 }}
                  />
                )}
                <Box sx={{ flex: 1, minInlineSize: 0 }}>
                  <Typography variant='subtitle1' fontWeight={700}>
                    {activationProgress.status === 'running'
                      ? '正在配置并启动 Codex'
                      : activationProgress.status === 'success'
                        ? 'Codex 启动完成'
                        : activationProgress.status === 'warning'
                          ? '配置完成，需要手动启动'
                          : 'Codex 启动未完成'}
                  </Typography>
                  <Typography variant='body2' color='text.secondary'>
                    {activationProgress.message}
                  </Typography>
                </Box>
                <Chip
                  size='small'
                  color={
                    activationProgress.status === 'error'
                      ? 'error'
                      : activationProgress.status === 'warning'
                        ? 'warning'
                        : activationProgress.status === 'success'
                          ? 'success'
                          : 'primary'
                  }
                  label={`${Math.round(activationProgress.progress)}%`}
                />
              </Stack>
              <LinearProgress
                variant='determinate'
                value={activationProgress.progress}
                color={
                  activationProgress.status === 'error'
                    ? 'error'
                    : activationProgress.status === 'warning'
                      ? 'warning'
                      : activationProgress.status === 'success'
                        ? 'success'
                        : 'primary'
                }
              />
              <Typography variant='caption' color='text.secondary'>
                已用时 {Math.max(1, Math.ceil(activationElapsedMs / 1000))} 秒
                {activationProgress.status === 'running' ? ' · 请勿重复点击或关闭本程序' : ''}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      )}

      {!bridgeReady && (
        <Alert severity='warning' variant='outlined'>
          桌面桥接未连接，请用桌面程序打开。
        </Alert>
      )}

      {issues.map(issue => (
        <Alert key={issue} severity='warning' variant='outlined'>
          {issue}
        </Alert>
      ))}

      {runtimeDiagnostic && (
        <Alert
          severity={runtimeDiagnostic.severity === 'error' ? 'error' : 'warning'}
          variant='outlined'
          onClose={() => setRuntimeDiagnostic(undefined)}
          action={
            <Button color='inherit' size='small' onClick={openRuntimeLog}>
              查看日志
            </Button>
          }
        >
          <Stack spacing={0.5}>
            <Typography variant='body2' fontWeight={600}>
              {runtimeDiagnostic.message}
            </Typography>
            <Typography variant='caption' color='text.secondary'>
              {[
                runtimeDiagnostic.model && `模型 ${runtimeDiagnostic.model}`,
                runtimeDiagnostic.codexThreadId && `任务 ${runtimeDiagnostic.codexThreadId}`,
                runtimeDiagnostic.capturedAt && new Date(runtimeDiagnostic.capturedAt).toLocaleString()
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
          </Stack>
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '260px 1fr' }, gap: 4, alignItems: 'start' }}>
        <Card>
          <CardContent>
            <Stack spacing={4}>
              <Box>
                <Typography variant='h5'>ChatGPT 管理器</Typography>
                <Typography variant='body2' color='text.secondary'>
                  {activeLabel}
                </Typography>
              </Box>
              <Divider />
              <Stack spacing={1}>
                {menuItems.map(item => (
                  <Box
                    key={item.id}
                    role='button'
                    tabIndex={0}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      minBlockSize: 40,
                      px: 2.5,
                      borderRadius: 1.5,
                      cursor: 'pointer',
                      color: section === item.id ? 'primary.main' : 'text.secondary',
                      bgcolor: section === item.id ? 'action.selected' : 'transparent',
                      border: 1,
                      borderColor: section === item.id ? 'primary.main' : 'transparent',
                      '&:hover': {
                        bgcolor: section === item.id ? 'action.selected' : 'action.hover',
                        color: section === item.id ? 'primary.main' : 'text.primary'
                      }
                    }}
                    onClick={() => setSection(item.id)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') setSection(item.id)
                    }}
                  >
                    <i className={`${item.icon} text-[19px]`} />
                    <Typography variant='body2' fontWeight={section === item.id ? 600 : 500}>
                      {item.label}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              <Divider />
              <Stack direction='row' spacing={1} flexWrap='wrap'>
                <Chip
                  color={status?.diagnostics.codexInstalled ? 'success' : 'warning'}
                  size='small'
                  variant='tonal'
                  label={status?.diagnostics.codexInstalled ? 'Codex 客户端已安装' : '未发现 Codex 客户端'}
                />
                <Chip
                  color={status?.initialBackup.exists ? 'success' : 'warning'}
                  size='small'
                  variant='tonal'
                  label={status?.initialBackup.exists ? '已备份' : '未备份'}
                />
              </Stack>
              <Button
                variant='outlined'
                color='secondary'
                disabled={busy}
                startIcon={<i className='ri-refresh-line' />}
                onClick={() => refresh(true)}
              >
                重新扫描
              </Button>
              <Button
                variant='outlined'
                color='secondary'
                disabled={busy}
                startIcon={<i className='ri-file-list-3-line' />}
                onClick={openRuntimeLog}
              >
                打开运行日志
              </Button>
              <Button
                variant='outlined'
                color='primary'
                disabled={busy || toolRuntimeBusy}
                startIcon={
                  toolRuntimeBusy ? (
                    <CircularProgress size={14} color='inherit' />
                  ) : (
                    <i className='ri-terminal-box-line' />
                  )
                }
                onClick={inspectToolRuntime}
              >
                本地工具环境
              </Button>
              <Button
                variant='outlined'
                color='warning'
                disabled={busy || diskMaintenanceBusy}
                startIcon={
                  diskMaintenanceBusy ? (
                    <CircularProgress size={14} color='inherit' />
                  ) : (
                    <i className='ri-hard-drive-3-line' />
                  )
                }
                onClick={inspectDiskUsage}
              >
                一键磁盘维护
              </Button>
              <Button
                variant='outlined'
                color='secondary'
                disabled={busy || !status?.initialBackup.exists}
                startIcon={<i className='ri-history-line' />}
                onClick={restoreInitialBackup}
              >
                恢复初始 Codex 状态
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {section === 'channels' && renderChannels()}
            {section === 'conversations' && renderConversations()}
            {section === 'skills' && renderPackages('skills')}
            {section === 'agents' && renderPackages('agents')}
          </CardContent>
        </Card>
      </Box>

      <Dialog
        open={addOpen}
        onClose={() => !busy && setAddOpen(false)}
        fullWidth
        maxWidth={addMode === 'newapi' && !form.id ? 'md' : 'sm'}
      >
        <DialogTitle>{form.id ? '编辑渠道' : '添加渠道'}</DialogTitle>
        <DialogContent>
          <Stack spacing={5} sx={{ pt: 2 }}>
            {!form.id && (
              <Stack spacing={1.5}>
                <Typography variant='caption' color='text.secondary' fontWeight={600}>
                  添加方式
                </Typography>
                <Stack
                  direction='row'
                  spacing={1}
                  sx={{ p: 0.5, border: 1, borderColor: 'divider', borderRadius: 1, inlineSize: 'fit-content' }}
                >
                  <Button
                    size='small'
                    variant={addMode === 'manual' ? 'contained' : 'text'}
                    disabled={busy}
                    startIcon={<i className='ri-key-2-line' />}
                    onClick={() => changeAddMode('manual')}
                  >
                    手工添加
                  </Button>
                  <Button
                    size='small'
                    variant={addMode === 'newapi' ? 'contained' : 'text'}
                    disabled={busy}
                    startIcon={<i className='ri-login-circle-line' />}
                    onClick={() => changeAddMode('newapi')}
                  >
                    从 NewAPI 添加
                  </Button>
                </Stack>
              </Stack>
            )}

            {form.id || addMode === 'manual' ? (
              <>
                <TextField
                  label='名称'
                  placeholder='我的中转站'
                  value={form.name}
                  disabled={busy}
                  autoFocus={addMode === 'manual'}
                  onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
                />
                <TextField
                  label='URL'
                  placeholder='http://1.1.1.1/v1'
                  value={form.baseUrl}
                  disabled={busy}
                  onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))}
                />
                <TextField
                  label='API Key'
                  placeholder={editingProvider?.apiKeyMask ? `已保存：${editingProvider.apiKeyMask}` : 'sk-xxxx'}
                  helperText={
                    form.id && editingProvider?.apiKeyMask
                      ? '密钥已安全保存；留空不会修改，输入新 Key 才会替换。'
                      : undefined
                  }
                  type={apiKeyVisible ? 'text' : 'password'}
                  value={displayedApiKey}
                  disabled={busy}
                  onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position='end'>
                        <Tooltip title={apiKeyVisible ? '隐藏 API Key' : '查看 API Key'}>
                          <IconButton edge='end' onClick={toggleApiKeyVisibility}>
                            <i className={apiKeyVisible ? 'ri-eye-off-line' : 'ri-eye-line'} />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    )
                  }}
                />
                <Autocomplete
                  multiple
                  freeSolo
                  filterSelectedOptions
                  options={manualModelSuggestions}
                  value={form.models}
                  disabled={busy}
                  onChange={(_event, value) => {
                    const models = uniqueModels(value)

                    setForm(current => ({
                      ...current,
                      models,
                      model: models.includes(current.model) ? current.model : models[0] || ''
                    }))
                  }}
                  renderInput={params => <TextField {...params} label='模型' placeholder='选择或输入模型，回车添加' />}
                />
                <TextField label='接口模式' value={wireApiLabel()} disabled />
              </>
            ) : (
              <>
                <Alert severity='info' variant='outlined'>
                  登录后会自动发现可用 Key，并直接加入“在线渠道”；无需另行保存。
                  {status?.newApi?.hasRememberedPassword ? ' 已记住上次登录密码，可留空密码直接同步。' : ''}
                </Alert>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
                  <TextField
                    label='NewAPI 地址'
                    value={newApiForm.baseUrl}
                    disabled={busy}
                    fullWidth
                    onChange={event => setNewApiForm(current => ({ ...current, baseUrl: event.target.value }))}
                  />
                  <TextField
                    label='API 接口'
                    value={newApiForm.relayBaseUrl}
                    disabled={busy}
                    fullWidth
                    onChange={event => setNewApiForm(current => ({ ...current, relayBaseUrl: event.target.value }))}
                  />
                </Stack>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
                  <TextField
                    label='用户名'
                    value={newApiForm.username}
                    disabled={busy}
                    fullWidth
                    onChange={event => setNewApiForm(current => ({ ...current, username: event.target.value }))}
                  />
                  <TextField
                    label='密码'
                    type='password'
                    value={newApiForm.password}
                    disabled={busy}
                    fullWidth
                    placeholder={status?.newApi?.hasRememberedPassword ? '已记住，可留空' : ''}
                    onChange={event => setNewApiForm(current => ({ ...current, password: event.target.value }))}
                  />
                </Stack>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={newApiForm.rememberPassword}
                      disabled={busy}
                      onChange={event =>
                        setNewApiForm(current => ({ ...current, rememberPassword: event.target.checked }))
                      }
                    />
                  }
                  label='记住登录'
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5 }}>
          <Button variant='outlined' color='secondary' disabled={busy} onClick={() => setAddOpen(false)}>
            取消
          </Button>
          {form.id || addMode === 'manual' ? (
            <Button
              variant='contained'
              disabled={busy}
              startIcon={<i className='ri-save-3-line' />}
              onClick={saveRelay}
            >
              保存渠道
            </Button>
          ) : (
            <Button
              variant='contained'
              disabled={busy}
              startIcon={busy ? <CircularProgress size={14} /> : <i className='ri-login-circle-line' />}
              onClick={syncNewApi}
            >
              登录并同步
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog
        open={toolRuntimeOpen}
        onClose={() => !toolRuntimeBusy && setToolRuntimeOpen(false)}
        fullWidth
        maxWidth='sm'
      >
        <DialogTitle>Codex Windows 本地工具环境</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {toolRuntimeBusy && <LinearProgress />}
            <Alert severity={toolRuntime?.healthy ? 'success' : toolRuntime ? 'warning' : 'info'} variant='outlined'>
              {toolRuntime?.message || '正在检查 Codex Windows Sandbox、PowerShell 和本地命令运行入口…'}
            </Alert>
            <Stack direction='row' spacing={1} flexWrap='wrap' useFlexGap>
              <Chip
                size='small'
                color={toolRuntime?.readiness === 'ready' ? 'success' : 'warning'}
                variant='tonal'
                label={`Sandbox：${toolRuntime?.readiness || '检测中'}`}
              />
              <Chip
                size='small'
                color={toolRuntime?.powershellOk ? 'success' : 'warning'}
                variant='tonal'
                label={`PowerShell：${toolRuntime?.powershellOk ? '正常' : '未通过'}`}
              />
              <Chip
                size='small'
                color={toolRuntime?.shellTestOk ? 'success' : 'warning'}
                variant='tonal'
                label={`本地命令：${toolRuntime?.shellTestOk ? '正常' : '未通过'}`}
              />
              <Chip
                size='small'
                color={
                  toolRuntime?.localDoctorStatus === 'error'
                    ? 'error'
                    : toolRuntime?.localDoctorStatus === 'ok'
                      ? 'success'
                      : toolRuntime
                        ? 'warning'
                        : 'default'
                }
                variant='tonal'
                label={`本地 Doctor：${toolRuntime?.localDoctorStatus || '检测中'}`}
              />
              {toolRuntime?.doctorProviderIssues?.length ? (
                <Chip
                  size='small'
                  color={toolRuntime.providerDoctorStatus === 'error' ? 'error' : 'warning'}
                  variant='tonal'
                  label={`Provider：${toolRuntime.providerDoctorStatus === 'error' ? '不可达' : '警告'}`}
                />
              ) : null}
            </Stack>
            {toolRuntime?.codexVersion && (
              <Typography variant='body2' color='text.secondary'>
                {toolRuntime.codexVersion}
              </Typography>
            )}
            {toolRuntime?.codexPath && (
              <PathDisclosure path={toolRuntime.codexPath} label='程序位置' summary='Codex 客户端' />
            )}
            {toolRuntime?.shellTestMessage && (
              <Alert severity='error' variant='outlined'>
                {cleanErrorMessage(toolRuntime.shellTestMessage)}
              </Alert>
            )}
            {toolRuntime?.doctorLocalErrors?.map(item => (
              <Alert key={item.id} severity='error' variant='outlined'>
                <strong>本地环境：</strong>
                {cleanErrorMessage(item.summary)}
                {item.remediation ? ` 修复建议：${cleanErrorMessage(item.remediation)}` : ''}
              </Alert>
            ))}
            {toolRuntime?.doctorLocalWarnings?.map(item => (
              <Alert key={item.id} severity='warning' variant='outlined'>
                <strong>本地环境：</strong>
                {cleanErrorMessage(item.summary)}
                {item.remediation ? ` 建议：${cleanErrorMessage(item.remediation)}` : ''}
              </Alert>
            ))}
            {toolRuntime?.doctorProviderIssues?.map(item => (
              <Alert key={item.id} severity='warning' variant='outlined'>
                <strong>渠道检测：</strong>
                {cleanErrorMessage(item.summary)}
                {' 该项只表示当前 Provider 网络或鉴权异常，不代表本地 Shell/Sandbox 损坏。'}
              </Alert>
            ))}
            <Typography variant='caption' color='text.secondary'>
              管理员模式是官方推荐的 Windows Sandbox 初始化方式，可能弹出
              UAC。兼容模式仅在管理员初始化失败或没有管理员权限时使用。本功能不修改 Provider、API
              Key、模型提示或对话数据。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5, flexWrap: 'wrap' }}>
          <Button variant='text' disabled={toolRuntimeBusy} onClick={inspectToolRuntime}>
            重新检测
          </Button>
          <Button
            variant='contained'
            color='error'
            disabled={toolRuntimeBusy}
            startIcon={
              toolRuntimeBusy ? <CircularProgress size={14} color='inherit' /> : <i className='ri-tools-line' />
            }
            onClick={repairToolRuntime}
          >
            修复环境
          </Button>
          <Button
            variant='outlined'
            disabled={toolRuntimeBusy || toolRuntime?.healthy}
            onClick={() => initializeToolRuntime('unelevated')}
          >
            兼容初始化
          </Button>
          <Button
            variant='contained'
            disabled={toolRuntimeBusy || toolRuntime?.healthy}
            startIcon={
              toolRuntimeBusy ? <CircularProgress size={14} color='inherit' /> : <i className='ri-shield-check-line' />
            }
            onClick={() => initializeToolRuntime('elevated')}
          >
            管理员初始化
          </Button>
          <Button color='secondary' disabled={toolRuntimeBusy} onClick={() => setToolRuntimeOpen(false)}>
            关闭
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={diskMaintenanceOpen}
        onClose={() => !diskMaintenanceBusy && setDiskMaintenanceOpen(false)}
        fullWidth
        maxWidth='sm'
      >
        <DialogTitle>Codex 一键磁盘维护</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {diskMaintenanceBusy && <LinearProgress />}
            <Alert
              severity={diskUsage?.reclaimableBytes ? 'warning' : diskUsage ? 'success' : 'info'}
              variant='outlined'
            >
              {diskUsage
                ? diskUsage.reclaimableBytes
                  ? `发现 ${formatBytes(diskUsage.reclaimableBytes)} 可安全回收空间。`
                  : '当前没有需要清理的 Codex 日志或临时缓存。'
                : '正在统计 Codex 日志、临时缓存和会话占用…'}
            </Alert>
            {diskUsage && (
              <>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                    gap: 2
                  }}
                >
                  {[
                    { label: 'Codex 总占用', value: diskUsage.totalCodexBytes, color: 'text.primary' },
                    { label: '可安全回收', value: diskUsage.reclaimableBytes, color: 'warning.main' },
                    {
                      label: '保留的对话',
                      value: diskUsage.sessionBytes + diskUsage.archivedSessionBytes,
                      color: 'success.main'
                    }
                  ].map(item => (
                    <Box key={item.label} sx={{ p: 2.5, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                      <Typography variant='caption' color='text.secondary'>
                        {item.label}
                      </Typography>
                      <Typography variant='h6' color={item.color} sx={{ mt: 0.5 }}>
                        {formatBytes(item.value)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                <Stack spacing={1.5}>
                  {diskUsage.categories.map(category => (
                    <Stack
                      key={category.id}
                      direction='row'
                      justifyContent='space-between'
                      alignItems='center'
                      spacing={2}
                      sx={{ px: 2.5, py: 1.75, borderRadius: 1.5, bgcolor: 'action.hover' }}
                    >
                      <Box sx={{ minInlineSize: 0 }}>
                        <Typography variant='body2' fontWeight={600}>
                          {category.label}
                        </Typography>
                        <Typography variant='caption' color='text.secondary'>
                          {category.files} 个文件
                        </Typography>
                      </Box>
                      <Typography
                        variant='body2'
                        fontWeight={700}
                        color={category.bytes ? 'warning.main' : 'text.secondary'}
                      >
                        {formatBytes(category.bytes)}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
                <Alert severity='info' variant='outlined'>
                  维护会短暂关闭并重新启动 Codex。不会删除 sessions、archived_sessions、项目、登录、渠道配置、Skills 或
                  Agents。
                </Alert>
                <PathDisclosure path={diskUsage.codexHome} label='数据位置' summary='Codex 数据文件夹' />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5, flexWrap: 'wrap' }}>
          <Button variant='text' disabled={diskMaintenanceBusy} onClick={inspectDiskUsage}>
            重新扫描
          </Button>
          <Button
            variant='contained'
            color='warning'
            disabled={diskMaintenanceBusy || !diskUsage?.reclaimableBytes}
            startIcon={
              diskMaintenanceBusy ? (
                <CircularProgress size={14} color='inherit' />
              ) : (
                <i className='ri-delete-bin-6-line' />
              )
            }
            onClick={confirmDiskMaintenance}
          >
            开始维护
          </Button>
          <Button color='secondary' disabled={diskMaintenanceBusy} onClick={() => setDiskMaintenanceOpen(false)}>
            关闭
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(confirmDialog)}
        onClose={() => !busy && setConfirmDialog(undefined)}
        fullWidth
        maxWidth='xs'
      >
        <DialogTitle>{confirmDialog?.title}</DialogTitle>
        <DialogContent>
          <Typography color='text.secondary' sx={{ whiteSpace: 'pre-line' }}>
            {confirmDialog?.body}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5 }}>
          <Button variant='outlined' color='secondary' disabled={busy} onClick={() => setConfirmDialog(undefined)}>
            取消
          </Button>
          <Button
            variant='contained'
            color='error'
            disabled={busy}
            onClick={() => {
              const action = confirmDialog?.action

              setConfirmDialog(undefined)
              if (action) run(action)
            }}
          >
            {confirmDialog?.confirmText || '确定'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(helpOpen)} onClose={() => setHelpOpen(undefined)} fullWidth maxWidth='xs'>
        <DialogTitle>说明</DialogTitle>
        <DialogContent>
          <Typography color='text.secondary'>{helpOpen ? helpText[helpOpen] : ''}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5 }}>
          <Button variant='contained' onClick={() => setHelpOpen(undefined)}>
            知道了
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(githubOpen)} onClose={() => !busy && setGithubOpen(undefined)} fullWidth maxWidth='sm'>
        <DialogTitle>从 GitHub zip 导入</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            sx={{ mt: 2 }}
            label='GitHub zip 地址'
            placeholder='https://github.com/user/repo/archive/refs/heads/main.zip'
            value={githubUrl}
            disabled={busy}
            onChange={event => setGithubUrl(event.target.value)}
          />
        </DialogContent>
        <DialogActions sx={{ px: 6, pb: 5 }}>
          <Button variant='outlined' color='secondary' disabled={busy} onClick={() => setGithubOpen(undefined)}>
            取消
          </Button>
          <Button
            variant='contained'
            disabled={busy}
            startIcon={<i className='ri-download-cloud-line' />}
            onClick={importFromGithub}
          >
            导入
          </Button>
        </DialogActions>
      </Dialog>

      <ConversationTransferDialog
        mode={conversationTransferMode}
        busy={busy}
        sessions={status?.sessions || []}
        projects={status?.projects || []}
        onClose={() => setConversationTransferMode(undefined)}
        onImport={importConversationData}
        onExport={exportConversationData}
      />

      <Snackbar
        open={Boolean(message)}
        autoHideDuration={6500}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        onClose={() => setMessage(undefined)}
      >
        <Alert
          severity={message?.type || 'info'}
          variant='filled'
          onClose={() => setMessage(undefined)}
          sx={{ maxInlineSize: 560, alignItems: 'center', boxShadow: 6, fontSize: '0.9375rem', lineHeight: 1.65 }}
        >
          {message?.text}
        </Alert>
      </Snackbar>
    </Stack>
  )
}

export default ModelManager
