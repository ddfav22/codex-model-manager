const assert = require('assert')
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')
const packageMetadata = require('../package.json')

const releaseRoot = path.resolve(__dirname, '..', 'release')
const completeRoot = path.resolve(
  process.argv[2] || path.join(releaseRoot, `ChatGPT-Model-Manager-${packageMetadata.version}-complete`)
)
const forbiddenPathPatterns = [
  /(^|\/)data(\/|$)/i,
  /(^|\/)auth(?:\.json|-)/i,
  /(^|\/)initial-(?:auth|config|models-cache|backup)/i,
  /(^|\/)(?:channels|newapi|model-aliases)\.json$/i,
  /(^|\/)(?:cookies?|local storage|session storage|sharedstorage|network|preferences|local state)(\/|$)/i,
  /(^|\/)(?:cache|code cache|gpucache|dawnwebgpucache|dawngraphitecache)(\/|$)/i,
  /(^|\/)(?:logs?|diagnostics|runtime|crash-dumps?)(\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i
]

function relativeFiles(rootPath) {
  const files = []

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)

      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.push(path.relative(rootPath, target).replace(/\\/g, '/'))
    }
  }

  visit(rootPath)

  return files
}

assert.ok(fs.existsSync(completeRoot), `纯净完整目录不存在：${completeRoot}`)
assert.strictEqual(path.dirname(completeRoot), releaseRoot, '纯净发布测试只允许检查 release 下的当前版本完整目录')
assert.strictEqual(
  path.basename(completeRoot),
  `ChatGPT-Model-Manager-${packageMetadata.version}-complete`,
  '纯净发布目录版本与 package.json 不一致'
)

const files = relativeFiles(completeRoot)
const forbiddenFiles = files.filter(filename => forbiddenPathPatterns.some(pattern => pattern.test(filename)))
const archivePath = path.join(completeRoot, 'resources', 'app.asar')

assert.ok(files.length > 0, '纯净完整目录没有程序文件')
assert.ok(files.includes('ChatGPT Model Manager.exe'), '纯净完整目录缺少主程序')
assert.ok(files.includes('resources/app.asar'), '纯净完整目录缺少 app.asar')
assert.ok(files.includes('README.md'), '纯净完整目录缺少公开使用说明')
assert.ok(files.includes('CHANGELOG.md'), '纯净完整目录缺少公开更新日志')
assert.ok(files.includes('docs/HANDOFF.md'), '纯净完整目录缺少脱敏维护交接')
assert.ok(!files.includes('GROK-OAUTH-REVIEW.md'), '纯净完整目录不得包含本机开发审查记录')
assert.ok(!files.includes('RELEASE-TEST-REPORT.md'), '纯净完整目录不得包含本机发布记录')
assert.deepStrictEqual(forbiddenFiles, [], `纯净完整目录发现用户数据：${forbiddenFiles.join(', ')}`)

const archiveEntries = asar.listPackage(archivePath).map(entry => entry.replace(/\\/g, '/'))
const archiveDataEntries = archiveEntries.filter(entry => /^\/?data(?:\/|$)/i.test(entry))

assert.deepStrictEqual(archiveDataEntries, [], `app.asar 不得包含 data：${archiveDataEntries.join(', ')}`)
console.log(
  JSON.stringify(
    {
      version: packageMetadata.version,
      completeRoot,
      fileCount: files.length,
      forbiddenFileCount: forbiddenFiles.length,
      archiveDataEntryCount: archiveDataEntries.length
    },
    null,
    2
  )
)
