/**
 * web-view 通用容器页。
 *
 * 所有「归属表里标为 webview」的功能页都复用这一个页面（app.json 里只登记一次），
 * 具体打开哪个网页由 onLoad 的 key 决定。这样新增一个网页版页面只需改服务端配置，
 * 不用动小程序代码、不用发版。
 *
 * 会话：网页里没有 wx.login，所以进页面前先向服务端换一个一次性交接码，
 * 拼在 href 上交给网页（见 utils/webview.js）。
 */

const appConfig = require('../../utils/appConfig')
const webview = require('../../utils/webview')
const nav = require('../../utils/nav')

Page({
  data: {
    src: '',
    loading: true,
    failed: false,
    message: '',
    title: '网页版',
  },

  onLoad(query) {
    const q = query || {}
    const key = q.key || ''
    const title = q.title ? decodeURIComponent(q.title) : nav.TITLES[key] || '网页版'
    const extra = q.q ? decodeURIComponent(q.q) : ''

    this.key = key
    this.extra = extra
    this.fallbacked = false
    wx.setNavigationBarTitle({ title: title })
    this.setData({ title: title })

    const cfg = appConfig.get()
    const page = cfg.pages && cfg.pages[key]

    // 归属表已经改回原生（或配置没拉到）：直接换回原生页，不要留一张白纸。
    if (!cfg.enabled || !cfg.host || !page || page.mode !== 'webview') {
      this.fallback('该页面已切回原生')
      return
    }

    webview.prepare(cfg.host, page.path, extra).then(
      function (src) {
        if (!src) {
          this.fallback('无法建立网页会话')
          return
        }
        this.setData({ src: src, loading: false })
      }.bind(this),
    )
  },

  onWebLoad() {
    this.setData({ loading: false, failed: false })
  },

  onWebError() {
    this.fallback('网页加载失败')
  },

  /**
   * H5 侧 wx.miniProgram.postMessage 过来的消息。
   * 注意微信只在「后退 / 组件销毁 / 分享 / 复制链接」时才投递，不是即时通道，
   * 所以只拿它做轻量提示，需要即时跳转一律用 wx.miniProgram.navigateTo。
   */
  onMessage(e) {
    const list = (e && e.detail && e.detail.data) || []
    const last = list[list.length - 1]
    if (!last || typeof last !== 'object') return
    if (last.type === 'toast' && last.text) {
      wx.showToast({ title: String(last.text), icon: 'none' })
    }
  },

  /** 降级：换回原生页，并明确告诉用户发生了什么。 */
  fallback(message) {
    if (this.fallbacked) return
    this.fallbacked = true
    this.setData({ loading: false, failed: true, message: message || '网页打不开' })
    wx.showToast({ title: message || '网页打不开', icon: 'none' })
  },

  onOpenNative() {
    nav.openNative(this.key, null, true)
  },

  onShareAppMessage() {
    return {
      title: this.data.title,
      path: nav.NATIVE_PAGES[this.key] || '/pages/home/home',
    }
  },
})
