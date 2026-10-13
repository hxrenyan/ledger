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
/**
 * 跳转时要带的自由文本（比如备注）。
 * 中文放进页面地址，微信有的机会解成乱码，所以只在内存里交到下一页。
 */
let carried = null

function carry(data) {
  carried = data || null
}

function takeCarry() {
  const data = carried
  carried = null
  return data
}

/**
 * 上一页表单里的备注。页面地址不带这段文字。
 * onLoad 时当前页已经在栈顶，倒数第二页才是跳转来源。
 */
function noteFromPrevPage() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  if (!pages || pages.length < 2) return ''
  const prev = pages[pages.length - 2]
  const note = prev && prev.data ? prev.data.note : ''
  return note == null ? '' : String(note)
}

/** 把跳转或历史数据里变成乱码的备注还原。正常中文原样返回。 */
function repairNote(raw) {
  let text = raw == null ? '' : String(raw)
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(text)) break
    try {
      const next = decodeURIComponent(text)
      if (next === text) break
      text = next
    } catch (e) {
      break
    }
  }
  if (!/[\u4e00-\u9fff]/.test(text) && /[\u00c0-\u00ff]/.test(text)) {
    try {
      text = decodeURIComponent(escape(text))
    } catch (e) {
      /* 还原不了就保持原样 */
    }
  }
  return text
}

function go(key, query) {
  openNative(key, query)
}

module.exports = {
  NATIVE_PAGES: NATIVE_PAGES,
  TAB_PAGES: TAB_PAGES,
  go: go,
  openNative: openNative,
  carry: carry,
  takeCarry: takeCarry,
  noteFromPrevPage: noteFromPrevPage,
  repairNote: repairNote,
  qs: qs,
}
