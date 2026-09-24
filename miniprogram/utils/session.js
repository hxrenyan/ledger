/**
 * 会话：token / 当前账本 / 用户 / 账本列表。
 * 存储键与 web/src/stores/session.ts 对齐（ledger.*），方便排查。
 */

const { toId } = require('./id')

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

function clear() {
  ;[TOKEN, LEDGER, USER, LEDGERS].forEach((k) => {
    try {
      wx.removeStorageSync(k)
    } catch (e) {
      /* ignore */
    }
  })
}

/** 有 token 才放行；没有就回登录页。返回是否已登录。 */
function ensure() {
  if (getToken()) return true
  wx.reLaunch({ url: '/pages/login/login' })
  return false
}

module.exports = {
  getToken,
  getLedgerId,
  getUser,
  getLedgers,
  currentLedger,
  setLedger,
  apply,
  clear,
  ensure,
}
