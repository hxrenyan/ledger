/**
 * 智能记账（整页入口）。
 *
 * 页面本身很薄：录音 / 拍照 / 识别 / 核对 / 提交都在 components/ai-panel 里，
 * 这里只负责看图片识别配了没、以及选「记收支」还是「记人情」。
 * 语音走微信同声传译，不看后台有没有语音模型。
 *
 * 页面路径仍叫 speak（nav.js 与加号浮层都按这个 key 跳），
 * 但它现在同时管语音和拍照两条入口，所以标题与文案都不再只提「说」。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const localOcr = require('../../utils/localOcr')

/** 模型已配置即可用。会话已是微信登录时，不因 status.allowed 为 false 把入口藏掉。 */
function modelReady(res) {
  if (!res || !res.available) return false
  if (res.allowed !== false) return true
  return session.isWechat()
}

Page({
  data: {
    /** 语音始终可用。false 只在图片查询结束且语音也被关掉时出现，正常走不到。 */
    available: true,
    canSpeak: true,
    canPhoto: false,
    scope: 'tx',
    show: false,
  },

  onLoad() {
    if (!session.ensure()) return
    this.setData({ available: true, canSpeak: true, show: true })
    // 图片状态与账本无关，不带账本头。语音不查后台模型。
    request
      .get('/api/v1/ocr/status', null, { withLedger: false })
      .then((res) => this.setData({ canPhoto: localOcr.photoAvailable(modelReady(res)) }))
      .catch(() => this.setData({ canPhoto: localOcr.photoAvailable(false) }))
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

  onDone(e) {
    const dates = (e.detail && e.detail.dates) || []
    const latest = dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().pop()
    if (latest) getApp().globalData.pendingLedgerDate = latest
    setTimeout(() => wx.navigateBack(), 500)
  },

  goForm() {
    require('../../utils/nav').go('tx-form', {})
  },

})
