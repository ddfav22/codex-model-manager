const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { PATCH_HELPER_NAME, PATCH_STATE_NAME, readJson } = require('./patchInstaller')

function rawFileSystem() {
  try {
    return require('original-fs')
  } catch {
    return fs
  }
}

const MAX_UPDATE_BYTES = 512 * 1024 * 1024
const MAX_PATCH_BYTES = 64 * 1024 * 1024
const CHECK_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const INSTALL_START_TIMEOUT_MS = 10_000

function normalizeVersion(value) {
  const match = String(value || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/i)

  return match ? match.slice(1).map(item => Number(item)) : null
}

function compareVersionStrings(left, right) {
  const leftVersion = normalizeVersion(left)
  const rightVersion = normalizeVersion(right)

  if (!leftVersion || !rightVersion) throw new Error('更新版本号格式无效。')
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) return leftVersion[index] - rightVersion[index]
  }

  return 0
}

function repositoryFromPackageMetadata(metadata) {
  const repository = typeof metadata?.repository === 'string' ? metadata.repository : metadata?.repository?.url
  const match = String(repository || '').match(/github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i)

  return match ? `${match[1]}/${match[2]}` : ''
}

function expectedInstallerName(version) {
  return `ChatGPT-Model-Manager-Setup-${version}-x64.exe`
}

function validRuntimeId(value) {
  return /^[a-z0-9][a-z0-9.-]{2,63}$/u.test(String(value || ''))
}

function expectedPatchName(fromVersion, toVersion, runtimeId) {
  if (!normalizeVersion(fromVersion) || !normalizeVersion(toVersion) || !validRuntimeId(runtimeId)) return ''

  return `ChatGPT-Model-Manager-Patch-${fromVersion}-to-${toVersion}-${runtimeId}-x64.asar`
}

function parseSha256Digest(value) {
  const match = String(value || '')
    .trim()
    .match(/^sha256:([a-f0-9]{64})$/i)

  return match ? match[1].toLowerCase() : ''
}

function releaseAssetUrlAllowed(urlValue, repository) {
  try {
    const url = new URL(urlValue)

    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/releases/download/`)
    )
  } catch {
    return false
  }
}

function resolveInstallDirectory(currentExecutablePath) {
  const executablePath = path.resolve(String(currentExecutablePath || ''))
  const installDirectory = path.dirname(executablePath)

  if (!currentExecutablePath || installDirectory === path.parse(installDirectory).root) {
    throw new Error('无法确定当前程序目录，已取消更新。')
  }
  if (/[\0\r\n"]/u.test(installDirectory)) throw new Error('当前程序目录格式无效，已取消更新。')

  return installDirectory
}

function updateInstallerArguments(installDirectory) {
  const resolvedDirectory = path.resolve(String(installDirectory || ''))

  if (!path.isAbsolute(resolvedDirectory) || resolvedDirectory === path.parse(resolvedDirectory).root) {
    throw new Error('更新安装目录无效。')
  }
  if (/[\0\r\n"]/u.test(resolvedDirectory)) throw new Error('更新安装目录格式无效。')

  return ['/S', '/currentuser', '--updated', '--force-run', '--keep-shortcuts', `/D=${resolvedDirectory}`]
}

function headerValue(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''

  return headers[name] || headers[name.toLowerCase()] || ''
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

function createAppUpdater(options = {}) {
  const currentVersion = String(options.currentVersion || '')
  const currentExecutablePath = path.resolve(options.currentExecutablePath || process.execPath)
  const currentResourcesPath = path.resolve(
    options.currentResourcesPath || path.join(path.dirname(currentExecutablePath), 'resources')
  )
  const currentProcessId = Number(options.currentProcessId || process.pid)
  const runtimeId = String(options.runtimeId || '')
  const repository = String(options.repository || '').trim()
  const updatesRoot = path.resolve(options.updatesRoot || path.join(process.cwd(), 'data', 'updates'))
  const fetchFn = options.fetchFn || globalThis.fetch
  const fsModule = options.fsModule || rawFileSystem()
  const spawnFn = options.spawnFn || spawn
  const emitState = typeof options.onState === 'function' ? options.onState : () => {}
  const logEvent = typeof options.logEvent === 'function' ? options.logEvent : () => {}
  const logError = typeof options.logError === 'function' ? options.logError : () => {}
  const onBeforeInstall = typeof options.onBeforeInstall === 'function' ? options.onBeforeInstall : () => {}
  const installDirectory = resolveInstallDirectory(currentExecutablePath)
  const patchSupported =
    validRuntimeId(runtimeId) &&
    path.basename(currentResourcesPath).toLowerCase() === 'resources' &&
    path.dirname(currentResourcesPath) === installDirectory
  const enabled = options.enabled !== false && Boolean(repository) && typeof fetchFn === 'function'
  let activeCheck = null
  let readyPath = ''
  let readyDigest = ''
  let readyDeliveryType = ''
  let state = {
    stage: enabled ? 'idle' : 'unsupported',
    currentVersion,
    latestVersion: '',
    message: enabled ? '尚未检查更新' : '当前版本暂未配置在线更新源',
    manual: false,
    deliveryType: '',
    downloadPercent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    releaseUrl: '',
    releaseNotes: ''
  }

  const publishState = patch => {
    state = { ...state, ...patch }
    emitState({ ...state })

    return { ...state }
  }

  const fetchWithTimeout = async (url, timeoutMs, requestOptions = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetchFn(url, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `codex-model-manager/${currentVersion}`,
          ...(requestOptions.headers || {})
        }
      })
    } finally {
      clearTimeout(timer)
    }
  }

  const downloadRelease = async ({
    asset,
    expectedName,
    deliveryType,
    latestVersion,
    manual,
    releaseUrl,
    releaseNotes
  }) => {
    const digest = parseSha256Digest(asset.digest)
    const maximumBytes = deliveryType === 'patch' ? MAX_PATCH_BYTES : MAX_UPDATE_BYTES
    const deliveryLabel = deliveryType === 'patch' ? '轻量补丁' : '完整安装包'

    if (asset.name !== expectedName) throw new Error(`${deliveryLabel}名称不符合安全规则。`)
    if (!digest) throw new Error(`${deliveryLabel}缺少 SHA-256 校验信息，已拒绝下载。`)
    if (!releaseAssetUrlAllowed(asset.browser_download_url, repository)) {
      throw new Error(`${deliveryLabel}下载地址不是受信任的 GitHub Release。`)
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0 || asset.size > maximumBytes) {
      throw new Error(`${deliveryLabel}大小异常，已拒绝下载。`)
    }

    fsModule.mkdirSync(updatesRoot, { recursive: true })
    const targetPath = path.join(updatesRoot, expectedName)
    const partialPath = `${targetPath}.part`

    if (fsModule.existsSync(targetPath) && sha256File(targetPath, fsModule) === digest) {
      readyPath = targetPath
      readyDigest = digest
      readyDeliveryType = deliveryType

      return publishState({
        stage: 'ready',
        latestVersion,
        message: `${deliveryLabel}已下载，可以重启更新到 ${latestVersion}`,
        manual,
        deliveryType,
        downloadPercent: 100,
        downloadedBytes: asset.size,
        totalBytes: asset.size,
        releaseUrl,
        releaseNotes
      })
    }

    fsModule.rmSync(partialPath, { force: true })
    publishState({
      stage: 'downloading',
      latestVersion,
      message: `正在下载${deliveryLabel} ${latestVersion}`,
      manual,
      deliveryType,
      downloadPercent: 0,
      downloadedBytes: 0,
      totalBytes: asset.size,
      releaseUrl,
      releaseNotes
    })
    const response = await fetchWithTimeout(asset.browser_download_url, DOWNLOAD_TIMEOUT_MS, {
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream' }
    })

    if (!response?.ok || !response.body) throw new Error(`${deliveryLabel}下载失败（HTTP ${response?.status || 0}）。`)
    const declaredLength = Number(headerValue(response.headers, 'content-length') || asset.size)

    if (declaredLength > maximumBytes || declaredLength <= 0) throw new Error(`${deliveryLabel}大小异常，已停止下载。`)
    const hash = crypto.createHash('sha256')
    const fileHandle = await fsModule.promises.open(partialPath, 'w')
    let downloadedBytes = 0
    let lastPercent = -1

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)

        downloadedBytes += buffer.length
        if (downloadedBytes > maximumBytes || downloadedBytes > asset.size) {
          throw new Error(`${deliveryLabel}实际大小超过发布记录，已停止下载。`)
        }
        hash.update(buffer)
        await fileHandle.write(buffer)
        const downloadPercent = Math.min(99, Math.floor((downloadedBytes / asset.size) * 100))

        if (downloadPercent !== lastPercent) {
          lastPercent = downloadPercent
          publishState({
            stage: 'downloading',
            message: `正在下载${deliveryLabel} ${latestVersion}（${downloadPercent}%）`,
            downloadPercent,
            downloadedBytes,
            totalBytes: asset.size
          })
        }
      }
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }

    if (downloadedBytes !== asset.size) throw new Error(`${deliveryLabel}下载不完整，请重新检查更新。`)
    if (hash.digest('hex') !== digest) throw new Error(`${deliveryLabel}校验失败，文件可能损坏。`)
    fsModule.rmSync(targetPath, { force: true })
    fsModule.renameSync(partialPath, targetPath)
    readyPath = targetPath
    readyDigest = digest
    readyDeliveryType = deliveryType
    logEvent('info', 'update.download.complete', { latestVersion, deliveryType, bytes: downloadedBytes })

    return publishState({
      stage: 'ready',
      latestVersion,
      message: `${deliveryLabel}已下载，可以重启更新到 ${latestVersion}`,
      manual,
      deliveryType,
      downloadPercent: 100,
      downloadedBytes,
      totalBytes: asset.size,
      releaseUrl,
      releaseNotes
    })
  }

  const runCheck = async ({ manual = false, autoDownload = true } = {}) => {
    if (!enabled) return publishState({ ...state, manual, stage: 'unsupported' })

    readyPath = ''
    readyDigest = ''
    readyDeliveryType = ''
    publishState({
      stage: 'checking',
      message: '正在检查新版本',
      manual,
      deliveryType: '',
      downloadPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0
    })
    logEvent('info', 'update.check.start', { manual })

    try {
      const response = await fetchWithTimeout(
        `https://api.github.com/repos/${repository}/releases/latest`,
        CHECK_TIMEOUT_MS
      )

      if (!response?.ok) {
        if (response?.status === 404) throw new Error('暂未找到公开发布版本，请稍后再试。')
        throw new Error(`检查更新失败（HTTP ${response?.status || 0}）。`)
      }
      const release = await response.json()
      const latestVersionParts = normalizeVersion(release?.tag_name)

      if (!latestVersionParts || release?.draft === true || release?.prerelease === true) {
        throw new Error('最新发布版本信息无效，请稍后再试。')
      }
      const latestVersion = latestVersionParts.join('.')
      const releaseUrl = String(release.html_url || '').slice(0, 500)
      const releaseNotes = String(release.body || '')
        .trim()
        .slice(0, 4000)

      if (compareVersionStrings(latestVersion, currentVersion) <= 0) {
        logEvent('info', 'update.check.complete', { manual, available: false, latestVersion })

        return publishState({
          stage: 'up-to-date',
          latestVersion,
          message: `当前已是最新版本 ${currentVersion}`,
          manual,
          deliveryType: '',
          releaseUrl,
          releaseNotes
        })
      }

      const assets = Array.isArray(release.assets) ? release.assets : []
      const installerName = expectedInstallerName(latestVersion)
      const installerAsset = assets.find(item => item?.name === installerName)
      const patchName = patchSupported ? expectedPatchName(currentVersion, latestVersion, runtimeId) : ''
      const previousPatchState = readJson(path.join(updatesRoot, PATCH_STATE_NAME), fsModule)
      const patchPreviouslyRolledBack =
        previousPatchState?.status === 'rolled-back' &&
        previousPatchState?.fromVersion === currentVersion &&
        previousPatchState?.toVersion === latestVersion
      const patchAsset = patchName && !patchPreviouslyRolledBack ? assets.find(item => item?.name === patchName) : null

      if (!installerAsset) throw new Error(`新版本 ${latestVersion} 尚未提供 Windows x64 安装包。`)
      const preferredAsset = patchAsset || installerAsset
      const preferredType = patchAsset ? 'patch' : 'installer'

      publishState({
        stage: 'available',
        latestVersion,
        message: patchAsset
          ? `发现新版本 ${latestVersion}，可使用轻量补丁`
          : `发现新版本 ${latestVersion}，将使用完整安装包`,
        manual,
        deliveryType: preferredType,
        releaseUrl,
        releaseNotes,
        totalBytes: Number(preferredAsset.size || 0)
      })
      logEvent('info', 'update.check.complete', {
        manual,
        available: true,
        latestVersion,
        deliveryType: preferredType
      })

      if (!autoDownload) return { ...state }
      if (patchAsset) {
        try {
          return await downloadRelease({
            asset: patchAsset,
            expectedName: patchName,
            deliveryType: 'patch',
            latestVersion,
            manual,
            releaseUrl,
            releaseNotes
          })
        } catch (error) {
          fsModule.rmSync(path.join(updatesRoot, `${patchName}.part`), { force: true })
          logError('update.patch.fallback', error, { currentVersion, latestVersion })
          publishState({
            stage: 'available',
            message: '轻量补丁不可用，正在改用完整安装包',
            deliveryType: 'installer',
            totalBytes: Number(installerAsset.size || 0)
          })
        }
      }

      return await downloadRelease({
        asset: installerAsset,
        expectedName: installerName,
        deliveryType: 'installer',
        latestVersion,
        manual,
        releaseUrl,
        releaseNotes
      })
    } catch (error) {
      if (fsModule.existsSync(updatesRoot)) {
        for (const entry of fsModule.readdirSync(updatesRoot)) {
          if (entry.endsWith('.part')) fsModule.rmSync(path.join(updatesRoot, entry), { force: true })
        }
      }
      logError('update.check.failed', error, { manual })

      return publishState({
        stage: 'error',
        message: error instanceof Error ? error.message : '检查更新失败，请稍后再试。',
        manual,
        deliveryType: '',
        downloadPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0
      })
    }
  }

  const check = checkOptions => {
    if (activeCheck) return activeCheck
    activeCheck = runCheck(checkOptions).finally(() => {
      activeCheck = null
    })

    return activeCheck
  }

  const waitForSpawn = child =>
    new Promise((resolve, reject) => {
      if (typeof child?.once !== 'function') {
        resolve()
        return
      }
      const timer = setTimeout(() => reject(new Error('启动更新程序超时，请重新检查更新。')), INSTALL_START_TIMEOUT_MS)
      const finish = callback => value => {
        clearTimeout(timer)
        child.removeListener?.('spawn', onSpawn)
        child.removeListener?.('error', onError)
        callback(value)
      }
      const onSpawn = finish(resolve)
      const onError = finish(reject)

      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

  const install = async () => {
    if (state.stage !== 'ready' || !readyPath || !fsModule.existsSync(readyPath)) {
      throw new Error('更新包尚未准备好，请先检查更新。')
    }
    if (!readyDigest || sha256File(readyPath, fsModule) !== readyDigest) {
      throw new Error('更新包再次校验失败，已拒绝安装。')
    }

    const deliveryLabel = readyDeliveryType === 'patch' ? '轻量补丁' : '完整安装包'

    publishState({ stage: 'installing', message: `正在退出程序并通过${deliveryLabel}更新到 ${state.latestVersion}` })

    try {
      let child

      if (readyDeliveryType === 'patch') {
        if (!patchSupported) throw new Error('当前安装结构不支持轻量补丁，请重新检查更新。')
        const helperPath = path.join(updatesRoot, PATCH_HELPER_NAME)
        const token = crypto.randomBytes(16).toString('hex')

        fsModule.writeFileSync(helperPath, fs.readFileSync(path.join(__dirname, 'patchInstaller.js')))
        child = spawnFn(
          currentExecutablePath,
          [
            helperPath,
            '--updates-root',
            updatesRoot,
            '--resources-root',
            currentResourcesPath,
            '--executable',
            currentExecutablePath,
            '--patch',
            readyPath,
            '--digest',
            readyDigest,
            '--parent-pid',
            String(currentProcessId),
            '--token',
            token,
            '--from',
            currentVersion,
            '--to',
            state.latestVersion
          ],
          {
            detached: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: 'ignore',
            windowsHide: true
          }
        )
      } else {
        child = spawnFn(readyPath, updateInstallerArguments(installDirectory), {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
      }

      await waitForSpawn(child)
      child.unref?.()
      logEvent('info', 'update.install.start', {
        latestVersion: state.latestVersion,
        deliveryType: readyDeliveryType,
        target: readyDeliveryType === 'patch' ? 'resources/app.asar' : 'current-executable-directory',
        restartAfterInstall: true
      })
      onBeforeInstall()

      return { ok: true, latestVersion: state.latestVersion, deliveryType: readyDeliveryType }
    } catch (error) {
      logError('update.install.failed', error, { latestVersion: state.latestVersion, deliveryType: readyDeliveryType })
      publishState({
        stage: 'error',
        message: error instanceof Error ? error.message : '无法启动更新程序，请重新检查更新。'
      })
      throw error
    }
  }

  return {
    check,
    enabled,
    getState: () => ({ ...state }),
    install
  }
}

module.exports = {
  CHECK_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  INSTALL_START_TIMEOUT_MS,
  MAX_PATCH_BYTES,
  MAX_UPDATE_BYTES,
  compareVersionStrings,
  createAppUpdater,
  expectedInstallerName,
  expectedPatchName,
  normalizeVersion,
  parseSha256Digest,
  releaseAssetUrlAllowed,
  repositoryFromPackageMetadata,
  resolveInstallDirectory,
  sha256File,
  updateInstallerArguments,
  validRuntimeId
}
