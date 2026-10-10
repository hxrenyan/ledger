/**
 * 我的。
 *
 * 这一页承担三件事：
 *   1. 入口导航（账本、预算、分类、周期、导入）——全部走 nav.go，便于以后切 web-view；
 *   2. 账号：微信绑定已有账号（POST /me/wechat/bind，会返回**新 token**，必须替换）、退出登录。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const appConfig = require('../../utils/appConfig')
const config = require('../../config')
const nav = require('../../utils/nav')
const ui = require('../../utils/ui')

Page({
  data: {
    nickname: '',
    initial: '',
    username: '',
    wechatBound: false,
    hasPassword: false,
    ledgerName: '',
    ledgerCount: 0,
    guest: false,
  },

  onShow() {
    if (!session.getToken()) {
      this.setData({
        guest: true,
        nickname: '未登录',
        initial: '登',
        username: '',
        wechatBound: false,
        hasPassword: false,
        ledgerName: '登录后查看',
        ledgerCount: 0,
      })
      return
    }
    this.setData({ guest: false })
    this.render()
  },

  goLogin() {
    session.goLogin()
  },

  render() {
    const user = session.getUser() || {}
    const ledger = session.currentLedger()
    const nickname = user.nickname || user.username || '未登录'
    this.setData({
      nickname: nickname,
      initial: nickname.slice(0, 1),
      username: user.username || '',
      wechatBound: !!user.wechat_bound,
      hasPassword: !!user.has_password,
      ledgerName: ledger ? ledger.name : '未选择',
      ledgerCount: session.getLedgers().length,
    })
  },

  /** 用 /me 刷新一次，拿到最新的绑定状态与账本列表。 */
  refreshMe() {
    return request
      .get('/api/v1/me')
      .then((body) => {
        session.apply(body)
        this.render()
      })
      .catch((err) => ui.fail(err, '刷新失败'))
  },

  go(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go(e.currentTarget.dataset.key)
  },

  /** 微信账号 + 已有密码账号合并：成功后服务端会换一个新 token 回来。 */
  bindAccount() {
    ui.prompt({ title: '已有账号的用户名', placeholder: '用户名' }).then((username) => {
      if (username == null || !username) return
      ui.prompt({ title: '密码', placeholder: '密码' }).then((password) => {
        if (password == null) return
        ui.withLoading('合并中', () =>
          request.post('/api/v1/me/wechat/bind', { username: username, password: password }),
        )
          .then((body) => {
            // 必须换上新 token：合并后本地的旧 token 指向的是被并掉的那个用户。
            session.apply(body)
            appConfig.refresh()
            ui.ok('已合并')
            this.refreshMe()
          })
          .catch((err) => ui.fail(err, '合并失败'))
      })
    })
  },

  exportCsv() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const token = session.getToken()
    ui.loading('准备中')
    wx.downloadFile({
      url: config.getBaseUrl() + '/api/v1/export.csv',
      header: token ? { authorization: 'Bearer ' + token } : {},
      success: (res) => {
        ui.hideLoading()
        if (res.statusCode !== 200) {
          ui.toast('导出失败')
          return
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: 'csv',
          showMenu: true,
          fail: () => ui.toast('这个格式打不开，可换手机打开'),
        })
      },
      fail: () => {
        ui.hideLoading()
        ui.toast('导出失败，检查网络')
      },
    })
  },

  logout() {
    ui.confirm('退出后需要重新登录。').then((yes) => {
      if (!yes) return
      session.clear()
      appConfig.clearCache()
      wx.reLaunch({ url: '/pages/login/login' })
    })
  },

  copyInvite() {
    nav.go('ledger')
  },

  about() {
    wx.showModal({
      title: '记账',
      content:
        '个人和家庭记账。记录收入、支出和转账，查看月度明细与预算，管理账户和分类。可以建多个账本，邀请家人一起记，也能记人情往来、做周期记账、导入和导出账单。',
      showCancel: false,
    })
  },
})
