const config = require('../../config')
const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')

function asJson(raw) {
  let value = raw
  if (typeof value === 'string') {
    const text = value.replace(/^\uFEFF/, '').trim()
    if (!text || text.charAt(0) === '<') return null
    try {
      value = JSON.parse(text)
    } catch (e) {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value.items) && value.data && typeof value.data === 'object') value = value.data
  return value
}

function failText(err, raw) {
  if (config.getBaseUrl().indexOf('127.0.0.1') >= 0) return '当前连的是本地，登录页请改成线上'
  const message = err && (err.message || err.errMsg)
  if (message) return message
  if (typeof raw === 'string' && raw.trim().charAt(0) === '<') return '反馈接口返回了网页'
  return '反馈加载失败'
}

Page({
  data: {
    content: '',
    items: [],
    busy: false,
    loaded: false,
    error: '',
  },

  onShow() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.load()
  },

  onContent(e) {
    this.setData({ content: e.detail.value })
  },

  load() {
    this.setData({ error: '' })
    // 查询参数每次都变，避免开发者工具把以前的网页缓存当成这条接口的结果。
    request
      .get('/api/v1/feedbacks', { _: Date.now() }, { withLedger: false, header: { accept: 'application/json' } })
      .then((raw) => {
        const body = asJson(raw)
        if (!body || !Array.isArray(body.items)) {
          this.setData({ loaded: true, error: failText(null, raw) })
          return
        }
        this.setData({ items: body.items, loaded: true, error: '' })
      })
      .catch((err) => {
        this.setData({ loaded: true, error: failText(err) })
      })
  },

  submit() {
    if (this.data.busy) return
    const content = String(this.data.content || '').trim()
    if (!content) {
      ui.toast('请填写反馈内容')
      return
    }
    this.setData({ busy: true })
    request
      .post('/api/v1/feedbacks', { content: content })
      .then((body) => {
        if (!body || body.id == null) {
          this.setData({ busy: false })
          ui.toast('提交失败')
          return
        }
        this.setData({ content: '', busy: false })
        ui.toast('已提交')
        this.load()
      })
      .catch((err) => {
        this.setData({ busy: false })
        ui.fail(err, '提交失败')
      })
  },
})
