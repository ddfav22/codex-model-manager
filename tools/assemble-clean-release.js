const fs = require('fs')
const path = require('path')
const packageMetadata = require('../package.json')

const projectRoot = path.resolve(__dirname, '..')
const releaseRoot = path.join(projectRoot, 'release')
const sourceRoot = path.join(releaseRoot, 'win-unpacked')
const targetRoot = path.join(releaseRoot, `ChatGPT-Model-Manager-${packageMetadata.version}-complete`)
const documentationFiles = ['README.md', 'CHANGELOG.md', 'SECURITY.md', path.join('docs', 'HANDOFF.md')]

function assertCleanReleaseTarget(targetPath) {
  const expectedName = `ChatGPT-Model-Manager-${packageMetadata.version}-complete`
  const relative = path.relative(releaseRoot, targetPath)

  if (relative !== expectedName || path.dirname(path.resolve(targetPath)) !== path.resolve(releaseRoot)) {
    throw new Error(`拒绝清理非当前版本发布目录：${targetPath}`)
  }
}

function copyProgramTree(source, target, relative = '') {
  fs.mkdirSync(target, { recursive: true })

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const entryRelative = relative ? path.join(relative, entry.name) : entry.name

    if (entryRelative.split(path.sep)[0].toLowerCase() === 'data') continue
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)

    if (entry.isDirectory()) copyProgramTree(sourcePath, targetPath, entryRelative)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
  }
}

function fileSummary(rootPath) {
  let files = 0
  let bytes = 0

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)

      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(target).size
      }
    }
  }

  visit(rootPath)

  return { files, bytes }
}

assertCleanReleaseTarget(targetRoot)
if (!fs.existsSync(path.join(sourceRoot, 'ChatGPT Model Manager.exe'))) {
  throw new Error(`缺少 win-unpacked 主程序：${sourceRoot}`)
}
if (!fs.existsSync(path.join(sourceRoot, 'resources', 'app.asar'))) {
  throw new Error(`缺少 win-unpacked app.asar：${sourceRoot}`)
}

fs.rmSync(targetRoot, { recursive: true, force: true })
copyProgramTree(sourceRoot, targetRoot)

for (const filename of documentationFiles) {
  const source = path.join(projectRoot, filename)
  const target = path.join(targetRoot, filename)

  if (!fs.existsSync(source)) throw new Error(`缺少发布文档：${filename}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

if (fs.existsSync(path.join(targetRoot, 'data'))) {
  throw new Error('纯净完整目录不得包含 data')
}

console.log(
  JSON.stringify(
    {
      version: packageMetadata.version,
      sourceRoot,
      targetRoot,
      ...fileSummary(targetRoot)
    },
    null,
    2
  )
)
