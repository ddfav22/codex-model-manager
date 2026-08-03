const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const [, , appRootArgument] = process.argv
  const appRoot = path.resolve(appRootArgument || process.env.CODEX_MM_APP_ROOT || '')
  const managerModule = path.join(appRoot, 'resources', 'app.asar', 'electron', 'codexManager.js')

  if (!appRoot || !fs.existsSync(managerModule)) {
    throw new Error('Usage: remote-verify-activation.js <complete-app-folder>')
  }

  const manager = require(managerModule)
  const status = manager.readStatus()
  const runtime = await manager.inspectLocalToolRuntime()

  process.stdout.write(
    `${JSON.stringify(
      {
        currentProvider: status.currentProvider,
        currentModel: status.currentModel,
        providerActive: status.providers.some(provider => provider.id === status.currentProvider && provider.active),
        localRuntime: {
          healthy: runtime.healthy,
          readiness: runtime.readiness,
          powershellOk: runtime.powershellOk,
          shellTestOk: runtime.shellTestOk,
          localDoctorStatus: runtime.localDoctorStatus,
          providerDoctorStatus: runtime.providerDoctorStatus,
          localErrorIds: runtime.doctorLocalErrors.map(item => item.id),
          providerIssueIds: runtime.doctorProviderIssues.map(item => item.id),
          message: runtime.message
        }
      },
      null,
      2
    )}\n`
  )
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
