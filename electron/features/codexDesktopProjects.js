const fs = require('fs')
const path = require('path')
const GLOBAL_STATE_FILENAME = '.codex-global-state.json'

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {}

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex 项目状态文件格式不正确，已停止写入以保护原数据。')
  }

  return parsed
}

function resolvedRoot(value) {
  const input = String(value || '').trim()

  if (!input) return ''

  return path.resolve(input)
}

function rootKey(value) {
  return resolvedRoot(value).toLowerCase()
}

function validSessionProjects(sessions) {
  const seenIds = new Set()

  return (Array.isArray(sessions) ? sessions : []).flatMap(session => {
    const id = String(session?.id || '').trim()
    const cwd = resolvedRoot(session?.cwd)

    if (!id || !cwd || seenIds.has(id)) return []

    try {
      if (!fs.statSync(cwd).isDirectory()) return []
    } catch {
      return []
    }

    seenIds.add(id)

    return [{ id, cwd }]
  })
}

function localProjectRoots(state) {
  const localProjects =
    state?.['local-projects'] && typeof state['local-projects'] === 'object' && !Array.isArray(state['local-projects'])
      ? state['local-projects']
      : {}
  const roots = []
  const seen = new Set()

  for (const project of Object.values(localProjects)) {
    for (const rootPath of Array.isArray(project?.rootPaths) ? project.rootPaths : []) {
      const resolved = resolvedRoot(rootPath)
      const key = rootKey(resolved)

      if (!key || seen.has(key)) continue
      seen.add(key)
      roots.push(resolved)
    }
  }

  return roots
}

function backupStateFile(filePath, backupDir, now) {
  if (!fs.existsSync(filePath)) return ''

  const targetDir = backupDir || path.dirname(filePath)
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const backupPath = path.join(targetDir, `${GLOBAL_STATE_FILENAME}.projects-${stamp}.bak`)

  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(filePath, backupPath)

  return backupPath
}

function writeVerifiedJson(filePath, value, backupPath) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tempPath = `${filePath}.codex-manager-${process.pid}-${Date.now()}.tmp`

  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  try {
    fs.writeFileSync(tempPath, text, 'utf8')
    readJsonObject(tempPath)
    fs.renameSync(tempPath, filePath)
    readJsonObject(filePath)
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath)) fs.copyFileSync(backupPath, filePath)
    throw error
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  }
}

function syncDesktopProjectsFromSessions(globalStatePath, sessions, options = {}) {
  const validSessions = validSessionProjects(sessions)

  if (!validSessions.length) {
    return {
      changed: false,
      addedProjectCount: 0,
      assignedThreadCount: 0,
      projectCount: 0,
      pinnedProjectCount: 0,
      backupPath: ''
    }
  }

  const state = readJsonObject(globalStatePath)
  const localProjects =
    state['local-projects'] && typeof state['local-projects'] === 'object' && !Array.isArray(state['local-projects'])
      ? { ...state['local-projects'] }
      : {}
  const assignments =
    state['thread-project-assignments'] &&
    typeof state['thread-project-assignments'] === 'object' &&
    !Array.isArray(state['thread-project-assignments'])
      ? { ...state['thread-project-assignments'] }
      : {}
  const projectlessThreadIds = new Set(
    (Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []).map(String)
  )
  const projectsByRoot = new Map()

  for (const [projectId, project] of Object.entries(localProjects)) {
    for (const rootPath of Array.isArray(project?.rootPaths) ? project.rootPaths : []) {
      const key = rootKey(rootPath)

      if (key && !projectsByRoot.has(key)) projectsByRoot.set(key, projectId)
    }
  }

  const sessionProjects = validSessions.flatMap(session => {
    if (projectlessThreadIds.has(session.id)) return []

    const current = assignments[session.id]
    const assignedProjectId =
      current?.projectKind === 'local' && localProjects[current.projectId] ? String(current.projectId) : ''
    const projectId = assignedProjectId || projectsByRoot.get(rootKey(session.cwd)) || ''

    return projectId ? [{ ...session, projectId }] : []
  })
  const timestamp = Number(options.now || Date.now())
  const syncedProjectIds = []
  const syncedProjectIdSet = new Set()
  let assignedThreadCount = 0

  for (const session of sessionProjects) {
    const key = rootKey(session.cwd)
    const projectId = session.projectId

    if (!syncedProjectIdSet.has(projectId)) {
      syncedProjectIdSet.add(projectId)
      syncedProjectIds.push(projectId)
    }

    const expected = {
      projectKind: 'local',
      projectId,
      cwd: session.cwd,
      pendingCoreUpdate: false
    }
    const current = assignments[session.id]

    if (
      current?.projectKind !== expected.projectKind ||
      current?.projectId !== expected.projectId ||
      rootKey(current?.cwd) !== key ||
      current?.pendingCoreUpdate !== false
    ) {
      assignments[session.id] = expected
      assignedThreadCount += 1
    }
  }

  const assignedIds = new Set(sessionProjects.map(session => session.id))
  const projectlessBefore = Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []
  const projectlessAfter = projectlessBefore.filter(id => !assignedIds.has(String(id)))
  const hintsBefore =
    state['thread-workspace-root-hints'] &&
    typeof state['thread-workspace-root-hints'] === 'object' &&
    !Array.isArray(state['thread-workspace-root-hints'])
      ? state['thread-workspace-root-hints']
      : {}
  const hintsAfter = Object.fromEntries(
    Object.entries(hintsBefore).filter(([threadId]) => !assignedIds.has(String(threadId)))
  )
  const existingOrder = Array.isArray(state['project-order']) ? state['project-order'].map(String) : []
  const knownProjectIds = new Set(Object.keys(localProjects))
  const orderCandidates = [
    ...existingOrder.filter(projectId => knownProjectIds.has(projectId)),
    ...Object.keys(localProjects).filter(projectId => !existingOrder.includes(projectId))
  ]
  const projectOrder = [...new Set(orderCandidates)]
  const pinnedBefore = Array.isArray(state['pinned-project-ids']) ? state['pinned-project-ids'].map(String) : []
  const pinnedProjectIds = [...new Set([...pinnedBefore, ...syncedProjectIds])]
  const changed =
    assignedThreadCount > 0 ||
    projectlessAfter.length !== projectlessBefore.length ||
    Object.keys(hintsAfter).length !== Object.keys(hintsBefore).length ||
    JSON.stringify(projectOrder) !== JSON.stringify(existingOrder) ||
    JSON.stringify(pinnedProjectIds) !== JSON.stringify(pinnedBefore)

  if (!changed) {
    return {
      changed: false,
      addedProjectCount: 0,
      assignedThreadCount: 0,
      projectCount: Object.keys(localProjects).length,
      pinnedProjectCount: pinnedProjectIds.length,
      backupPath: ''
    }
  }

  const next = {
    ...state,
    'local-projects': localProjects,
    'project-order': projectOrder,
    'pinned-project-ids': pinnedProjectIds,
    'thread-project-assignments': assignments,
    'projectless-thread-ids': projectlessAfter,
    'thread-workspace-root-hints': hintsAfter
  }
  const backupPath = backupStateFile(globalStatePath, options.backupDir, timestamp)

  writeVerifiedJson(globalStatePath, next, backupPath)

  return {
    changed: true,
    addedProjectCount: 0,
    addedProjects: [],
    assignedThreadCount,
    projectCount: Object.keys(localProjects).length,
    pinnedProjectCount: pinnedProjectIds.length,
    backupPath
  }
}

module.exports = {
  GLOBAL_STATE_FILENAME,
  readJsonObject,
  rootKey,
  localProjectRoots,
  syncDesktopProjectsFromSessions,
  validSessionProjects
}
