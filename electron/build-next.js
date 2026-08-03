const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const generatedDirectories = ['.next', 'out']

for (const directoryName of generatedDirectories) {
  const targetPath = path.resolve(projectRoot, directoryName)
  if (path.dirname(targetPath) !== projectRoot) {
    throw new Error(`Refusing to clean an unsafe build path: ${targetPath}`)
  }
  fs.rmSync(targetPath, { recursive: true, force: true })
}

const nextBin = require.resolve('next/dist/bin/next')
const result = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_IGNORE_INCORRECT_LOCKFILE: '1'
  }
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
