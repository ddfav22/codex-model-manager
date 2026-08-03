const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const packageMetadata = require('../package.json')

const productExecutable = 'ChatGPT Model Manager.exe'
const updaterCacheDirectory = path.join(process.env.LOCALAPPDATA || '', `${packageMetadata.name}-updater`)

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
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

function main() {
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

main()
