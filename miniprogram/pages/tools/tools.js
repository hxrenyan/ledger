/**
 * 工具。
 *
 * 这一页只负责打开 H5。里面加什么（联系人、以后的其它工具）都在网页上，
 * 重新发布服务就生效，不用发小程序。
 */

const config = require('../../config')
const request = require('../../utils/request')
const session = require('../../utils/session')

Page({
  data: {
    guest: false,
    src: '',
    hint: '打开中…',
  },

  onShow() {
    if (!session.getToken()) {
      this.ledgerId = ''
      this.setData({ guest: true, src: '', hint: '登录后使用工具' })
      return
    }
    const ledgerId = session.getLedgerId()
    if (!ledgerId) {
      this.ledgerId = ''
      this.setData({ guest: false, src: '', hint: '请先在「我的」里选择账本' })
      return
    }
    if (this.data.src && this.ledgerId === ledgerId) return
    this.ledgerId = ledgerId
    this.open(ledgerId)
  },

  goLogin() {
    session.goLogin()
  },

  open(ledgerId) {
    this.setData({ hint: '打开中…', guest: false })
    request
      .post('/api/v1/webview/handoff', {})
      .then((body) => {
        if (this.ledgerId !== ledgerId) return
        if (!body || !body.code) {
          this.setData({ src: '', hint: '打不开工具' })
          return
        }
        const src = config.getBaseUrl() + '/tools?handoff=' + encodeURIComponent(body.code)
        this.setData({ src: src, hint: '' })
      })
      .catch(() => {
        if (this.ledgerId !== ledgerId) return
        this.setData({ src: '', hint: '工具页打不开，请检查网络' })
      })
  },

  onWebError() {
    this.ledgerId = ''
    this.setData({
      src: '',
      hint: '工具页打不开。请确认业务域名已配置；开发时勾选不校验合法域名。',
    })
  },
})
