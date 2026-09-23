/**
 * 智能记账（整页入口）。
 *
 * 页面本身很薄：录音 / 拍照 / 识别 / 核对 / 提交都在 components/ai-panel 里，
 * 这里只负责看两个识别模型配了没、以及选「记收支」还是「记人情」。
 *
 * 页面路径仍叫 speak（nav.js 与加号浮层都按这个 key 跳），
 * 但它现在同时管语音和拍照两条入口，所以标题与文案都不再只提「说」。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')

Page({
  data: {
    /** null = 还在查；false = 语音与图片识别都没配 */
    available: null,
    canSpeak: false,
    canPhoto: false,
    scope: 'tx',
    show: false,
  },

  onLoad() {
    if (!session.ensure()) return
    // 两个 status 都与账本无关，所以不带账本头（后端已把它们登记成免账本）。
    this.pending = 2
    request
      .get('/api/v1/speech/status', null, { withLedger: false })
      .then((res) => this.setStatus('canSpeak', !!(res && res.available)))
      .catch(() => this.setStatus('canSpeak', false))
    request
      .get('/api/v1/ocr/status', null, { withLedger: false })
      .then((res) => this.setStatus('canPhoto', !!(res && res.available)))
      .catch(() => this.setStatus('canPhoto', false))
  },

  /**
   * 两次查询各自回来。任一可用就开门，两个都回完且都不可用才判「没配」——
   * 否则先回来的那个是 false 时会闪一下「还没配置」。
   */
  setStatus(key, value) {
    this.pending = Math.max(0, (this.pending || 0) - 1)
    const patch = {}
    patch[key] = value
    if (value) {
      patch.available = true
      patch.show = true
    } else if (!this.pending) {
      patch.available = false
    }
    this.setData(patch)
  },

  setScope(e) {
    const scope = e.currentTarget.dataset.scope
    this.setData({ scope: scope, show: false })
    setTimeout(() => this.setData({ show: true }), 60)
  },

  open() {
    this.setData({ show: true })
  },

  close() {
    this.setData({ show: false })
  },

  onDone() {
    setTimeout(() => wx.navigateBack(), 500)
  },

  goForm() {
    require('../../utils/nav').go('tx-form', {})
  },

  retryStatus() {
    ui.toast('识别服务由管理员在后台配置')
  },
})
