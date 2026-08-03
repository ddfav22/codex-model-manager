const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { execFile, execFileSync } = require('child_process')

const MAX_ARCHIVE_DOWNLOAD_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10000

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function removeDirIfExists(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}

function copyDir(source, target) {
  ensureDir(target)

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath)
    } else if (entry.isFile()) {
      ensureDir(path.dirname(targetPath))
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  })
}

function powershellAsync(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10 * 60 * 1000
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }

        resolve(stdout)
      }
    )
  })
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function safePackageName(name) {
  const sanitized = String(name || 'imported')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)

  return sanitized || 'imported'
}

function assertPathInsideRoot(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath))

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('压缩包目标目录越界')
  }
}

function inspectZip(zipPath) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$archive = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(zipPath)})`,
    'try {',
    '  $entries = @($archive.Entries | ForEach-Object {',
    '    [pscustomobject]@{ Name = $_.FullName; Length = [int64]$_.Length }',
    '  })',
    '  [pscustomobject]@{ Entries = $entries } | ConvertTo-Json -Compress -Depth 4',
    '} finally {',
    '  $archive.Dispose()',
    '}'
  ].join('\n')
  const payload = JSON.parse(String(powershell(command) || '{}').replace(/^\uFEFF/, ''))
  const entries = Array.isArray(payload.Entries) ? payload.Entries : payload.Entries ? [payload.Entries] : []

  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`压缩包文件数量超过 ${MAX_ARCHIVE_ENTRIES}`)
  let totalBytes = 0

  for (const entry of entries) {
    const name = String(entry?.Name || '').replace(/\\/g, '/')
    const length = Number(entry?.Length || 0)
    const parts = name.split('/').filter(Boolean)

    if (
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      parts.includes('..') ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw new Error(`压缩包包含不安全路径：${name || '未知条目'}`)
    }
    if (length > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`压缩包单个文件过大：${name}`)
    totalBytes += length
    if (totalBytes > MAX_ARCHIVE_EXTRACTED_BYTES) {
      throw new Error(`压缩包解压大小超过 ${MAX_ARCHIVE_EXTRACTED_BYTES} 字节`)
    }
  }

  return { entryCount: entries.length, totalBytes }
}

function expandZip(zipPath, destination) {
  inspectZip(zipPath)
  removeDirIfExists(destination)
  ensureDir(destination)
  powershell(
    `Expand-Archive -Force -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destination)}`
  )
}

function compressZip(sourcePath, destinationZip) {
  ensureDir(path.dirname(destinationZip))
  if (fs.existsSync(destinationZip)) fs.rmSync(destinationZip, { force: true })
  powershell(
    `Compress-Archive -Force -Path ${JSON.stringify(path.join(sourcePath, '*'))} -DestinationPath ${JSON.stringify(destinationZip)}`
  )
}

async function compressDirectoryZip(sourcePath, destinationZip) {
  ensureDir(path.dirname(destinationZip))
  if (fs.existsSync(destinationZip)) fs.rmSync(destinationZip, { force: true })
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${powershellLiteral(sourcePath)}, ${powershellLiteral(destinationZip)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`
  ].join('\n')

  try {
    await powershellAsync(command)
  } catch (error) {
    if (fs.existsSync(destinationZip)) fs.rmSync(destinationZip, { force: true })
    throw error
  }
}

function allowedGithubDownloadHost(hostname, redirected = false) {
  if (/(^|\.)github\.com$/i.test(hostname)) return true

  return redirected && (/(^|\.)githubusercontent\.com$/i.test(hostname) || /^codeload\.github\.com$/i.test(hostname))
}

async function readDownloadLimited(response, limit = MAX_ARCHIVE_DOWNLOAD_BYTES) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel('下载文件过大')
      throw new Error(`下载文件超过 ${limit} 字节限制`)
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, size)
}

async function downloadFile(url, destination) {
  const parsed = new URL(url)

  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('只支持 http 或 https 地址')
  if (!allowedGithubDownloadHost(parsed.hostname)) throw new Error('请输入 GitHub 的 zip 下载地址')

  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })

  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  if (response.url) {
    const finalUrl = new URL(response.url)

    if (!allowedGithubDownloadHost(finalUrl.hostname, true)) throw new Error('GitHub 下载重定向到了不可信地址')
  }

  const buffer = await readDownloadLimited(response)

  ensureDir(path.dirname(destination))
  fs.writeFileSync(destination, buffer)

  return destination
}

function findFirstDirWithFile(rootPath, fileName) {
  if (!fs.existsSync(rootPath)) return null

  const entries = fs.readdirSync(rootPath, { withFileTypes: true })

  if (entries.some(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase())) return rootPath

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = findFirstDirWithFile(path.join(rootPath, entry.name), fileName)

    if (match) return match
  }

  return null
}

function installZipPackage(zipPath, targetRoot, markerFile, name, downloadsPath, options = {}) {
  const tempDir = path.join(downloadsPath, `extract-${randomUUID()}`)
  let stagedTarget = ''

  try {
    expandZip(zipPath, tempDir)
    const sourceDir = findFirstDirWithFile(tempDir, markerFile)

    if (!sourceDir) throw new Error(`压缩包中没有找到 ${markerFile}`)
    if (typeof options.validateSource === 'function') options.validateSource(sourceDir)
    const inferredName =
      path.resolve(sourceDir) === path.resolve(tempDir)
        ? path.basename(zipPath, path.extname(zipPath))
        : path.basename(sourceDir)
    const packageName = safePackageName(name || inferredName)
    const targetDir = path.join(targetRoot, packageName)

    assertPathInsideRoot(targetRoot, targetDir)
    ensureDir(targetRoot)
    stagedTarget = `${targetDir}.installing-${randomUUID()}`
    assertPathInsideRoot(targetRoot, stagedTarget)
    copyDir(sourceDir, stagedTarget)
    removeDirIfExists(targetDir)
    fs.renameSync(stagedTarget, targetDir)
    stagedTarget = ''

    return targetDir
  } finally {
    if (stagedTarget) removeDirIfExists(stagedTarget)
    removeDirIfExists(tempDir)
  }
}

function findFilesByExtension(rootPath, extension) {
  const files = []
  const normalizedExtension = String(extension || '').toLowerCase()
  const stack = [rootPath]

  while (stack.length) {
    const current = stack.pop()

    if (!current || !fs.existsSync(current)) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)

      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === normalizedExtension) files.push(target)
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

function installTomlFilesFromZip(zipPath, targetRoot, downloadsPath, validateFile) {
  const tempDir = path.join(downloadsPath, `extract-${randomUUID()}`)
  const staged = []
  const backups = []
  const installed = []

  try {
    expandZip(zipPath, tempDir)
    const discoveredFiles = findFilesByExtension(tempDir, '.toml')

    if (!discoveredFiles.length) throw new Error('压缩包中没有找到自定义 Agent 的 .toml 配置')
    const sourceFiles = []
    const validationErrors = []

    for (const sourcePath of discoveredFiles) {
      try {
        if (typeof validateFile === 'function') validateFile(sourcePath)
        sourceFiles.push(sourcePath)
      } catch (error) {
        validationErrors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (!sourceFiles.length) {
      throw new Error(`压缩包中没有有效的自定义 Agent 配置：${validationErrors[0] || '缺少必填字段'}`)
    }
    ensureDir(targetRoot)
    const targets = new Set()

    for (const sourcePath of sourceFiles) {
      const fileName = `${safePackageName(path.basename(sourcePath, '.toml'))}.toml`
      const targetPath = path.join(targetRoot, fileName)
      const key = targetPath.toLowerCase()

      assertPathInsideRoot(targetRoot, targetPath)
      if (targets.has(key)) throw new Error(`压缩包中存在重名 Agent 配置：${fileName}`)
      targets.add(key)
      const stagedPath = `${targetPath}.installing-${randomUUID()}`

      fs.copyFileSync(sourcePath, stagedPath)
      staged.push({ stagedPath, targetPath })
    }

    for (const item of staged) {
      if (fs.existsSync(item.targetPath)) {
        const backupPath = `${item.targetPath}.backup-${randomUUID()}`

        fs.renameSync(item.targetPath, backupPath)
        backups.push({ backupPath, targetPath: item.targetPath })
      }
      fs.renameSync(item.stagedPath, item.targetPath)
      installed.push(item.targetPath)
    }

    for (const item of backups) fs.rmSync(item.backupPath, { force: true })

    return installed
  } catch (error) {
    for (const targetPath of installed) {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true })
    }
    for (const item of backups.reverse()) {
      if (fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.targetPath)
    }
    throw error
  } finally {
    for (const item of staged) {
      if (fs.existsSync(item.stagedPath)) fs.rmSync(item.stagedPath, { force: true })
    }
    removeDirIfExists(tempDir)
  }
}

module.exports = {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_EXTRACTED_BYTES,
  allowedGithubDownloadHost,
  compressDirectoryZip,
  compressZip,
  downloadFile,
  installZipPackage,
  installTomlFilesFromZip,
  inspectZip,
  safePackageName
}
