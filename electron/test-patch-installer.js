const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  PATCH_STATE_NAME,
  completePendingPatch,
  readJson,
  runPatchInstaller,
  validatePatchOptions
} = require('./features/patchInstaller')

function fixture(root, suffix) {
  const installRoot = path.join(root, `installed-${suffix}`)
  const resourcesRoot = path.join(installRoot, 'resources')
  const updatesRoot = path.join(installRoot, 'data', 'updates')
  const executablePath = path.join(installRoot, 'ChatGPT Model Manager.exe')
  const patchPath = path.join(updatesRoot, `patch-${suffix}.asar`)
  const token = crypto.randomBytes(16).toString('hex')

  fs.mkdirSync(resourcesRoot, { recursive: true })
  fs.mkdirSync(updatesRoot, { recursive: true })
  fs.writeFileSync(executablePath, 'test executable')
  fs.writeFileSync(path.join(resourcesRoot, 'app.asar'), `old-${suffix}`)
  fs.writeFileSync(patchPath, `new-${suffix}`)

  return {
    updatesRoot,
    resourcesRoot,
    executablePath,
    patchPath,
    expectedDigest: crypto.createHash('sha256').update(`new-${suffix}`).digest('hex'),
    parentPid: 1234,
    token,
    fromVersion: '1.2.79',
    toVersion: '1.2.80'
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-patch-installer-'))
  const healthyFixture = fixture(tempRoot, 'healthy')
  const healthyLaunches = []
  const healthyResult = await runPatchInstaller(healthyFixture, {
    waitForParentExit: async () => true,
    launchApplication: (file, args) => {
      healthyLaunches.push({ file, args })

      return { exitCode: 0 }
    },
    waitForHealthyState: async (statePath, token) => {
      assert.strictEqual(statePath, path.join(healthyFixture.updatesRoot, PATCH_STATE_NAME))
      assert.strictEqual(completePendingPatch({ updatesRoot: healthyFixture.updatesRoot, token }).completed, true)

      return true
    }
  })

  assert.deepStrictEqual(healthyResult, { ok: true, rolledBack: false })
  assert.strictEqual(fs.readFileSync(path.join(healthyFixture.resourcesRoot, 'app.asar'), 'utf8'), 'new-healthy')
  assert.strictEqual(fs.existsSync(healthyFixture.patchPath), false)
  assert.strictEqual(healthyLaunches.length, 1)
  assert.deepStrictEqual(healthyLaunches[0].args, [`--patch-health-token=${healthyFixture.token}`])
  assert.strictEqual(readJson(path.join(healthyFixture.updatesRoot, PATCH_STATE_NAME)).status, 'healthy')

  const rollbackFixture = fixture(tempRoot, 'rollback')
  const rollbackLaunches = []
  let killed = 0
  const rollbackResult = await runPatchInstaller(rollbackFixture, {
    waitForParentExit: async () => true,
    launchApplication: (file, args) => {
      rollbackLaunches.push({ file, args })

      return { exitCode: 0, kill: () => (killed += 1) }
    },
    waitForHealthyState: async () => false
  })

  assert.deepStrictEqual(rollbackResult, { ok: false, rolledBack: true })
  assert.strictEqual(fs.readFileSync(path.join(rollbackFixture.resourcesRoot, 'app.asar'), 'utf8'), 'old-rollback')
  assert.strictEqual(rollbackLaunches.length, 2)
  assert.strictEqual(killed, 1)
  assert.deepStrictEqual(rollbackLaunches[1].args, ['--patch-rollback=1.2.80'])
  assert.strictEqual(readJson(path.join(rollbackFixture.updatesRoot, PATCH_STATE_NAME)).status, 'rolled-back')

  assert.throws(
    () => validatePatchOptions({ ...healthyFixture, patchPath: path.join(tempRoot, 'outside.asar') }),
    /受控更新目录/
  )
  assert.deepStrictEqual(completePendingPatch({ updatesRoot: rollbackFixture.updatesRoot, token: '0'.repeat(32) }), {
    completed: false,
    reason: 'state-mismatch'
  })

  fs.rmSync(tempRoot, { recursive: true, force: true })
  console.log('轻量补丁安装器测试通过（路径约束、双重校验、健康确认与失败回滚）。')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
