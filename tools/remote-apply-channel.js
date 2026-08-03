const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function main() {
  const [, , channelId, model, appRootArgument] = process.argv
  const appRoot = path.resolve(appRootArgument || process.env.CODEX_MM_APP_ROOT || '')

  if (!channelId || !model || !appRoot) {
    throw new Error('Usage: remote-apply-channel.js <channel-id> <model> <complete-app-folder>')
  }

  const executable = path.join(appRoot, 'ChatGPT Model Manager.exe')
  const managerModule = path.join(appRoot, 'resources', 'app.asar', 'electron', 'codexManager.js')

  if (!fs.existsSync(executable) || !fs.existsSync(managerModule)) {
    throw new Error('Complete app folder is missing the executable or resources/app.asar.')
  }

  const manager = require(managerModule)
  const guiEnvironment = { ...process.env }

  delete guiEnvironment.ELECTRON_RUN_AS_NODE
  spawn(executable, [], {
    detached: true,
    env: guiEnvironment,
    stdio: 'ignore',
    windowsHide: false
  }).unref()

  await wait(5000)

  const result = manager.applyRelay(channelId, model)

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.status.currentProvider === channelId && result.status.currentModel === model,
        currentProvider: result.status.currentProvider,
        currentModel: result.status.currentModel,
        restart: result.restart
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
