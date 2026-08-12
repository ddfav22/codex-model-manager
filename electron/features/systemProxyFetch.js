function createSystemProxyFetch(netModule) {
  if (!netModule || typeof netModule.fetch !== 'function') {
    throw new TypeError('Electron net.fetch is unavailable')
  }

  return (input, init) => netModule.fetch(input, init)
}

function installSystemProxyFetch(fetchFn, target = globalThis) {
  if (typeof fetchFn !== 'function') throw new TypeError('System proxy fetch must be a function')
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    throw new TypeError('Fetch target must be an object')
  }

  const hadOwnFetch = Object.prototype.hasOwnProperty.call(target, 'fetch')
  const previousFetch = target.fetch

  target.fetch = fetchFn

  return () => {
    if (target.fetch !== fetchFn) return false

    if (hadOwnFetch) target.fetch = previousFetch
    else delete target.fetch

    return true
  }
}

module.exports = {
  createSystemProxyFetch,
  installSystemProxyFetch
}
