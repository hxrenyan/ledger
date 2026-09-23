/**
 * 页面跳转统一入口。
 *
 * 全项目不要直接 wx.navigateTo 到功能页，一律走 nav.go(key)：
 * 只有这里知道「这个页面当前该走原生还是走 web-view」——归属表由服务端下发，
 * 运维改完 deploy 即生效，不用发版、不用审核。
 */

const appConfig = require('./appConfig')

/** 原生页面路径。web-view 打不开时也回退到这些页面。 */
const NATIVE_PAGES = {
  login: '/pages/login/login',
  home: '/pages/home/home',
  'tx-form': '/pages/tx-form/tx-form',
  favors: '/pages/favors/favors',
  'favor-person': '/pages/favor-person/favor-person',
  'gift-form': '/pages/gift-form/gift-form',
  assets: '/pages/assets/assets',
  me: '/pages/me/me',
  ledger: '/pages/ledger/ledger',
  budgets: '/pages/budgets/budgets',
  categories: '/pages/categories/categories',
  recurring: '/pages/recurring/recurring',
  speak: '/pages/speak/speak',
  import: '/pages/import/import',
}

/** tabBar 页面只能 switchTab / reLaunch，navigateTo 会失败。 */
const TAB_PAGES = { home: true, favors: true, assets: true, me: true }

const TITLES = {
  ledger: '账本与成员',
  budgets: '预算',
  categories: '分类',
  recurring: '周期记账',
  import: '账单导入',
}

function qs(query) {
  const parts = []
  Object.keys(query || {}).forEach(function (k) {
    const v = query[k]
    if (v === undefined || v === null || v === '') return
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
  })
  return parts.join('&')
}

function suffix(query) {
  const s = qs(query)
  return s ? '?' + s : ''
}

/** 直接打开原生页（web-view 容器的降级出口也用它）。 */
function openNative(key, query, reopen) {
  const url = NATIVE_PAGES[key]
  if (!url) {
    wx.showToast({ title: '页面不存在', icon: 'none' })
    return
  }
  if (TAB_PAGES[key]) {
    wx.switchTab({ url: url })
    return
  }
  // reopen：从 web-view 里退回原生时用，避免在返回栈里堆一层网页。
  if (reopen) {
    wx.redirectTo({ url: url + suffix(query) })
    return
  }
  wx.navigateTo({ url: url + suffix(query) })
}

/**
 * 打开一个功能页。key 见 app.json / 服务端页面归属表。
 * 归属表里是 webview 且域名可用就走网页，否则走原生。
 */
function go(key, query) {
  const cfg = appConfig.get()
  const page = cfg.pages && cfg.pages[key]
  const canWeb = cfg.enabled && cfg.host && page && page.mode === 'webview'

  if (!canWeb) {
    openNative(key, query)
    return
  }

  const params = ['key=' + encodeURIComponent(key)]
  const title = TITLES[key]
  if (title) params.push('title=' + encodeURIComponent(title))
  const inner = qs(query)
  if (inner) params.push('q=' + encodeURIComponent(inner))
  wx.navigateTo({ url: '/pages/webview/webview?' + params.join('&') })
}

module.exports = {
  NATIVE_PAGES: NATIVE_PAGES,
  TAB_PAGES: TAB_PAGES,
  TITLES: TITLES,
  go: go,
  openNative: openNative,
  qs: qs,
}
