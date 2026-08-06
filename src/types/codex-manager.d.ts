export type RelayProvider = {
  id: string
  name: string
  baseUrl: string
  model: string
  models: string[]
  wireApi: 'responses' | 'chat'
  envKey: string
  updatedAt: string
  active: boolean
  apiKeyMask: string
  source: 'managed' | 'codex-config' | 'managed+codex-config'
  managed: boolean
  keySource?: 'manual' | 'newapi'
  newApi?: NewApiChannelMeta | null
  modelTests?: Record<string, RelayModelTest>
  modelCapabilities?: Record<string, ModelCapability>
  supportedModelCount?: number
  testStatus?: RelayTest | null
}

export type ModelCapability = {
  status: 'supported' | 'unsupported'
  available: boolean
  adapter: string
  wireApi: 'responses' | 'chat' | ''
  reasoningEfforts: string[]
  defaultReasoningEffort: string
  supportsReasoningSummaries: boolean
  supportsVerbosity: boolean
  speedModes: string[]
  serviceTiers: Array<{ id: string; name: string; description: string }>
  toolTransport: 'native' | 'prompt-emulated' | ''
  agentRuntime: 'codex-native'
  upstreamModel: string
  reason: string
}

export type RelayTest = {
  ok: boolean
  chatOk?: boolean
  wireApi?: 'responses' | 'chat' | ''
  streamOk?: boolean
  agentToolOk?: boolean
  toolTransport?: 'native' | 'prompt-emulated' | ''
  adapter?: string
  interfaceStatus?: 'supported' | 'unsupported' | 'failed'
  reasoningEfforts?: string[]
  speedModes?: string[]
  status: number
  latencyMs: number
  chatLatencyMs?: number
  streamLatencyMs?: number
  agentToolLatencyMs?: number
  actualModel?: string
  agentToolMessage?: string
  message: string
}

export type RelayModelTest = RelayTest & {
  model: string
  testedAt?: string
}

export type ConversationIndexRepair = {
  ok: boolean
  repaired: boolean
  diskSessionCount: number
  indexedBeforeCount: number
  indexedAfterCount: number
  allIndexedAfterCount?: number
  missingBeforeCount: number
  missingSessionCount: number
  missingSessionIds: string[]
  normalizedSessionCount?: number
  normalizedSessions?: Array<{ id: string; backupPath: string }>
  reindexedSessionCount?: number
  reindexedSessionIds?: string[]
  reindexErrors?: Array<{ id: string; error: string; recoveryPath: string }>
  allIndexedThreadSummaries?: Array<{
    id: string
    source: string
    threadSource: string
    historyMode: string
    modelProvider: string
    ephemeral: boolean
    archived: boolean
    cwd: string
  }>
  addedProjectCount?: number
  addedProjects?: string[]
  status: CodexStatus
  restart?: CodexRestart
}

export type ConversationDeleteFilters = {
  scope?: 'active' | 'archived'
  query?: string
  projectPath?: string
}

export type ConversationDeleteResult = {
  status: CodexStatus
  deletedSessionCount: number
  skippedSessionCount: number
  deletedProjectCount: number
  skippedProjectCount: number
  deletedSessions: string[]
  skippedSessions: Array<{ path: string; error: string }>
  deletedProjects: string[]
  skippedProjects: Array<{ path: string; error: string }>
  stoppedProcessCount: number
  configurationError: string
  indexDelete: {
    ok: boolean
    skipped: boolean
    reason?: string
    deletedCount?: number
    errors?: Array<{ threadId: string; error: string }>
  }
  indexRefresh: { ok: boolean; skipped: boolean; reason?: string; error?: string }
}

export type InitialBackup = {
  exists: boolean
  path: string
  configExists?: boolean
  authCaptured?: boolean
  authExists?: boolean
  authPath?: string
  modelsCacheCaptured?: boolean
  modelsCacheExists?: boolean
  modelsCachePath?: string
  createdAt: string
}

export type CodexDiagnostics = {
  codexInstalled: boolean
  codexDetection: 'launch-target' | 'local-runtime' | 'appx-package-data' | 'not-found'
  codexDetectedPath: string
  codexHomeExists: boolean
  configExists: boolean
  configReadable: boolean
  issues: string[]
}

export type CodexSession = {
  id: string
  title: string
  path: string
  cwd: string
  location: 'active' | 'archived' | 'imported'
  size: number
  updatedAt: string
}

export type CodexTaskRecoveryProgress = {
  sourceThreadId: string
  sourceThreadRef: string
  targetThreadId: string
  action: 'resume' | 'fork'
  stage: 'resuming' | 'running' | 'forking' | 'fork-resuming' | 'completed' | 'failed'
  status: 'running' | 'success' | 'error'
  message: string
  failureCategory?: 'authentication' | 'capacity' | 'permission' | 'network' | 'session' | 'unknown' | ''
  updatedAt: string
}

export type CodexTaskRecoveryResult = {
  ok: true
  status: 'running'
  action: 'resume'
  fallback: 'fork-on-session-failure'
  sourceThreadId: string
  sourceThreadRef: string
  cwd: string
  runtimeStatus: string
  lastTurnStatus: string
  inspectionCategory: string
  workspace: {
    cwdExists: boolean
    gitRepository: boolean
    dirtyEntryCount: number
    sessionBytes: number
    sessionUpdatedAt: string
  }
}

export type CodexProject = {
  path: string
  name: string
  trustLevel: string
  exists: boolean
}

export type ConversationTransferKind = 'session' | 'project'

export type ConversationImportResult = {
  kind: ConversationTransferKind
  status: CodexStatus
  target: string
}

export type ConversationExportResult = {
  kind: ConversationTransferKind
  target: string
  source: string
}

export type ToolPackage = {
  name: string
  displayName?: string
  description?: string
  path: string
  kind: 'directory' | 'file'
  size: number
  updatedAt: string
  source?: 'user' | 'legacy' | 'custom-agent' | 'legacy-agent-directory'
  valid?: boolean
  message?: string
}

export type CodexStatus = {
  codexHome: string
  configPath: string
  channelsPath: string
  currentProvider: string
  currentModel: string
  currentCodexModel?: string
  isDefaultProvider: boolean
  providers: RelayProvider[]
  codexTargets: string[]
  sessions: CodexSession[]
  projects: CodexProject[]
  skills: ToolPackage[]
  agents: ToolPackage[]
  newApi: NewApiState
  initialBackup: InitialBackup
  diagnostics: CodexDiagnostics
}

export type NewApiState = {
  baseUrl: string
  relayBaseUrl?: string
  username: string
  lastSyncedAt: string
  rememberPassword?: boolean
  hasRememberedPassword?: boolean
}

export type NewApiChannelMeta = {
  baseUrl: string
  tokenId?: string | number
  selectedTokenId?: string | number
  tokenName?: string
  tokenKeyMask?: string
  userHeader?: string
  keys?: NewApiKeyOption[]
}

export type NewApiKeyOption = {
  id?: string | number
  name: string
  keyMask: string
  status: number
  group: string
  remainQuota: number
  unlimitedQuota: boolean
  models: string[]
  envKey: string
}

export type NewApiSyncInput = {
  baseUrl?: string
  relayBaseUrl?: string
  username: string
  password?: string
  rememberPassword?: boolean
}

export type NewApiToken = {
  id?: string | number
  name: string
  apiKey: string
  keyMask: string
  status: number
  group: string
  remainQuota: number
  unlimitedQuota: boolean
  modelLimitsEnabled: boolean
  modelLimits: string[]
  models: string[]
}

export type NewApiSyncResult = NewApiState & {
  user?: unknown
  tokens: NewApiToken[]
  channelId?: string
  selectedTokenId?: string | number
  refreshedKeys?: boolean
  modelCount?: number
}

export type CodexRestart = {
  ok?: boolean
  dryRun?: boolean
  skipped?: boolean
  manual?: boolean
  target: string | null
  targets: string[]
  appId?: string | null
  error?: string
  message?: string
}

export type CodexActivationProgress = {
  operationId: string
  channelId: string
  model: string
  stage: string
  progress: number
  message: string
  status: 'running' | 'success' | 'warning' | 'error'
  updatedAt: string
}

export type CodexDiskCategory = {
  id: 'logs' | 'temp' | 'cache'
  label: string
  paths: string[]
  bytes: number
  files: number
  directories: number
}

export type CodexDiskUsage = {
  scannedAt: string
  codexHome: string
  totalCodexBytes: number
  reclaimableBytes: number
  sessionBytes: number
  archivedSessionBytes: number
  categories: CodexDiskCategory[]
}

export type CodexDiskMaintenanceResult = {
  ok: boolean
  before: CodexDiskUsage
  after: CodexDiskUsage
  stoppedProcessCount: number
  removed: Array<{ category: string; path: string; bytes: number }>
  removedBytes: number
  errors: Array<{ category: string; path: string; error: string }>
  restart: CodexRestart
}

export type LocalToolRuntimeStatus = {
  supported: boolean
  healthy: boolean
  readiness: 'ready' | 'notConfigured' | 'updateRequired' | 'unsupported' | string
  codexPath: string
  codexVersion: string
  doctorStatus: string
  doctorErrors: Array<{ id: string; status?: string; summary: string; remediation: string }>
  doctorWarnings: Array<{ id: string; status?: string; summary: string; remediation: string }>
  doctorLocalErrors: Array<{ id: string; status?: string; summary: string; remediation: string }>
  doctorLocalWarnings: Array<{ id: string; status?: string; summary: string; remediation: string }>
  doctorProviderIssues: Array<{ id: string; status: string; summary: string; remediation: string }>
  localDoctorStatus: string
  providerDoctorStatus: string
  powershellOk: boolean
  shellTestOk: boolean
  shellTestMessage?: string
  message: string
}

export type RelayInput = {
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  wireApi: 'responses' | 'chat'
  keySource?: 'manual' | 'newapi'
  newApi?: NewApiChannelMeta | null
}

export type AppUpdateStage =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export type AppUpdateState = {
  stage: AppUpdateStage
  currentVersion: string
  latestVersion: string
  message: string
  manual: boolean
  deliveryType: '' | 'patch' | 'installer'
  downloadPercent: number
  downloadedBytes: number
  totalBytes: number
  releaseUrl: string
  releaseNotes: string
}

export type RuntimeDiagnosticSummary = {
  capturedAt: string
  severity: 'warn' | 'error'
  kind: string
  message: string
  channelId: string
  model: string
  codexThreadId: string
  codexTurnId: string
  upstreamStatus: number
  upstreamRetryCount: number
}

declare global {
  interface Window {
    codexManager?: {
      getStatus: (forceCodexTargetScan?: boolean) => Promise<CodexStatus>
      getRuntimeDiagnosticSummary: () => Promise<RuntimeDiagnosticSummary | null>
      onRuntimeDiagnostic: (listener: (diagnostic: RuntimeDiagnosticSummary) => void) => () => void
      getUpdateState: () => Promise<AppUpdateState>
      checkForUpdates: (manual?: boolean) => Promise<AppUpdateState>
      installUpdate: () => Promise<{ ok: boolean; latestVersion: string }>
      onUpdateState: (listener: (state: AppUpdateState) => void) => () => void
      getRelayApiKey: (id: string) => Promise<{ apiKey: string; maskedApiKey: string }>
      saveRelay: (payload: RelayInput) => Promise<{ channel: RelayProvider; status: CodexStatus }>
      syncNewApi: (payload: NewApiSyncInput) => Promise<NewApiSyncResult>
      refreshNewApiChannel: (id: string) => Promise<NewApiSyncResult & { status: CodexStatus }>
      selectNewApiKey: (
        id: string,
        tokenId: string | number
      ) => Promise<{ channel: RelayProvider; models: string[]; status: CodexStatus }>
      inspectLocalToolRuntime: () => Promise<LocalToolRuntimeStatus>
      initializeLocalToolRuntime: (mode: 'elevated' | 'unelevated') => Promise<{
        initialized: boolean
        mode: string
        before: LocalToolRuntimeStatus
        after: LocalToolRuntimeStatus
      }>
      repairLocalToolRuntime: (mode: 'elevated' | 'unelevated') => Promise<{
        repaired: boolean
        initialized: boolean
        mode: string
        before: LocalToolRuntimeStatus
        after: LocalToolRuntimeStatus
        configRepair?: { repaired: boolean; files: string[]; backups: string[] }
        appRepair?: { ok: boolean; skipped?: boolean; repaired?: string[]; error?: string }
        restart?: CodexRestart
        warning?: string
      }>
      inspectDiskUsage: () => Promise<CodexDiskUsage>
      maintainDisk: () => Promise<CodexDiskMaintenanceResult>
      repairConversationIndex: () => Promise<ConversationIndexRepair>
      recoverTask: (taskId: string) => Promise<CodexTaskRecoveryResult>
      onTaskRecoveryProgress: (listener: (progress: CodexTaskRecoveryProgress) => void) => () => void
      openRuntimeLog: () => Promise<{ ok: boolean; path: string; error?: string }>
      testRelay: (payload: RelayInput) => Promise<{ test: RelayTest; channel?: RelayProvider; status: CodexStatus }>
      testSavedRelay: (
        id: string,
        model?: string
      ) => Promise<{ test: RelayTest; tests: RelayModelTest[]; status: CodexStatus }>
      applyRelay: (
        id: string,
        model?: string,
        operationId?: string
      ) => Promise<{
        status: CodexStatus
        restart: CodexRestart
        authLogin?: { skipped?: boolean; reason?: string; preservedChatGptTokens?: boolean } | null
        timings?: { applyMs?: number; modelCatalogMs?: number; restartMs?: number; statusMs?: number; totalMs?: number }
        conversationIndexRepairBefore?: ConversationIndexRepair | { ok: false; error: string } | null
        conversationIndexRepair?: ConversationIndexRepair | { ok: false; error: string } | null
      }>
      onApplyRelayProgress: (listener: (progress: CodexActivationProgress) => void) => () => void
      restoreDefault: () => Promise<{ status: CodexStatus; restart: CodexRestart }>
      restoreInitialBackup: () => Promise<{ status: CodexStatus; restart: CodexRestart }>
      removeRelay: (id: string) => Promise<CodexStatus>
      openPath: (targetPath: string) => Promise<{ ok: boolean; error?: string }>
      deleteSession: (idOrPath: string) => Promise<{ status: CodexStatus; deletedPath: string }>
      deleteConversationData: (filters: ConversationDeleteFilters) => Promise<ConversationDeleteResult>
      importConversationData: (kind: ConversationTransferKind) => Promise<ConversationImportResult | null>
      exportConversationData: (
        kind: ConversationTransferKind,
        sourcePath: string
      ) => Promise<ConversationExportResult | null>
      deleteProject: (projectPath: string) => Promise<CodexStatus>
      importSkillZip: () => Promise<CodexStatus | null>
      importAgentZip: () => Promise<CodexStatus | null>
      importSkillFromGithub: (url: string) => Promise<CodexStatus>
      importAgentFromGithub: (url: string) => Promise<CodexStatus>
      exportSkill: (identifier: string) => Promise<{ target: string } | null>
      exportAgent: (identifier: string) => Promise<{ target: string } | null>
    }
  }
}
