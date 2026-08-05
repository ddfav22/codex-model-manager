const fs = require('fs')
const path = require('path')
const { dialog, ipcMain, shell } = require('electron')
const { toUserFacingErrorMessage } = require('../features/userFacingErrors')
const { sameOrigin } = require('./windowSecurity')

function assertTrustedSender(event, getMainWindow) {
  const window = getMainWindow()
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || ''
  const trustedUrl = window?.webContents?.getURL?.() || ''

  if (!window || event.sender !== window.webContents || !sameOrigin(senderUrl, trustedUrl)) {
    throw new Error('已拒绝非管理器页面的 IPC 请求')
  }
}

function registerIpcHandlers({
  getMainWindow,
  getRuntimeReadyPromise,
  logError,
  logEvent,
  manager,
  openRuntimeLog,
  updater,
  writeRuntimeDiagnostic
}) {
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrustedSender(event, getMainWindow)

        return await handler(event, ...args)
      } catch (error) {
        logError('ipc.request.failed', error, { channel })
        throw new Error(toUserFacingErrorMessage(error))
      }
    })
  }
  const simpleHandlers = {
    'codex:getRelayApiKey': (_event, id) => manager.getRelayApiKey(id),
    'codex:saveRelay': (_event, payload) => manager.saveRelay(payload),
    'codex:syncNewApi': (_event, payload) => manager.syncNewApi(payload),
    'codex:refreshNewApiChannel': (_event, id) => manager.refreshNewApiChannel(id),
    'codex:selectNewApiKey': (_event, id, tokenId) => manager.selectNewApiKey(id, tokenId),
    'codex:inspectLocalToolRuntime': () => manager.inspectLocalToolRuntime(),
    'codex:initializeLocalToolRuntime': (_event, mode) => manager.initializeLocalToolRuntime(mode),
    'codex:repairLocalToolRuntime': (_event, mode) => manager.repairLocalToolRuntime(mode),
    'codex:inspectDiskUsage': () => manager.inspectCodexDiskUsage(),
    'codex:openRuntimeLog': () => openRuntimeLog(),
    'codex:testRelay': (_event, payload) => manager.testAndSaveRelay(payload),
    'codex:testSavedRelay': (_event, id, model) => manager.testSavedRelay(id, model),
    'codex:restoreDefault': () => manager.restoreDefaultProvider(),
    'codex:restoreInitialBackup': () => manager.restoreInitialBackup(),
    'codex:removeRelay': (_event, id) => manager.removeRelay(id),
    'codex:deleteSession': (_event, idOrPath) => manager.deleteSession(idOrPath),
    'codex:deleteProject': (_event, projectPath) => manager.deleteProject(projectPath),
    'codex:importSkillFromGithub': (_event, url) => manager.importSkillFromGithub(url),
    'codex:importAgentFromGithub': (_event, url) => manager.importAgentFromGithub(url)
  }

  handle('codex:getStatus', (_event, forceCodexTargetScan = false) =>
    manager.readStatus({ forceCodexTargetScan: forceCodexTargetScan === true })
  )
  handle('codex:getUpdateState', () => updater.getState())
  handle('codex:checkForUpdates', (_event, manual = true) =>
    updater.check({ manual: manual === true, autoDownload: true })
  )
  handle('codex:installUpdate', () => updater.install())
  Object.entries(simpleHandlers).forEach(([channel, handler]) => handle(channel, handler))
  handle('codex:maintainDisk', (_event, payload) => {
    const result = manager.maintainCodexDisk(payload)

    writeRuntimeDiagnostic({
      lastDiskMaintenance: {
        completedAt: new Date().toISOString(),
        ok: result.ok,
        removedBytes: result.removedBytes,
        errors: result.errors,
        restart: result.restart
      }
    })
    return result
  })
  handle('codex:repairConversationIndex', async () => {
    const repair = await manager.repairCodexConversationIndex()
    const restart = repair.ok
      ? {
          ok: true,
          skipped: true,
          manual: true,
          target: null,
          targets: [],
          message: '索引已修复。请手动关闭并重新打开 Codex。'
        }
      : { ok: false, target: null, targets: [], error: '仍有对话未写入 Codex 客户端索引' }

    writeRuntimeDiagnostic({ conversationIndexRepair: repair })
    return { ...repair, restart, status: manager.readStatus() }
  })
  handle('codex:applyRelay', async (event, id, model, operationId) => {
    const safeOperationId = String(operationId || '').slice(0, 96)
    const sendProgress = progress => {
      if (event.sender.isDestroyed()) return

      event.sender.send('codex:applyRelayProgress', {
        ...progress,
        operationId: safeOperationId,
        channelId: String(id || ''),
        model: String(model || '')
      })
    }

    sendProgress({
      stage: 'waiting-runtime',
      progress: 2,
      message: '正在等待后台服务就绪',
      status: 'running',
      updatedAt: new Date().toISOString()
    })
    await getRuntimeReadyPromise()
    sendProgress({
      stage: 'runtime-ready',
      progress: 4,
      message: '后台服务已就绪，正在配置 Codex',
      status: 'running',
      updatedAt: new Date().toISOString()
    })
    const activationStartedAt = Date.now()

    logEvent('info', 'relay.activate.start', {
      id,
      model,
      automaticCodexLaunch: true,
      automaticApiKeyLogin: true
    })
    let result

    try {
      result = await manager.activateRelay(id, model, {
        loginWithApiKey: true,
        restartCodex: true,
        onProgress: sendProgress
      })
    } catch (error) {
      sendProgress({
        stage: 'failed',
        progress: 100,
        message: 'Codex 配置或启动失败，请查看错误提示',
        status: 'error',
        updatedAt: new Date().toISOString()
      })
      logError('relay.activate.failed', error, { id, model })
      throw error
    }

    writeRuntimeDiagnostic(
      {
        lastApply: {
          capturedAt: new Date().toISOString(),
          id,
          model,
          restart: result.restart,
          authLogin: result.authLogin,
          timings: result.timings,
          conversationIndexRepairBefore: result.conversationIndexRepairBefore,
          conversationIndexRepair: result.conversationIndexRepair
        }
      },
      { lightweight: true }
    )
    logEvent('info', 'relay.activate.complete', {
      id,
      model,
      restartOk: result.restart?.ok === true,
      manualRestart: result.restart?.manual === true,
      authLogin: result.authLogin?.reason || '',
      historyRepairRequested: result.conversationIndexRepair !== null,
      availableModels: result.status?.providers?.find(provider => provider.id === id)?.models || [],
      projectSync: {
        changed: result.restart?.afterStopResult?.desktopProjects?.changed === true,
        projectCount: result.restart?.afterStopResult?.desktopProjects?.projectCount || 0,
        pinnedProjectCount: result.restart?.afterStopResult?.desktopProjects?.pinnedProjectCount || 0,
        assignedThreadCount: result.restart?.afterStopResult?.desktopProjects?.assignedThreadCount || 0
      },
      timings: result.timings,
      durationMs: Date.now() - activationStartedAt
    })
    return result
  })
  handle('codex:openPath', async (_event, targetPath) => {
    if (!targetPath || !fs.existsSync(targetPath)) return { ok: false }
    const stat = fs.statSync(targetPath)

    if (stat.isFile()) {
      shell.showItemInFolder(targetPath)
      return { ok: true }
    }

    const error = await shell.openPath(targetPath)

    return { ok: !error, error }
  })
  handle('codex:deleteConversationData', async (_event, filters) => {
    if (filters?.confirmed !== true || !['active', 'archived'].includes(String(filters?.scope || ''))) {
      throw new Error('批量删除必须经过确认并指定有效的会话范围')
    }
    const { confirmed: _confirmed, ...safeFilters } = filters

    logEvent('info', 'conversation.delete.start', {
      scope: safeFilters.scope,
      filteredByProject: Boolean(safeFilters.projectPath),
      filteredByQuery: Boolean(safeFilters.query)
    })
    const result = await manager.deleteConversationData(safeFilters, {
      stopClientsOnBusy: true,
      refreshConversationIndex: true
    })

    logEvent('info', 'conversation.delete.complete', {
      scope: safeFilters.scope,
      filteredByProject: Boolean(safeFilters.projectPath),
      filteredByQuery: Boolean(safeFilters.query),
      deletedSessionCount: result.deletedSessionCount,
      skippedSessionCount: result.skippedSessionCount,
      deletedProjectCount: result.deletedProjectCount,
      skippedProjectCount: result.skippedProjectCount,
      stoppedProcessCount: result.stoppedProcessCount,
      configurationUpdated: !result.configurationError,
      indexDeleteOk: result.indexDelete?.ok === true,
      indexDeleteCount: result.indexDelete?.deletedCount || 0,
      indexRefreshOk: result.indexRefresh?.ok === true
    })
    return result
  })
  handle('codex:importConversationData', async (_event, kind) => {
    if (!['session', 'project'].includes(kind)) throw new Error('请选择要导入的内容类型')
    const session = kind === 'session'
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: session ? '导入 Codex 对话' : '导入 Codex 项目',
      properties: [session ? 'openFile' : 'openDirectory'],
      ...(session ? { filters: [{ name: 'Codex 对话文件', extensions: ['jsonl'] }] } : {})
    })

    if (result.canceled || !result.filePaths[0]) return null
    const imported = session
      ? manager.importSession(result.filePaths[0])
      : { status: manager.addProject(result.filePaths[0]), target: result.filePaths[0] }

    logEvent('info', 'conversation.import.complete', { kind })
    return { kind, status: imported.status, target: imported.target }
  })
  handle('codex:exportConversationData', async (_event, kind, sourcePath) => {
    if (!['session', 'project'].includes(kind)) throw new Error('请选择要导出的内容类型')
    if (!sourcePath) throw new Error('请选择要导出的对话或项目')
    const session = kind === 'session'
    const sourceName = path.basename(String(sourcePath), path.extname(String(sourcePath))) || kind
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: session ? '导出 Codex 对话' : '导出 Codex 项目',
      defaultPath: `${sourceName}.${session ? 'jsonl' : 'zip'}`,
      filters: [
        session ? { name: 'Codex 对话文件', extensions: ['jsonl'] } : { name: 'Zip 压缩包', extensions: ['zip'] }
      ]
    })

    if (result.canceled || !result.filePath) return null
    const expectedExtension = session ? '.jsonl' : '.zip'
    const destinationPath = path.extname(result.filePath) ? result.filePath : `${result.filePath}${expectedExtension}`
    const exported = session
      ? manager.exportSession(sourcePath, destinationPath)
      : await manager.exportProject(sourcePath, destinationPath)

    logEvent('info', 'conversation.export.complete', { kind })
    return exported
  })
  handle('codex:importSkillZip', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '导入 Skill zip',
      properties: ['openFile'],
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
    })

    if (result.canceled || !result.filePaths[0]) return null

    return manager.importSkillZip(result.filePaths[0])
  })
  handle('codex:importAgentZip', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '导入自定义 Agent',
      properties: ['openFile'],
      filters: [{ name: 'Agent TOML 或 Zip', extensions: ['toml', 'zip'] }]
    })

    if (result.canceled || !result.filePaths[0]) return null

    return manager.importAgentZip(result.filePaths[0])
  })
  handle('codex:exportSkill', async (_event, identifier) => {
    const defaultName = path.basename(String(identifier || 'skill')).replace(/\.zip$/i, '')
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: '导出 Skill',
      defaultPath: `${defaultName}.zip`,
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
    })

    if (result.canceled || !result.filePath) return null

    return manager.exportSkill(identifier, result.filePath)
  })
  handle('codex:exportAgent', async (_event, identifier) => {
    const defaultName = path.basename(String(identifier || 'agent'), path.extname(String(identifier || 'agent')))
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: '导出 Agent',
      defaultPath: `${defaultName}.zip`,
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }]
    })

    if (result.canceled || !result.filePath) return null

    return manager.exportAgent(identifier, result.filePath)
  })
}

module.exports = {
  assertTrustedSender,
  registerIpcHandlers
}
