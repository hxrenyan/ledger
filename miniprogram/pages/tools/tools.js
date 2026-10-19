/**
 * 工具。
 *
 * 两套界面：原生工具清单（联系人、日历记录），和内嵌的 H5。用哪一套由服务端 tools.mode 决定，
 * 管理后台改完，下次进入这一栏生效。没读到、读失败、网页打不开，都留在原生。
 */

const session = require('../../utils/session')
const nav = require('../../utils/nav')
const request = require('../../utils/request')
const config = require('../../config')

Page({
  data: {
    guest: false,
    webviewSrc: '',
  },

  onShow() {
    const guest = !session.getToken()
    this.setData({ guest: guest })
    if (guest) {
      this.setData({ webviewSrc: '' })
      return
    }
    this.loadMode()
  },

  loadMode() {
    const ticket = (this._ticket || 0) + 1
    this._ticket = ticket
    const self = this
    request
      .request({ path: '/api/v1/app/tools', withLedger: false })
      .then(function (body) {
        if (self._ticket !== ticket) return null
        if (!body || body.mode !== 'h5') {
          self.setData({ webviewSrc: '' })
          return null
        }
        if (self.data.webviewSrc) return null
        return request.request({ path: '/api/v1/webview/handoff', method: 'POST', data: {} })
      })
      .then(function (issued) {
        if (!issued || self._ticket !== ticket || !issued.code) return
        self.setData({
          webviewSrc: config.getBaseUrl() + '/tools?handoff=' + encodeURIComponent(issued.code),
        })
      })
      .catch(function () {
        if (self._ticket !== ticket) return
        self.setData({ webviewSrc: '' })
      })
  },

  onWebError() {
    this.setData({ webviewSrc: '' })
  },

  goLogin() {
    session.goLogin()
  },

  openContacts() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('tool-contacts')
  },

  openCalendar() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('tool-calendar')
  },
})
