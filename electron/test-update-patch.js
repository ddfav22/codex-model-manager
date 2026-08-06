const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildUpdatePatch, normalizeVersion, patchArtifactName } = require('../tools/create-update-patch')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-update-patch-'))
const releaseRoot = path.join(tempRoot, 'release')
const sourceRoot = path.join(releaseRoot, 'win-unpacked', 'resources')
const runtimeId = 'electron-33-win-x64-v1'

fs.mkdirSync(sourceRoot, { recursive: true })
fs.writeFileSync(path.join(sourceRoot, 'app.asar'), 'new packaged application')

assert.strictEqual(normalizeVersion('v1.2.79'), '1.2.79')
assert.strictEqual(normalizeVersion('1.2'), '')
assert.strictEqual(
  patchArtifactName('1.2.79', '1.2.80', runtimeId),
  `ChatGPT-Model-Manager-Patch-1.2.79-to-1.2.80-${runtimeId}-x64.asar`
)

const result = buildUpdatePatch({
  projectRoot: tempRoot,
  releaseRoot,
  fromVersion: '1.2.79',
  currentMetadata: { version: '1.2.80', updateRuntimeId: runtimeId },
  previousMetadata: { version: '1.2.79', updateRuntimeId: runtimeId }
})

assert.strictEqual(result.created, true)
assert.strictEqual(fs.readFileSync(result.targetPath, 'utf8'), 'new packaged application')
assert.match(result.sha256, /^[a-f0-9]{64}$/u)

const skipped = buildUpdatePatch({
  projectRoot: tempRoot,
  releaseRoot,
  fromVersion: '1.2.78',
  currentMetadata: { version: '1.2.79', updateRuntimeId: runtimeId },
  previousMetadata: { version: '1.2.78' }
})

assert.deepStrictEqual(skipped, {
  created: false,
  reason: 'runtime-incompatible',
  fromVersion: '1.2.78',
  toVersion: '1.2.79',
  runtimeId
})
assert.throws(
  () =>
    buildUpdatePatch({
      projectRoot: tempRoot,
      releaseRoot,
      fromVersion: '1.2',
      currentMetadata: { version: '1.2.80', updateRuntimeId: runtimeId },
      previousMetadata: { version: '1.2.79', updateRuntimeId: runtimeId }
    }),
  /版本号无效/
)

fs.rmSync(tempRoot, { recursive: true, force: true })
console.log('更新补丁产物测试通过（兼容生成、运行时不兼容跳过与输入拒绝）。')
