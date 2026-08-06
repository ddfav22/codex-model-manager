const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PATCH_STATE_NAME = 'app-asar-patch-state.json'
const PATCH_HELPER_NAME = 'app-asar-patch-installer.js'
const PATCH_STARTUP_TIMEOUT_MS = 60_000

function rawFileSystem() {
  try {
    return require('original-fs')
  } catch {
    return fs
  }
}

function sha256File(filePath, fsModule = fs) {
  const hash = crypto.createHash('sha256')
  const descriptor = fsModule.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)

  try {
    let bytesRead = 0

    do {
      bytesRead = fsModule.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fsModule.closeSync(descriptor)
  }

  return hash.digest('hex')
}

function isDirectChild(parent, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(parent)
}

function validatePatchOptions(options) {
  const updatesRoot = path.resolve(String(options.updatesRoot || ''))
  const resourcesRoot = path.resolve(String(options.resourcesRoot || ''))
  const executablePath = path.resolve(String(options.executablePath || ''))
  const patchPath = path.resolve(String(options.patchPath || ''))
  const expectedDigest = String(options.expectedDigest || '').toLowerCase()
  const parentPid = Number(options.parentPid)
  const token = String(options.token || '')

  if (!options.updatesRoot || updatesRoot === path.parse(updatesRoot).root) throw new Error('补丁更新目录无效。')
  if (!options.resourcesRoot || path.basename(resourcesRoot).toLowerCase() !== 'resources') {
    throw new Error('补丁目标资源目录无效。')
  }
  if (path.dirname(resourcesRoot) !== path.dirname(executablePath)) throw new Error('补丁目标不属于当前程序目录。')
  if (!isDirectChild(updatesRoot, patchPath) || path.extname(patchPath).toLowerCase() !== '.asar') {
    throw new Error('补丁文件不属于受控更新目录。')
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error('补丁 SHA-256 无效。')
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error('补丁父进程编号无效。')
  if (!/^[a-f0-9]{32}$/u.test(token)) throw new Error('补丁健康令牌无效。')

  return {
    updatesRoot,
    resourcesRoot,
    executablePath,
    patchPath,
    expectedDigest,
    parentPid,
    token,
    fromVersion: String(options.fromVersion || ''),
    toVersion: String(options.toVersion || ''),
    targetPath: path.join(resourcesRoot, 'app.asar'),
    backupPath: path.join(updatesRoot, `app-${String(options.fromVersion || 'previous')}.asar.backup`),
    statePath: path.join(updatesRoot, PATCH_STATE_NAME)
  }
}

function writeJsonAtomic(filePath, value, fsModule = fs) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  fsModule.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (fsModule.existsSync(filePath)) fsModule.rmSync(filePath, { force: true })
  fsModule.renameSync(temporaryPath, filePath)
}

function readJson(filePath, fsModule = fs) {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function patchState(options, status, extra = {}, fsModule = fs) {
  const state = {
    schemaVersion: 1,
    status,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    token: options.token,
    updatedAt: new Date().toISOString(),
    ...extra
  }

  writeJsonAtomic(options.statePath, state, fsModule)

  return state
}

function replaceAppAsar(options, fsModule = fs) {
  if (!fsModule.existsSync(options.targetPath)) throw new Error('当前 app.asar 不存在，不能应用轻量补丁。')
  if (!fsModule.existsSync(options.patchPath)) throw new Error('轻量补丁文件不存在。')
  if (sha256File(options.patchPath, fsModule) !== options.expectedDigest) throw new Error('轻量补丁再次校验失败。')

  const nextPath = `${options.targetPath}.patch-new`
  const previousPath = `${options.targetPath}.patch-previous`

  fsModule.copyFileSync(options.patchPath, nextPath)
  if (sha256File(nextPath, fsModule) !== options.expectedDigest) {
    fsModule.rmSync(nextPath, { force: true })
    throw new Error('轻量补丁复制校验失败。')
  }
  fsModule.copyFileSync(options.targetPath, options.backupPath)

  try {
    if (fsModule.existsSync(previousPath)) fsModule.rmSync(previousPath, { force: true })
    fsModule.renameSync(options.targetPath, previousPath)
    fsModule.renameSync(nextPath, options.targetPath)
    fsModule.rmSync(previousPath, { force: true })
  } catch (error) {
    if (!fsModule.existsSync(options.targetPath) && fsModule.existsSync(previousPath)) {
      fsModule.renameSync(previousPath, options.targetPath)
    }
    fsModule.rmSync(nextPath, { force: true })
    throw error
  }
}

function restoreAppAsar(options, fsModule = fs) {
  if (!fsModule.existsSync(options.backupPath)) throw new Error('轻量补丁回滚备份不存在。')

  const failedPath = path.join(options.updatesRoot, `app-${options.toVersion || 'failed'}.asar.failed`)
  const restoredPath = `${options.targetPath}.patch-restored`

  if (fsModule.existsSync(options.targetPath)) fsModule.copyFileSync(options.targetPath, failedPath)
  fsModule.copyFileSync(options.backupPath, restoredPath)
  if (fsModule.existsSync(options.targetPath)) fsModule.rmSync(options.targetPath, { force: true })
  fsModule.renameSync(restoredPath, options.targetPath)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function defaultWaitForParentExit(parentPid, timeoutMs = PATCH_STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      process.kill(parentPid, 0)
      await delay(200)
    } catch {
      return true
    }
  }

  return false
}

function launchApplication(executablePath, args = []) {
  const environment = { ...process.env }

  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(executablePath, args, {
    detached: true,
    env: environment,
    stdio: 'ignore',
    windowsHide: false
  })

  child.unref()

  return child
}

async function waitForHealthyState(statePath, token, timeoutMs = PATCH_STARTUP_TIMEOUT_MS, fsModule = fs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const state = readJson(statePath, fsModule)

    if (state?.token === token && state?.status === 'healthy') return true
    await delay(250)
  }

  return false
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null) return true

  return await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)

    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function runPatchInstaller(rawOptions, dependencies = {}) {
  const fsModule = dependencies.fsModule || rawFileSystem()
  const options = validatePatchOptions(rawOptions)
  const waitForParentExit = dependencies.waitForParentExit || defaultWaitForParentExit
  const launch = dependencies.launchApplication || launchApplication
  const waitForHealth = dependencies.waitForHealthyState || waitForHealthyState

  fsModule.mkdirSync(options.updatesRoot, { recursive: true })
  patchState(options, 'waiting-for-exit', {}, fsModule)

  if (!(await waitForParentExit(options.parentPid))) {
    patchState(options, 'failed', { reason: 'parent-exit-timeout' }, fsModule)
    throw new Error('等待旧客户端退出超时，未应用轻量补丁。')
  }

  let nextProcess = null

  try {
    replaceAppAsar(options, fsModule)
    patchState(options, 'pending-health-check', {}, fsModule)
    nextProcess = launch(options.executablePath, [`--patch-health-token=${options.token}`])
    const healthy = await waitForHealth(options.statePath, options.token, PATCH_STARTUP_TIMEOUT_MS, fsModule)

    if (!healthy) throw new Error('startup-health-timeout')
    fsModule.rmSync(options.backupPath, { force: true })
    fsModule.rmSync(options.patchPath, { force: true })

    return { ok: true, rolledBack: false }
  } catch (error) {
    nextProcess?.kill?.()
    await waitForChildExit(nextProcess)
    const backupAvailable = fsModule.existsSync(options.backupPath)

    if (backupAvailable) restoreAppAsar(options, fsModule)
    patchState(
      options,
      backupAvailable ? 'rolled-back' : 'failed',
      { reason: error instanceof Error ? error.message : String(error) },
      fsModule
    )
    launch(options.executablePath, [`--patch-rollback=${options.toVersion}`])

    return { ok: false, rolledBack: backupAvailable }
  }
}

function completePendingPatch({ updatesRoot, token }, fsModule = fs) {
  const normalizedToken = String(token || '')

  if (!/^[a-f0-9]{32}$/u.test(normalizedToken)) return { completed: false, reason: 'missing-token' }
  const statePath = path.join(path.resolve(updatesRoot), PATCH_STATE_NAME)
  const state = readJson(statePath, fsModule)

  if (state?.status !== 'pending-health-check' || state?.token !== normalizedToken) {
    return { completed: false, reason: 'state-mismatch' }
  }

  writeJsonAtomic(
    statePath,
    { ...state, status: 'healthy', healthyAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    fsModule
  )

  return { completed: true, fromVersion: state.fromVersion, toVersion: state.toVersion }
}

function parseHelperArguments(argv) {
  const values = {}

  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '').replace(/^--/u, '')

    if (!key || index + 1 >= argv.length) throw new Error('轻量补丁辅助进程参数无效。')
    values[key] = argv[index + 1]
  }

  return {
    updatesRoot: values['updates-root'],
    resourcesRoot: values['resources-root'],
    executablePath: values.executable,
    patchPath: values.patch,
    expectedDigest: values.digest,
    parentPid: Number(values['parent-pid']),
    token: values.token,
    fromVersion: values.from,
    toVersion: values.to
  }
}

if (require.main === module) {
  runPatchInstaller(parseHelperArguments(process.argv.slice(2)))
    .then(result => {
      if (!result.ok) process.exitCode = 1
    })
    .catch(error => {
      try {
        const options = validatePatchOptions(parseHelperArguments(process.argv.slice(2)))

        patchState(
          options,
          'failed',
          { reason: error instanceof Error ? error.message : String(error) },
          rawFileSystem()
        )
      } catch {
        // No trusted state path is available, so only the process exit code can report failure.
      }
      process.exitCode = 1
    })
}

module.exports = {
  PATCH_HELPER_NAME,
  PATCH_STARTUP_TIMEOUT_MS,
  PATCH_STATE_NAME,
  completePendingPatch,
  parseHelperArguments,
  patchState,
  readJson,
  replaceAppAsar,
  restoreAppAsar,
  runPatchInstaller,
  sha256File,
  validatePatchOptions,
  writeJsonAtomic
}
