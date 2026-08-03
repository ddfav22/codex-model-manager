const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const packageMetadata = require('../package.json')
const { createAppUpdater } = require('./features/appUpdater')

const productExecutable = 'ChatGPT Model Manager.exe'
const updaterCacheDirectory = path.join(process.env.LOCALAPPDATA || '', `${packageMetadata.name}-updater`)

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function canonicalExistingPath(targetPath) {
  return path.normalize(fs.realpathSync.native(targetPath)).toLowerCase()
}

function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) return true
    sleep(500)
  }

  return predicate()
}

function run(executablePath, args, options = {}) {
  execFileSync(executablePath, args, {
    timeout: 240000,
    windowsHide: true,
    stdio: 'inherit',
    ...options
  })
}

function findUninstaller(installDirectory) {
  const filename = fs.readdirSync(installDirectory).find(entry => /^Uninstall .+\.exe$/i.test(entry))

  assert.ok(filename, '安装目录中缺少卸载程序')

  return path.join(installDirectory, filename)
}

function assertUpdaterCacheRemoved() {
  if (!fs.existsSync(updaterCacheDirectory)) return

  assert.deepStrictEqual(fs.readdirSync(updaterCacheDirectory), [], '安装器不应在 AppData 中遗留更新缓存')
}

function install(installerPath, installDirectory) {
  run(installerPath, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${installDirectory}`])
  assert.ok(fs.existsSync(path.join(installDirectory, productExecutable)), '安装后缺少主程序')
  assertUpdaterCacheRemoved()
}

function assertFreshInstallIsClean(installDirectory) {
  assert.strictEqual(
    fs.existsSync(path.join(installDirectory, 'data')),
    false,
    '首次安装在启动前不得包含 data、登录态或渠道配置'
  )
}

function installAtDefaultLocation(installerPath, setupDirectory) {
  const copiedInstallerPath = path.join(setupDirectory, path.basename(installerPath))
  const defaultInstallDirectory = path.join(setupDirectory, 'ChatGPT Model Manager')

  fs.mkdirSync(setupDirectory, { recursive: true })
  fs.copyFileSync(installerPath, copiedInstallerPath)
  run(copiedInstallerPath, ['/S', '/currentuser', '--no-desktop-shortcut'])
  assert.ok(
    fs.existsSync(path.join(defaultInstallDirectory, productExecutable)),
    '首次安装的默认目录必须位于安装包旁边'
  )
  assertFreshInstallIsClean(defaultInstallDirectory)
  assertUpdaterCacheRemoved()
  sleep(5000)

  return defaultInstallDirectory
}

function uninstall(installDirectory) {
  run(findUninstaller(installDirectory), ['/S', '/currentuser'])
  assert.ok(
    waitFor(() => !fs.existsSync(path.join(installDirectory, productExecutable))),
    '卸载后仍残留主程序'
  )
  assertUpdaterCacheRemoved()
}

function packagedUiSmoke(installDirectory, port) {
  run(process.execPath, [path.join(__dirname, 'test-packaged-ui.js'), path.join(installDirectory, productExecutable)], {
    env: {
      ...process.env,
      CODEX_MM_UI_TEST_PORT: String(port)
    }
  })
}

function previousPatchVersion(version) {
  const parts = String(version).split('.').map(Number)

  assert.strictEqual(parts.length, 3, '测试版本号格式无效')
  assert.ok(parts[2] > 0, '测试版本必须有可递减的修订号')

  return `${parts[0]}.${parts[1]}.${parts[2] - 1}`
}

function readLogEvents(logPath) {
  if (!fs.existsSync(logPath)) return []

  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function stopProcessTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {
    // The process may have exited after logging startup; that is already safe.
  }
}

async function selfUpdate(installerPath, installDirectory, markerPath) {
  const installedExecutable = path.join(installDirectory, productExecutable)
  const updatesRoot = path.join(installDirectory, 'data', 'updates')
  const cachedInstaller = path.join(updatesRoot, path.basename(installerPath))
  const obsoleteProgramFile = path.join(installDirectory, 'obsolete-program-file.txt')
  const logPath = path.join(installDirectory, 'data', 'logs', 'manager.log')
  const installerBytes = fs.statSync(installerPath).size
  const installerDigest = crypto.createHash('sha256').update(fs.readFileSync(installerPath)).digest('hex')
  const startedAt = Date.now()
  let beforeInstallCalls = 0

  fs.mkdirSync(updatesRoot, { recursive: true })
  fs.copyFileSync(installerPath, cachedInstaller)
  fs.writeFileSync(obsoleteProgramFile, 'must be removed by the in-place update', 'utf8')
  process.env.CODEX_MM_DISABLE_UPDATE_CHECK = '1'

  const updater = createAppUpdater({
    currentVersion: previousPatchVersion(packageMetadata.version),
    currentExecutablePath: installedExecutable,
    repository: 'ddfav22/codex-model-manager',
    updatesRoot,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          tag_name: `v${packageMetadata.version}`,
          draft: false,
          prerelease: false,
          html_url: `https://github.com/ddfav22/codex-model-manager/releases/tag/v${packageMetadata.version}`,
          body: 'installer self-update regression',
          assets: [
            {
              name: path.basename(installerPath),
              browser_download_url: `https://github.com/ddfav22/codex-model-manager/releases/download/v${packageMetadata.version}/${path.basename(installerPath)}`,
              size: installerBytes,
              digest: `sha256:${installerDigest}`
            }
          ]
        }
      }
    }),
    spawnFn: spawn,
    onBeforeInstall: () => {
      beforeInstallCalls += 1
    }
  })
  const ready = await updater.check({ manual: true, autoDownload: true })

  assert.strictEqual(ready.stage, 'ready', '本地更新包应进入可安装状态')
  assert.deepStrictEqual(await updater.install(), { ok: true, latestVersion: packageMetadata.version })
  assert.strictEqual(beforeInstallCalls, 1, '启动安装器后必须触发主程序退出回调')
  assert.ok(
    waitFor(() => !fs.existsSync(obsoleteProgramFile), 120000),
    '自更新没有覆盖当前程序目录，旧程序文件仍然存在'
  )
  assert.ok(fs.existsSync(markerPath), '自更新必须保留 data 用户数据')
  assert.ok(
    waitFor(
      () =>
        readLogEvents(logPath).some(
          event =>
            event.event === 'process.start' &&
            event.details?.version === packageMetadata.version &&
            Date.parse(event.timestamp) >= startedAt
        ),
      120000
    ),
    '自更新完成后没有启动新版本程序'
  )

  const restarted = readLogEvents(logPath)
    .filter(
      event =>
        event.event === 'process.start' &&
        event.details?.version === packageMetadata.version &&
        Date.parse(event.timestamp) >= startedAt
    )
    .at(-1)

  assert.ok(Number.isInteger(restarted?.pid), '更新后启动日志缺少进程 ID')
  assert.strictEqual(
    canonicalExistingPath(restarted.details.executable),
    canonicalExistingPath(installedExecutable),
    '更新后必须从原安装目录启动；Windows 8.3 短路径和完整路径视为同一路径'
  )
  stopProcessTree(restarted.pid)
  sleep(2000)
}

async function main() {
  assert.strictEqual(process.platform, 'win32', '安装器回归测试仅支持 Windows')

  const installerPath = path.resolve(
    process.argv[2] ||
      path.join(__dirname, '..', 'release', `ChatGPT-Model-Manager-Setup-${packageMetadata.version}-x64.exe`)
  )
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-installer-'))
  const installDirectory = path.join(testRoot, 'ChatGPT Model Manager')
  const markerPath = path.join(installDirectory, 'data', 'manager', 'installer-preserve-test.json')

  assert.ok(fs.existsSync(installerPath), `安装包不存在：${installerPath}`)

  let testFailure = null

  try {
    install(installerPath, installDirectory)
    assertFreshInstallIsClean(installDirectory)
    packagedUiSmoke(installDirectory, 9351)

    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, JSON.stringify({ version: packageMetadata.version }), 'utf8')
    uninstall(installDirectory)
    assert.ok(fs.existsSync(markerPath), '卸载必须保留客户端 data')

    install(installerPath, installDirectory)
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(markerPath, 'utf8')),
      { version: packageMetadata.version },
      '重装必须保留原有客户端 data'
    )
    await selfUpdate(installerPath, installDirectory, markerPath)
    packagedUiSmoke(installDirectory, 9352)

    uninstall(installDirectory)
    assert.ok(fs.existsSync(markerPath), '最终卸载必须保留客户端 data')
    const defaultInstallDirectory = installAtDefaultLocation(installerPath, path.join(testRoot, 'setup'))
    const defaultMarkerPath = path.join(defaultInstallDirectory, 'data', 'default-location-test.json')

    fs.mkdirSync(path.dirname(defaultMarkerPath), { recursive: true })
    fs.writeFileSync(defaultMarkerPath, JSON.stringify({ version: packageMetadata.version }), 'utf8')
    uninstall(defaultInstallDirectory)
    assert.ok(fs.existsSync(defaultMarkerPath), '默认目录卸载后必须保留客户端 data')
    console.log(`installer regression tests passed: ${installerPath}`)
  } catch (error) {
    testFailure = error
  } finally {
    if (fs.existsSync(path.join(installDirectory, productExecutable))) {
      try {
        uninstall(installDirectory)
      } catch (error) {
        testFailure ||= error
      }
    }

    sleep(10000)

    try {
      fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
    } catch (error) {
      testFailure ||= error
    }
  }

  if (testFailure) throw testFailure
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
