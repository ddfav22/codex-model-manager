const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const manager = require('./codexManager')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mm-rename-'))
  const projectPath = path.join(root, 'project')
  const sessionPath = path.join(root, 'sessions', '2026', '09', '07', 'rename.jsonl')
  const options = {
    codexHome: root,
    configPath: path.join(root, 'config.toml'),
    stateDir: path.join(root, 'manager-state'),
    skipEnvWrite: true,
    stopClientsOnBusy: false,
    runAppServerRequest: async (_codexPath, method) => {
      assert.strictEqual(method, 'thread/list')
      return { result: { data: [] } }
    }
  }

  fs.mkdirSync(projectPath, { recursive: true })
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'rename-id', thread_name: '旧名称', cwd: projectPath } }),
      JSON.stringify({ type: 'event', payload: { value: 'keep' } })
    ].join('\n') + '\n',
    'utf8'
  )

  const result = await manager.renameSession(sessionPath, '新名称', options)
  assert.strictEqual(result.title, '新名称')
  assert.strictEqual(result.indexRefresh.ok, true)
  assert.ok(result.backupPath)
  const rows = fs
    .readFileSync(sessionPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line))
  assert.strictEqual(rows[0].payload.thread_name, '新名称')
  assert.deepStrictEqual(rows[1].payload, { value: 'keep' })
  assert.strictEqual(fs.existsSync(result.backupPath), true)

  await assert.rejects(() => manager.renameSession(sessionPath, '   ', options), /名称不能为空/)
  console.log('session rename persistence and index refresh tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
