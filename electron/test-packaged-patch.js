const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const packageMetadata = require('../package.json')
const { PATCH_HELPER_NAME, PATCH_STATE_NAME, readJson } = require('./features/patchInstaller')

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function copyProgramTree(source, target) {
  fs.mkdirSync(target, { recursive: true })

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)

    if (entry.isDirectory()) copyProgramTree(sourcePath, targetPath)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
  }
}

function runtimeEvents(logPath) {
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

function stopProcessTree(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return

  try {
    execFileSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  } catch {
    // The process may have already exited after completing the health check.
  }
}

function main() {
  assert.strictEqual(process.platform, 'win32', '打包补丁冒烟测试仅支持 Windows')
  const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked'))
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-packaged-patch-'))
  const programRoot = path.join(tempRoot, 'program')
  const executablePath = path.join(programRoot, 'ChatGPT Model Manager.exe')
  const resourcesRoot = path.join(programRoot, 'resources')
  const updatesRoot = path.join(programRoot, 'data', 'updates')
  const targetPath = path.join(resourcesRoot, 'app.asar')
  const patchPath = path.join(updatesRoot, 'packaged-smoke-patch.asar')
  const helperPath = path.join(updatesRoot, PATCH_HELPER_NAME)
  const token = crypto.randomBytes(16).toString('hex')
  let launchedProcessId = 0

  try {
    assert.ok(fs.existsSync(path.join(sourceRoot, 'ChatGPT Model Manager.exe')), '缺少打包主程序')
    assert.ok(fs.existsSync(path.join(sourceRoot, 'resources', 'app.asar')), '缺少打包 app.asar')
    copyProgramTree(sourceRoot, programRoot)
    fs.mkdirSync(updatesRoot, { recursive: true })
    fs.copyFileSync(targetPath, patchPath)
    fs.copyFileSync(path.join(__dirname, 'features', 'patchInstaller.js'), helperPath)
    const expectedDigest = sha256(patchPath)
    const result = spawnSync(
      executablePath,
      [
        helperPath,
        '--updates-root',
        updatesRoot,
        '--resources-root',
        resourcesRoot,
        '--executable',
        executablePath,
        '--patch',
        patchPath,
        '--digest',
        expectedDigest,
        '--parent-pid',
        '2147483647',
        '--token',
        token,
        '--from',
        packageMetadata.version,
        '--to',
        packageMetadata.version
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CODEX_MM_DISABLE_UPDATE_CHECK: '1', ELECTRON_RUN_AS_NODE: '1' },
        timeout: 90_000,
        windowsHide: true
      }
    )

    assert.strictEqual(result.error, undefined, result.error?.message)
    assert.strictEqual(result.status, 0, `补丁辅助进程失败：${result.stderr || result.stdout}`)
    const state = readJson(path.join(updatesRoot, PATCH_STATE_NAME))

    assert.strictEqual(state?.status, 'healthy', '打包客户端没有确认补丁启动健康')
    assert.strictEqual(state?.token, token, '补丁健康令牌不匹配')
    assert.strictEqual(sha256(targetPath), expectedDigest, '打包客户端 app.asar 替换摘要不匹配')
    assert.strictEqual(fs.existsSync(patchPath), false, '健康启动后应清理已应用补丁')
    const events = runtimeEvents(path.join(programRoot, 'data', 'logs', 'manager.log'))
    const started = events.find(
      event => event.event === 'process.start' && event.details?.version === packageMetadata.version
    )
    const healthy = events.find(event => event.event === 'update.patch.healthy')

    launchedProcessId = Number(started?.pid || 0)
    assert.ok(Number.isInteger(launchedProcessId) && launchedProcessId > 0, '补丁后客户端缺少启动进程日志')
    assert.ok(healthy, '补丁后客户端缺少健康确认日志')
    console.log(
      JSON.stringify(
        {
          version: packageMetadata.version,
          helperExitCode: result.status,
          patchBytes: fs.statSync(targetPath).size,
          targetSha256: expectedDigest,
          state: state.status,
          startupLogged: true
        },
        null,
        2
      )
    )
  } finally {
    stopProcessTree(launchedProcessId)
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
}

main()
