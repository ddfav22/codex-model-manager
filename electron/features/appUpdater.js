const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const MAX_UPDATE_BYTES = 512 * 1024 * 1024
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
  const repository = String(options.repository || '').trim()
  const updatesRoot = path.resolve(options.updatesRoot || path.join(process.cwd(), 'data', 'updates'))
  const fetchFn = options.fetchFn || globalThis.fetch
  const fsModule = options.fsModule || fs
  const spawnFn = options.spawnFn || spawn
  const emitState = typeof options.onState === 'function' ? options.onState : () => {}
  const logEvent = typeof options.logEvent === 'function' ? options.logEvent : () => {}
  const logError = typeof options.logError === 'function' ? options.logError : () => {}
  const onBeforeInstall = typeof options.onBeforeInstall === 'function' ? options.onBeforeInstall : () => {}
  const enabled = options.enabled !== false && Boolean(repository) && typeof fetchFn === 'function'
  let activeCheck = null
  let readyInstallerPath = ''
  let readyDigest = ''
  let state = {
    stage: enabled ? 'idle' : 'unsupported',
    currentVersion,
    latestVersion: '',
    message: enabled ? '尚未检查更新' : '当前版本暂未配置在线更新源',
    manual: false,
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

  const downloadRelease = async ({ asset, latestVersion, manual, releaseUrl, releaseNotes }) => {
    const digest = parseSha256Digest(asset.digest)
    const installerName = expectedInstallerName(latestVersion)

    if (asset.name !== installerName) throw new Error('更新包名称不符合安全规则。')
    if (!digest) throw new Error('更新包缺少 SHA-256 校验信息，已拒绝下载。')
    if (!releaseAssetUrlAllowed(asset.browser_download_url, repository)) {
      throw new Error('更新包下载地址不是受信任的 GitHub Release。')
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0 || asset.size > MAX_UPDATE_BYTES) {
      throw new Error('更新包大小异常，已拒绝下载。')
    }

    fsModule.mkdirSync(updatesRoot, { recursive: true })
    const installerPath = path.join(updatesRoot, installerName)
    const partialPath = `${installerPath}.part`

    if (fsModule.existsSync(installerPath) && sha256File(installerPath, fsModule) === digest) {
      readyInstallerPath = installerPath
      readyDigest = digest

      return publishState({
        stage: 'ready',
        latestVersion,
        message: `新版本 ${latestVersion} 已下载，可以重启更新`,
        manual,
        downloadPercent: 100,
        downloadedBytes: asset.size,
        totalBytes: asset.size,
        releaseUrl,
        releaseNotes
      })
    }

    if (fsModule.existsSync(partialPath)) fsModule.rmSync(partialPath, { force: true })
    publishState({
      stage: 'downloading',
      latestVersion,
      message: `正在下载新版本 ${latestVersion}`,
      manual,
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

    if (!response?.ok || !response.body) throw new Error(`更新包下载失败（HTTP ${response?.status || 0}）。`)

    const declaredLength = Number(headerValue(response.headers, 'content-length') || asset.size)

    if (declaredLength > MAX_UPDATE_BYTES || declaredLength <= 0) throw new Error('更新包大小异常，已停止下载。')

    const hash = crypto.createHash('sha256')
    const fileHandle = await fsModule.promises.open(partialPath, 'w')
    let downloadedBytes = 0
    let lastPercent = -1

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)

        downloadedBytes += buffer.length
        if (downloadedBytes > MAX_UPDATE_BYTES || downloadedBytes > asset.size) {
          throw new Error('更新包实际大小超过发布记录，已停止下载。')
        }
        hash.update(buffer)
        await fileHandle.write(buffer)
        const downloadPercent = Math.min(99, Math.floor((downloadedBytes / asset.size) * 100))

        if (downloadPercent !== lastPercent) {
          lastPercent = downloadPercent
          publishState({
            stage: 'downloading',
            message: `正在下载新版本 ${latestVersion}（${downloadPercent}%）`,
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

    if (downloadedBytes !== asset.size) throw new Error('更新包下载不完整，请重新检查更新。')
    if (hash.digest('hex') !== digest) throw new Error('更新包校验失败，文件可能损坏，已拒绝安装。')

    if (fsModule.existsSync(installerPath)) fsModule.rmSync(installerPath, { force: true })
    fsModule.renameSync(partialPath, installerPath)
    readyInstallerPath = installerPath
    readyDigest = digest
    logEvent('info', 'update.download.complete', { latestVersion, bytes: downloadedBytes })

    return publishState({
      stage: 'ready',
      latestVersion,
      message: `新版本 ${latestVersion} 已下载，可以重启更新`,
      manual,
      downloadPercent: 100,
      downloadedBytes,
      totalBytes: asset.size,
      releaseUrl,
      releaseNotes
    })
  }

  const runCheck = async ({ manual = false, autoDownload = true } = {}) => {
    if (!enabled) return publishState({ ...state, manual, stage: 'unsupported' })

    publishState({
      stage: 'checking',
      message: '正在检查新版本',
      manual,
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
          releaseUrl,
          releaseNotes
        })
      }

      const installerName = expectedInstallerName(latestVersion)
      const asset = Array.isArray(release.assets) ? release.assets.find(item => item?.name === installerName) : null

      if (!asset) throw new Error(`新版本 ${latestVersion} 尚未提供 Windows x64 安装包。`)

      publishState({
        stage: 'available',
        latestVersion,
        message: `发现新版本 ${latestVersion}`,
        manual,
        releaseUrl,
        releaseNotes,
        totalBytes: Number(asset.size || 0)
      })
      logEvent('info', 'update.check.complete', { manual, available: true, latestVersion })

      return autoDownload
        ? await downloadRelease({ asset, latestVersion, manual, releaseUrl, releaseNotes })
        : { ...state }
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
        downloadPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0
      })
    }
  }

  const check = options => {
    if (activeCheck) return activeCheck

    activeCheck = runCheck(options).finally(() => {
      activeCheck = null
    })

    return activeCheck
  }

  const install = async () => {
    if (state.stage !== 'ready' || !readyInstallerPath || !fsModule.existsSync(readyInstallerPath)) {
      throw new Error('更新包尚未准备好，请先检查更新。')
    }
    if (!readyDigest || sha256File(readyInstallerPath, fsModule) !== readyDigest) {
      throw new Error('更新包再次校验失败，已拒绝安装。')
    }

    publishState({ stage: 'installing', message: `正在安装新版本 ${state.latestVersion}` })

    try {
      const child = spawnFn(readyInstallerPath, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })

      await new Promise((resolve, reject) => {
        if (typeof child?.once !== 'function') {
          resolve()
          return
        }

        const timer = setTimeout(
          () => reject(new Error('启动更新程序超时，请重新检查更新。')),
          INSTALL_START_TIMEOUT_MS
        )
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
      child.unref?.()
      logEvent('info', 'update.install.start', { latestVersion: state.latestVersion })
      onBeforeInstall()

      return { ok: true, latestVersion: state.latestVersion }
    } catch (error) {
      logError('update.install.failed', error, { latestVersion: state.latestVersion })
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
  MAX_UPDATE_BYTES,
  compareVersionStrings,
  createAppUpdater,
  expectedInstallerName,
  normalizeVersion,
  parseSha256Digest,
  releaseAssetUrlAllowed,
  repositoryFromPackageMetadata,
  sha256File
}
