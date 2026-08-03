const fs = require('fs')
const http = require('http')
const path = require('path')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'"
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
}

function isPathInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath)

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveStaticTarget(outRoot, pathname) {
  let cleanPath

  try {
    cleanPath = decodeURIComponent(pathname).replace(/^[/\\]+/, '')
  } catch {
    return null
  }

  const requestedPath = cleanPath ? path.resolve(outRoot, cleanPath) : path.resolve(outRoot, 'index.html')
  const targetPath =
    isPathInsideRoot(outRoot, requestedPath) && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()
      ? requestedPath
      : path.resolve(outRoot, cleanPath, 'index.html')

  if (!isPathInsideRoot(outRoot, targetPath) || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return null
  }

  return targetPath
}

function cacheControlForTarget(outRoot, targetPath) {
  const relative = path.relative(outRoot, targetPath).replace(/\\/g, '/')

  if (path.extname(targetPath).toLowerCase() === '.html') return 'no-cache'
  if (relative.startsWith('_next/static/')) return 'public, max-age=31536000, immutable'

  return 'public, max-age=3600'
}

function startStaticUiServer({ outDir, host = '127.0.0.1', port = 0 } = {}) {
  const outRoot = path.resolve(outDir)
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' })
      response.end()
      return
    }

    let url

    try {
      url = new URL(request.url || '/', `http://${host}`)
    } catch {
      response.writeHead(400, securityHeaders)
      response.end('Bad request')
      return
    }

    const targetPath = resolveStaticTarget(outRoot, url.pathname)

    if (!targetPath) {
      response.writeHead(404, securityHeaders)
      response.end('Not found')
      return
    }

    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': mimeTypes[path.extname(targetPath)] || 'application/octet-stream',
      'Cache-Control': cacheControlForTarget(outRoot, targetPath)
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const stream = fs.createReadStream(targetPath)

    stream.once('error', () => {
      if (!response.headersSent) response.writeHead(500, securityHeaders)
      response.end()
    })
    stream.pipe(response)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()

      resolve({ server, url: `http://${host}:${address.port}`, port: address.port })
    })
  })
}

module.exports = {
  cacheControlForTarget,
  isPathInsideRoot,
  resolveStaticTarget,
  startStaticUiServer
}
