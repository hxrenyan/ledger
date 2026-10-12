const config = require('../../config')
const request = require('../../utils/request')
const session = require('../../utils/session')

function pageTitle(text) {
  const found = String(text || '').match(/<title>([^<]{1,20})<\/title>/i)
  return found ? found[1] : '网页'
}

/** 开发者工具有时把 JSON 套进网页再交回来，从中取出对象。 */
function embeddedJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    if (value && typeof value === 'object' && (value.balance != null || Array.isArray(value.items))) return value
  } catch (e) {
    return null
  }
  return null
}

/** 把接口结果收成对象。字符串、包了一层 data、网页都在这里辨认。 */
function asJson(raw) {
  let value = raw
  if (typeof value === 'string') {
    const text = value.replace(/^\uFEFF/, '').trim()
    if (!text) return null
    if (text.charAt(0) === '<') {
      const embedded = embeddedJson(text)
      if (embedded) return embedded
      return { html: true, title: pageTitle(text) }
    }
    try {
      value = JSON.parse(text)
    } catch (e) {
      return null
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch (e) {
        return null
      }
    }
  }
  if (!value || typeof value !== 'object') return null
  if (value.balance == null && !Array.isArray(value.items) && value.data && typeof value.data === 'object') {
    value = value.data
  }
  return value
}

function rawHint(raw) {
  if (raw == null || raw === '') return '空响应'
  if (typeof raw === 'string') {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return '空响应'
    if (text.charAt(0) === '<') return '返回了网页'
    return text.slice(0, 24)
  }
  if (typeof raw === 'object') {
    const keys = Object.keys(raw)
    return keys.length ? keys.slice(0, 4).join(',') : '空对象'
  }
  return typeof raw
}

function failText(err) {
  const message = (err && (err.message || err.errMsg)) || '积分加载失败'
  if (config.getBaseUrl().indexOf('127.0.0.1') >= 0) return '当前连的是本地，登录页请改成线上'
  return message
}

function fetchJson(path) {
  function once() {
    // 带一个每次都变的参数，避开开发者工具把旧网页缓存成这条接口的响应。
    return request.get(path, { _: Date.now() }, { withLedger: false, header: { accept: 'application/json' } })
  }
  return once().then((raw) => {
    const body = asJson(raw)
    if (body && !body.html) return { body: body, raw: raw }
    return once().then((again) => ({ body: asJson(again), raw: again == null || again === '' ? raw : again }))
  })
}

Page({
  data: {
    loading: true,
    balance: '',
    streak: 0,
    entries: [],
    empty: false,
    error: '',
  },

  onShow() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.load()
  },

  load() {
    const seq = (this._seq || 0) + 1
    this._seq = seq
    this.setData({ loading: true, empty: false, error: '', entries: [] })
    fetchJson('/api/v1/points')
      .then((got) => {
        if (this._seq !== seq) return null
        const body = got.body
        if (!body || body.html || body.balance == null) {
          const why = body && body.message
            ? body.message
            : body && body.html
              ? '积分接口打开了「' + (body.title || '网页') + '」' + config.getBaseUrl()
              : '没有读到积分余额（' + rawHint(got.raw) + '）'
          throw { message: why }
        }
        this.setData({
          balance: String(body.balance),
          streak: body.streak || 0,
        })
        return fetchJson('/api/v1/points/entries')
      })
      .then((got) => {
        if (!got || this._seq !== seq) return
        const listed = got.body
        const items = listed && Array.isArray(listed.items) ? listed.items : null
        if (!items) {
          const why = listed && listed.message ? listed.message : '没有读到积分明细（' + rawHint(got.raw) + '）'
          throw { message: why }
        }
        this.setData({
          loading: false,
          empty: items.length === 0,
          error: '',
          entries: items.map((item) => ({
            id: item.id,
            title: item.title || '积分',
            note: item.note || '',
            time: item.time || '',
            deltaText: (Number(item.delta) > 0 ? '+' : '') + item.delta,
          })),
        })
      })
      .catch((err) => {
        if (this._seq !== seq) return
        this.setData({ loading: false, entries: [], error: failText(err) })
      })
  },
})
