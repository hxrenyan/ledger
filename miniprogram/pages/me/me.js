/**
 * 我的。
 *
 * 这一页承担三件事：
 *   1. 入口导航（账本、预算、分类、周期、导入）——全部走 nav.go，便于以后切 web-view；
 *   2. 账号：微信绑定已有账号（POST /me/wechat/bind，会返回**新 token**，必须替换）、退出登录；
 *   3. 开发者：本地 / 线上环境切换，切换后清掉归属表缓存并重进首页。
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
    envLabel: '',
    baseUrl: '',
    webviewHost: '',
    webviewKey: '',
  },

  onShow() {
    if (!session.ensure()) return
    this.render()
  },

  render() {
    const user = session.getUser() || {}
    const ledger = session.currentLedger()
    const cfg = appConfig.get()
    const pages = cfg.pages || {}
    const webviewKey = Object.keys(pages).find((k) => pages[k].mode === 'webview') || ''
    const nickname = user.nickname || user.username || '未登录'
    this.setData({
      nickname: nickname,
      initial: nickname.slice(0, 1),
      username: user.username || '',
      wechatBound: !!user.wechat_bound,
      hasPassword: !!user.has_password,
      ledgerName: ledger ? ledger.name : '未选择',
      ledgerCount: session.getLedgers().length,
      envLabel: config.currentEnv().label,
      baseUrl: config.getBaseUrl(),
      webviewHost: cfg.enabled ? cfg.host : '',
      webviewKey: webviewKey,
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
    nav.go(e.currentTarget.dataset.key)
  },

  openWebview() {
    if (!this.data.webviewKey) {
      ui.toast('网页版还没启用')
      return
    }
    nav.go(this.data.webviewKey)
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

  pickEnv() {
    const list = config.envList()
    ui.actions(list.map((e) => e.label + '（' + e.api + '）')).then((idx) => {
      if (idx < 0) return
      const env = list[idx]
      if (env.key === config.currentEnvKey()) return
      config.setEnv(env.key)
      // 换了后端，会话和归属表都得重来，否则会拿旧 token 打新服务。
      session.clear()
      appConfig.clearCache()
      ui.toast('已切到' + env.label + '，请重新登录')
      setTimeout(() => wx.reLaunch({ url: '/pages/login/login' }), 900)
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
      title: '关于',
      content:
        '记账小程序\n后端：' +
        config.getBaseUrl() +
        '\n所有改动都走同一套 API，网页版与小程序共用账本。',
      showCancel: false,
    })
  },
})
