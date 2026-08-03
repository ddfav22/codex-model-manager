const CLOSE_ACTION = Object.freeze({
  MINIMIZE: 'minimize',
  QUIT: 'quit',
  CANCEL: 'cancel'
})

function closePromptOptions() {
  return {
    type: 'question',
    title: '关闭 ChatGPT Model Manager',
    message: '要最小化到任务栏，还是关闭程序？',
    detail: '最小化后本地代理继续运行；关闭程序会停止本地代理。',
    buttons: ['最小化到任务栏', '关闭程序', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
}

function actionFromResponse(response) {
  if (response === 0) return CLOSE_ACTION.MINIMIZE
  if (response === 1) return CLOSE_ACTION.QUIT

  return CLOSE_ACTION.CANCEL
}

function createWindowCloseHandler({
  dialog,
  getWindow,
  isQuitting,
  onMinimize,
  onQuit,
  logEvent = () => {},
  logError = () => {}
}) {
  let promptPending = false

  return async function handleWindowClose(event) {
    if (isQuitting()) return

    event.preventDefault()
    if (promptPending) return

    promptPending = true
    logEvent('info', 'window.close.prompt.opened')

    try {
      const window = getWindow()
      const result = await dialog.showMessageBox(window, closePromptOptions())

      if (isQuitting()) return

      const action = actionFromResponse(result?.response)

      logEvent('info', 'window.close.choice', { action })
      if (action === CLOSE_ACTION.MINIMIZE) {
        await onMinimize()
      } else if (action === CLOSE_ACTION.QUIT) {
        await onQuit()
      }
    } catch (error) {
      logError('window.close.prompt.failed', error)
    } finally {
      promptPending = false
    }
  }
}

module.exports = {
  CLOSE_ACTION,
  actionFromResponse,
  closePromptOptions,
  createWindowCloseHandler
}
