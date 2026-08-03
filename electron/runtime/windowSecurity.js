const { shell } = require('electron')

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function configureWindowSecurity(window, allowedUrl) {
  const webContents = window.webContents

  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)

    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, allowedUrl)) event.preventDefault()
  })
  webContents.session.setPermissionRequestHandler((_requestingWebContents, _permission, callback) => {
    callback(false)
  })
}

module.exports = {
  configureWindowSecurity,
  sameOrigin
}
