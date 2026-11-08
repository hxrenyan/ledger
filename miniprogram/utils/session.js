/**
 * 会话：token / 当前账本 / 用户 / 账本列表。
 * 会话存在本地 storage，键名是 ledger.*。
 */

const { toId } = require('./id')
const nav = require('./nav')

const TOKEN = 'ledger.token'
const LEDGER = 'ledger.id'
const USER = 'ledger.user'
const LEDGERS = 'ledger.ledgers'

function getToken() {
  return wx.getStorageSync(TOKEN) || ''
}

function getLedgerId() {
  return toId(wx.getStorageSync(LEDGER)) || ''
}

function getUser() {
  return wx.getStorageSync(USER) || null
}

/** 当前会话是微信登录（含绑定后的密码账号）。旧会话没有 wechat_bound 时，wx_ 用户名也算。 */
function isWechat() {
  const user = getUser()
  if (!user) return false
  if (user.wechat_bound) return true
  const name = user.username || ''
  return name.indexOf('wx_') === 0
}

function getLedgers() {
  const raw = wx.getStorageSync(LEDGERS)
  return Array.isArray(raw) ? raw : []
}

/** 当前账本；账本被移除时退回第一个。 */
function currentLedger() {
  const list = getLedgers()
  const id = getLedgerId()
  return list.find((l) => l.id === id) || list[0] || null
}

function setLedger(id) {
  const n = toId(id)
  wx.setStorageSync(LEDGER, n ? String(n) : '')
}

/**
 * 登录 / 刷新 /me 后统一写入，body 形如 {token, user, ledgers, ledger_id?}。
 * ledger_id 是网页端交接会话时带回来的「小程序当时的账本」，优先采信。
 */
function apply(body) {
  if (!body) return
  if (body.token) wx.setStorageSync(TOKEN, body.token)
  if (body.user) wx.setStorageSync(USER, body.user)
  notifyIdentityChanged()
  if (Array.isArray(body.ledgers)) {
    wx.setStorageSync(LEDGERS, body.ledgers)
    const preferred = toId(body.ledger_id)
    const hit = preferred && body.ledgers.some((l) => l.id === preferred) ? preferred : ''
    if (hit) {
      setLedger(hit)
      return
    }
    const keep = body.ledgers.some((l) => l.id === getLedgerId())
    if (!keep) setLedger(body.ledgers[0] ? body.ledgers[0].id : '')
  }
}

/** 展示偏好按账号保存在本机，不随退出登录清除。 */
function recorderPreference() {
  const user = getUser()
  return wx.getStorageSync('ledger.showRecorder.' + (user ? user.id : 'guest')) !== false
}

function setRecorderPreference(value) {
  const user = getUser()
  wx.setStorageSync('ledger.showRecorder.' + (user ? user.id : 'guest'), !!value)
}

function showRecorder(memberCount) {
  return Number(memberCount) > 1 && recorderPreference()
}

/** 加号入口使用固定类型，缓存只保存顺序和启用状态。 */
const ADD_ACTIONS = [
  { type: 'tx', label: '记一笔', icon: '−', color: 'expense' },
  { type: 'gift', label: '记人情', icon: '礼', color: 'gift' },
  { type: 'speak', label: '智能记账', icon: '智', color: 'brand' },
  { type: 'note', label: '日历记录', icon: '语', color: 'voice' },
  { type: 'import', label: '账单导入', icon: '导', color: 'plain' },
]

function normalizeAddActions(raw) {
  const result = []
  const seen = {}
  ;(Array.isArray(raw) ? raw : []).forEach((item) => {
    const action = item && ADD_ACTIONS.find((entry) => entry.type === item.type)
    if (!action || seen[action.type]) return
    seen[action.type] = true
    result.push(Object.assign({}, action, { enabled: item.enabled !== false }))
  })
  ADD_ACTIONS.forEach((action) => {
    if (!seen[action.type]) result.push(Object.assign({}, action, { enabled: true }))
  })
  if (!result.some((item) => item.enabled)) result[0].enabled = true
  return result
}

function addActionPreference() {
  const user = getUser()
  return normalizeAddActions(wx.getStorageSync('ledger.addActions.' + (user ? user.id : 'guest')))
}

function setAddActionPreference(items) {
  const user = getUser()
  wx.setStorageSync('ledger.addActions.' + (user ? user.id : 'guest'),
    normalizeAddActions(items).map((item) => ({ type: item.type, enabled: item.enabled })))
}

function availableAddActions(canAi, canSpeak) {
  return addActionPreference().filter((item) => item.enabled &&
    (item.type !== 'speak' || canAi) && (item.type !== 'note' || canSpeak))
}

function notifyIdentityChanged() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && typeof app.heartbeatContextChanged === 'function') app.heartbeatContextChanged()
}

function clear() {
  ;[TOKEN, LEDGER, USER, LEDGERS].forEach((k) => {
    try {
      wx.removeStorageSync(k)
    } catch (e) {
      /* ignore */
    }
  })
  notifyIdentityChanged()
}

/**
 * 用户自己点了需要账号的操作，再打开登录页。
 * 用 navigateTo，方便返回继续浏览；不要在启动时调用。
 */
function goLogin() {
  if (nav.blockForUpdate()) return false
  const pages = getCurrentPages()
  const top = pages[pages.length - 1]
  if (top && top.route === 'pages/login/login') return false
  wx.navigateTo({ url: '/pages/login/login' })
  return false
}

/** 子页面需要账号时调用。没登录就去登录页，并返回 false。 */
function ensure() {
  if (getToken()) return true
  return goLogin()
}

module.exports = {
  getToken,
  recorderPreference,
  addActionPreference,
  setAddActionPreference,
  availableAddActions,
  setRecorderPreference,
  showRecorder,
  getLedgerId,
  getUser,
  isWechat,
  getLedgers,
  currentLedger,
  setLedger,
  apply,
  clear,
  ensure,
  goLogin,
}
