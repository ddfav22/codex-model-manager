const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function normalizeVersion(value) {
  const match = String(value || '').match(/^v?(\d+\.\d+\.\d+)$/u)

  return match ? match[1] : ''
}

function patchArtifactName(fromVersion, toVersion, runtimeId) {
  return `ChatGPT-Model-Manager-Patch-${fromVersion}-to-${toVersion}-${runtimeId}-x64.asar`
}

function buildUpdatePatch(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'))
  const releaseRoot = path.resolve(options.releaseRoot || path.join(projectRoot, 'release'))
  const currentMetadata = options.currentMetadata || require(path.join(projectRoot, 'package.json'))
  const previousMetadata = options.previousMetadata
  const fromVersion = normalizeVersion(options.fromVersion)
  const toVersion = normalizeVersion(currentMetadata.version)
  const runtimeId = String(currentMetadata.updateRuntimeId || '')

  if (!fromVersion || !toVersion) throw new Error('补丁起止版本号无效。')
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/u.test(runtimeId)) throw new Error('当前 updateRuntimeId 无效。')
  if (!previousMetadata || normalizeVersion(previousMetadata.version) !== fromVersion) {
    throw new Error('上一版本 package.json 与补丁起始版本不一致。')
  }
  if (previousMetadata.updateRuntimeId !== runtimeId) {
    return { created: false, reason: 'runtime-incompatible', fromVersion, toVersion, runtimeId }
  }

  const sourcePath = path.join(releaseRoot, 'win-unpacked', 'resources', 'app.asar')

  if (!fs.existsSync(sourcePath)) throw new Error(`缺少已打包 app.asar：${sourcePath}`)
  const targetPath = path.join(releaseRoot, patchArtifactName(fromVersion, toVersion, runtimeId))

  fs.copyFileSync(sourcePath, targetPath)
  const bytes = fs.statSync(targetPath).size
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex')

  if (bytes <= 0 || bytes > 64 * 1024 * 1024) {
    fs.rmSync(targetPath, { force: true })
    throw new Error('补丁产物大小异常。')
  }

  return { created: true, fromVersion, toVersion, runtimeId, targetPath, bytes, sha256 }
}

function previousMetadataFromGit(projectRoot, fromVersion) {
  const output = execFileSync('git', ['show', `v${fromVersion}:package.json`], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  })

  return JSON.parse(output)
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..')
  const fromIndex = process.argv.indexOf('--from')
  const fromVersion = normalizeVersion(fromIndex >= 0 ? process.argv[fromIndex + 1] : '')

  if (!fromVersion) throw new Error('用法：node tools/create-update-patch.js --from <上一版本>')
  const result = buildUpdatePatch({
    projectRoot,
    fromVersion,
    previousMetadata: previousMetadataFromGit(projectRoot, fromVersion)
  })

  console.log(JSON.stringify(result, null, 2))
}

module.exports = { buildUpdatePatch, normalizeVersion, patchArtifactName, previousMetadataFromGit }
