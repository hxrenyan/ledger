/**
 * 「页面归属表」的客户端缓存。
 *
 * 服务端 /api/v1/app/config 决定每个功能页走原生还是走 web-view。
 * 结果缓存到 storage：代码包里的默认值只作兜底，页面跳转全部读缓存，
 * 这样运维在服务端切换归属不用发版，也不用等接口返回。
 */

const request = require('./request')
const config = require('../config')

const STORAGE_KEY = 'ledger.appConfig'

let cached = null

function normalize(raw) {
  const fallback = config.fallbackPages()
  const out = { enabled: false, host: '', pages: fallback }
  if (!raw || typeof raw !== 'object') return out

  const host = typeof raw.host === 'string' ? raw.host.replace(/\/+$/, '') : ''
  out.host = host
  // 服务端说启用但域名是空的，等于没启用——别让 web-view 去加载一个空地址。
  out.enabled = raw.enabled === true && !!host

  if (raw.pages && typeof raw.pages === 'object') {
    Object.keys(raw.pages).forEach(function (key) {
      const page = raw.pages[key]
      const local = out.pages[key]
      if (!local || !page || typeof page !== 'object') return
      out.pages[key] = {
        mode: page.mode === 'webview' ? 'webview' : 'native',
        path: typeof page.path === 'string' && page.path.charAt(0) === '/' ? page.path : local.path,
      }
    })
  }
  return out
}

function readStorage() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || null
  } catch (e) {
    return null
  }
}

cached = readStorage()

/** 同步读。首次启动若还没拉到过，就是全原生，功能不受影响。 */
function get() {
  return cached || normalize(null)
}

function pageOf(key) {
  const pages = get().pages || {}
  return pages[key] || null
}

/** 拉一次服务端配置。失败保留旧值，不影响使用。 */
function refresh() {
  return request
    .get('/api/v1/app/config', null, { withLedger: false })
    .then(function (data) {
      cached = normalize(data && data.webview)
      try {
        wx.setStorageSync(STORAGE_KEY, cached)
      } catch (e) {
        /* storage 满了也别让配置拉取失败 */
      }
      return cached
    })
    .catch(function () {
      return get()
    })
}

function clearCache() {
  cached = null
  try {
    wx.removeStorageSync(STORAGE_KEY)
  } catch (e) {
    /* ignore */
  }
}

module.exports = {
  get: get,
  pageOf: pageOf,
  refresh: refresh,
  clearCache: clearCache,
  normalize: normalize,
}
