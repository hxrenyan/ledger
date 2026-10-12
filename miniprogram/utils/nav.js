/**
 * 页面跳转统一入口。
 *
 * 全项目不要直接 wx.navigateTo 到功能页，一律走 nav.go(key)。
 */

/** 原生页面路径。 */
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

/** 打开一个功能页。 */
function go(key, query) {
  openNative(key, query)
}

module.exports = {
  NATIVE_PAGES: NATIVE_PAGES,
  TAB_PAGES: TAB_PAGES,
  go: go,
  openNative: openNative,
  qs: qs,
}
