const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { EventEmitter } = require('events')
const packageMetadata = require('../package.json')

const {
  compareVersionStrings,
  createAppUpdater,
  normalizeVersion,
  releaseAssetUrlAllowed,
  repositoryFromPackageMetadata,
  resolveInstallDirectory,
  updateInstallerArguments
} = require('./features/appUpdater')

const repository = 'example/codex-model-manager'
const productionRepository = 'ddfav22/codex-model-manager'

function mockResponse({ status = 200, json, body, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || ''
      }
    },
    body,
    async json() {
      return json
    }
  }
}

async function main() {
  assert.deepStrictEqual(normalizeVersion('v1.2.53'), [1, 2, 53])
  assert.strictEqual(normalizeVersion('1.2'), null)
  assert.ok(compareVersionStrings('1.2.53', '1.2.52') > 0)
  assert.strictEqual(compareVersionStrings('1.2.52', 'v1.2.52'), 0)
  assert.strictEqual(
    repositoryFromPackageMetadata({ repository: { url: 'https://github.com/example/codex-model-manager.git' } }),
    repository
  )
  assert.strictEqual(repositoryFromPackageMetadata(packageMetadata), productionRepository)
  const packageVersionParts = String(packageMetadata.version).split('.').map(Number)

  assert.strictEqual(packageVersionParts.length, 3)
  assert.ok(packageVersionParts.every(Number.isInteger))
  assert.deepStrictEqual(normalizeVersion(packageMetadata.version), packageVersionParts)
  const installedExecutable = path.join('C:\\', 'portable app', 'ChatGPT Model Manager.exe')
  const installDirectory = path.dirname(installedExecutable)

  assert.strictEqual(resolveInstallDirectory(installedExecutable), installDirectory)
  assert.deepStrictEqual(updateInstallerArguments(installDirectory), [
    '/S',
    '/currentuser',
    '--updated',
    '--force-run',
    '--keep-shortcuts',
    `/D=${installDirectory}`
  ])
  assert.throws(() => resolveInstallDirectory('C:\\app.exe'), /无法确定当前程序目录/)
  assert.throws(() => updateInstallerArguments('C:\\'), /安装目录无效/)
  assert.strictEqual(
    releaseAssetUrlAllowed(
      'https://github.com/example/codex-model-manager/releases/download/v1.2.53/update.exe',
      repository
    ),
    true
  )
  assert.strictEqual(releaseAssetUrlAllowed('https://example.com/update.exe', repository), false)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-updater-'))
  const updateBytes = Buffer.from('verified Windows installer fixture')
  const updateDigest = crypto.createHash('sha256').update(updateBytes).digest('hex')
  const installerName = 'ChatGPT-Model-Manager-Setup-1.2.53-x64.exe'
  const installerUrl = `https://github.com/${repository}/releases/download/v1.2.53/${installerName}`
  const states = []
  const spawnCalls = []
  let beforeInstallCalls = 0
  const updater = createAppUpdater({
    currentVersion: '1.2.52',
    currentExecutablePath: path.join(tempRoot, 'installed', 'ChatGPT Model Manager.exe'),
    repository,
    updatesRoot: tempRoot,
    onState: state => states.push(state),
    fetchFn: async url => {
      if (url.includes('/releases/latest')) {
        return mockResponse({
          json: {
            tag_name: 'v1.2.53',
            draft: false,
            prerelease: false,
            html_url: `https://github.com/${repository}/releases/tag/v1.2.53`,
            body: '更新说明',
            assets: [
              {
                name: installerName,
                browser_download_url: installerUrl,
                size: updateBytes.length,
                digest: `sha256:${updateDigest}`
              }
            ]
          }
        })
      }
      if (url === installerUrl) {
        return mockResponse({
          body: Readable.from([updateBytes.subarray(0, 8), updateBytes.subarray(8)]),
          headers: { 'content-length': String(updateBytes.length) }
        })
      }

      throw new Error(`unexpected URL: ${url}`)
    },
    spawnFn: (file, args, options) => {
      const call = { file, args, options, unrefCalled: false }
      const child = new EventEmitter()

      spawnCalls.push(call)
      child.unref = () => {
        call.unrefCalled = true
      }
      setImmediate(() => child.emit('spawn'))
      return child
    },
    onBeforeInstall: () => {
      beforeInstallCalls += 1
    }
  })

  const ready = await updater.check({ manual: false, autoDownload: true })

  assert.strictEqual(ready.stage, 'ready')
  assert.strictEqual(ready.latestVersion, '1.2.53')
  assert.strictEqual(ready.downloadPercent, 100)
  assert.deepStrictEqual(
    [...new Set(states.map(state => state.stage))],
    ['checking', 'available', 'downloading', 'ready']
  )
  assert.ok(states.filter(state => state.stage === 'downloading').every(state => state.downloadPercent < 100))
  assert.strictEqual(fs.readFileSync(path.join(tempRoot, installerName), 'utf8'), updateBytes.toString('utf8'))
  assert.strictEqual(fs.existsSync(path.join(tempRoot, `${installerName}.part`)), false)

  const installResult = await updater.install()

  assert.deepStrictEqual(installResult, { ok: true, latestVersion: '1.2.53' })
  assert.strictEqual(spawnCalls.length, 1)
  assert.strictEqual(spawnCalls[0].file, path.join(tempRoot, installerName))
  assert.deepStrictEqual(spawnCalls[0].args, [
    '/S',
    '/currentuser',
    '--updated',
    '--force-run',
    '--keep-shortcuts',
    `/D=${path.join(tempRoot, 'installed')}`
  ])
  assert.strictEqual(spawnCalls[0].options.detached, true)
  assert.strictEqual(spawnCalls[0].unrefCalled, true)
  assert.strictEqual(beforeInstallCalls, 1)

  const currentUpdater = createAppUpdater({
    currentVersion: '1.2.53',
    repository,
    updatesRoot: path.join(tempRoot, 'current'),
    fetchFn: async () =>
      mockResponse({
        json: { tag_name: 'v1.2.53', draft: false, prerelease: false, assets: [] }
      })
  })

  assert.strictEqual((await currentUpdater.check({ manual: true })).stage, 'up-to-date')

  const badRoot = path.join(tempRoot, 'bad')
  const badUpdater = createAppUpdater({
    currentVersion: '1.2.52',
    repository,
    updatesRoot: badRoot,
    fetchFn: async url =>
      url.includes('/releases/latest')
        ? mockResponse({
            json: {
              tag_name: 'v1.2.53',
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: installerName,
                  browser_download_url: installerUrl,
                  size: updateBytes.length,
                  digest: `sha256:${'0'.repeat(64)}`
                }
              ]
            }
          })
        : mockResponse({
            body: Readable.from([updateBytes]),
            headers: { 'content-length': String(updateBytes.length) }
          })
  })
  const badResult = await badUpdater.check({ manual: true })

  assert.strictEqual(badResult.stage, 'error')
  assert.match(badResult.message, /校验失败/)
  assert.strictEqual(fs.existsSync(path.join(badRoot, `${installerName}.part`)), false)
  await assert.rejects(badUpdater.install(), /尚未准备好/)

  const failedInstallRoot = path.join(tempRoot, 'failed-install')
  const failedInstallUpdater = createAppUpdater({
    currentVersion: '1.2.52',
    repository,
    updatesRoot: failedInstallRoot,
    fetchFn: async url =>
      url.includes('/releases/latest')
        ? mockResponse({
            json: {
              tag_name: 'v1.2.53',
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: installerName,
                  browser_download_url: installerUrl,
                  size: updateBytes.length,
                  digest: `sha256:${updateDigest}`
                }
              ]
            }
          })
        : mockResponse({
            body: Readable.from([updateBytes]),
            headers: { 'content-length': String(updateBytes.length) }
          }),
    spawnFn: () => {
      const child = new EventEmitter()

      setImmediate(() => child.emit('error', new Error('installer launch denied')))
      return child
    }
  })

  assert.strictEqual((await failedInstallUpdater.check({ manual: true })).stage, 'ready')
  await assert.rejects(failedInstallUpdater.install(), /installer launch denied/)
  assert.strictEqual(failedInstallUpdater.getState().stage, 'error')

  const disabledUpdater = createAppUpdater({ currentVersion: '1.2.52', repository: '', updatesRoot: tempRoot })

  assert.strictEqual(disabledUpdater.enabled, false)
  assert.strictEqual((await disabledUpdater.check({ manual: true })).stage, 'unsupported')

  fs.rmSync(tempRoot, { recursive: true, force: true })
  console.log('在线更新模块测试通过（版本、下载、SHA-256、安装、失败清理与禁用路径）。')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
