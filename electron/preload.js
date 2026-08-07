const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('codexManager', {
  getStatus: (forceCodexTargetScan = false) => ipcRenderer.invoke('codex:getStatus', forceCodexTargetScan),
  getRuntimeDiagnosticSummary: () => ipcRenderer.invoke('codex:getRuntimeDiagnosticSummary'),
  onRuntimeDiagnostic: listener => {
    const handler = (_event, diagnostic) => listener(diagnostic)

    ipcRenderer.on('codex:runtimeDiagnostic', handler)
    return () => ipcRenderer.removeListener('codex:runtimeDiagnostic', handler)
  },
  getUpdateState: () => ipcRenderer.invoke('codex:getUpdateState'),
  checkForUpdates: (manual = true) => ipcRenderer.invoke('codex:checkForUpdates', manual),
  installUpdate: () => ipcRenderer.invoke('codex:installUpdate'),
  onUpdateState: listener => {
    const handler = (_event, state) => listener(state)

    ipcRenderer.on('codex:updateState', handler)
    return () => ipcRenderer.removeListener('codex:updateState', handler)
  },
  getRelayApiKey: id => ipcRenderer.invoke('codex:getRelayApiKey', id),
  saveRelay: payload => ipcRenderer.invoke('codex:saveRelay', payload),
  syncNewApi: payload => ipcRenderer.invoke('codex:syncNewApi', payload),
  refreshNewApiChannel: id => ipcRenderer.invoke('codex:refreshNewApiChannel', id),
  selectNewApiKey: (id, tokenId) => ipcRenderer.invoke('codex:selectNewApiKey', id, tokenId),
  inspectLocalToolRuntime: () => ipcRenderer.invoke('codex:inspectLocalToolRuntime'),
  initializeLocalToolRuntime: mode => ipcRenderer.invoke('codex:initializeLocalToolRuntime', mode),
  repairLocalToolRuntime: mode => ipcRenderer.invoke('codex:repairLocalToolRuntime', mode),
  inspectDiskUsage: () => ipcRenderer.invoke('codex:inspectDiskUsage'),
  maintainDisk: () => ipcRenderer.invoke('codex:maintainDisk', { confirmed: true }),
  repairConversationIndex: () => ipcRenderer.invoke('codex:repairConversationIndex'),
  recoverTask: taskId => ipcRenderer.invoke('codex:recoverTask', taskId),
  onTaskRecoveryProgress: listener => {
    const handler = (_event, progress) => listener(progress)

    ipcRenderer.on('codex:taskRecoveryProgress', handler)
    return () => ipcRenderer.removeListener('codex:taskRecoveryProgress', handler)
  },
  testRelay: payload => ipcRenderer.invoke('codex:testRelay', payload),
  testSavedRelay: (id, model) => ipcRenderer.invoke('codex:testSavedRelay', id, model),
  applyRelay: (id, model, operationId) => ipcRenderer.invoke('codex:applyRelay', id, model, operationId),
  onApplyRelayProgress: listener => {
    const handler = (_event, progress) => listener(progress)

    ipcRenderer.on('codex:applyRelayProgress', handler)
    return () => ipcRenderer.removeListener('codex:applyRelayProgress', handler)
  },
  restoreDefault: () => ipcRenderer.invoke('codex:restoreDefault'),
  restoreInitialBackup: () => ipcRenderer.invoke('codex:restoreInitialBackup'),
  removeRelay: id => ipcRenderer.invoke('codex:removeRelay', id),
  openPath: targetPath => ipcRenderer.invoke('codex:openPath', targetPath),
  deleteSession: idOrPath => ipcRenderer.invoke('codex:deleteSession', idOrPath),
  deleteConversationData: filters =>
    ipcRenderer.invoke('codex:deleteConversationData', { ...filters, confirmed: true }),
  importConversationData: kind => ipcRenderer.invoke('codex:importConversationData', kind),
  exportConversationData: (kind, sourcePath) => ipcRenderer.invoke('codex:exportConversationData', kind, sourcePath),
  deleteProject: projectPath => ipcRenderer.invoke('codex:deleteProject', projectPath),
  importSkillZip: () => ipcRenderer.invoke('codex:importSkillZip'),
  importAgentZip: () => ipcRenderer.invoke('codex:importAgentZip'),
  importSkillFromGithub: url => ipcRenderer.invoke('codex:importSkillFromGithub', url),
  importAgentFromGithub: url => ipcRenderer.invoke('codex:importAgentFromGithub', url),
  exportSkill: name => ipcRenderer.invoke('codex:exportSkill', name),
  exportAgent: name => ipcRenderer.invoke('codex:exportAgent', name)
})
