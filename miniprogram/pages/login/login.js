/**
 * 登录。
 *
 * 主路径是微信一键登录（wx.login 拿 code → POST /auth/wechat，服务端换 openid 建号或登录）。
 * 昵称不走授权弹窗：输入框 type="nickname"，用户点一下即可填入微信昵称，随登录一起提交。
 * 账号密码是兜底：老用户、以及线上还没配 WX_APPID/WX_SECRET 时用。
 *
 * 绑定已有账号不在这里做——那需要先登录到微信账号之后才能发起，
 * 放在「我的」页（POST /me/wechat/bind）。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const appConfig = require('../../utils/appConfig')
const config = require('../../config')
const ui = require('../../utils/ui')

function wxLogin() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code)
        else reject({ message: '微信登录失败，请重试' })
      },
      fail: function (err) {
        reject({ message: '微信登录失败，请重试', detail: err })
      },
    })
  })
}

Page({
  data: {
    mode: 'wechat', // wechat | password
    form: 'login', // login | register（仅密码模式）
    username: '',
    password: '',
    nickname: '',
    busy: false,
    err: '',
    wechatTip: '',
    // 当前指向哪个后端。envKey 为 'prod' 时下面那条提示不渲染。
    envKey: 'prod',
    envLabel: '',
    envApi: '',
  },

  onLoad() {
    this.syncEnv()
    if (session.getToken()) {
      wx.reLaunch({ url: '/pages/home/home' })
    }
  },

  /**
   * 登录页是「环境」的死锁出口，所以必须知道当前指向谁。
   *
   * 环境（本地 / 线上）存在本地缓存里。一旦误切成「本地」（指向 http://127.0.0.1:3000），
   * 登录请求发不出去，就再也回不到那页去改回来，整个小程序卡死在登录页。
   * 所以这里做两件事：显示当前指向，以及一键切回线上。
   */
  syncEnv() {
    const env = config.currentEnv()
    this.setData({ envKey: config.currentEnvKey(), envLabel: env.label, envApi: env.api })
  },

  browse() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  backToProd() {
    if (this.data.envKey === 'prod') return
    config.setEnv('prod')
    // 换了后端，旧 token 和归属表缓存都不能再用（归属表是服务端下发的，本地的可能来自另一个后端）。
    session.clear()
    appConfig.clearCache()
    this.syncEnv()
    ui.toast('已切回线上')
  },

  /** 登录成功后统一动作：写会话、拉归属表、进首页。 */
  afterLogin(body) {
    session.apply(body)
    appConfig.refresh()
    wx.reLaunch({ url: '/pages/home/home' })
  },

  onNickname(e) {
    this.setData({ nickname: String((e.detail && e.detail.value) || '').trim() })
  },

  onWechat(e) {
    if (this.data.busy) return
    const fromForm = e && e.detail && e.detail.value ? e.detail.value.nickname : ''
    const nickname = String(fromForm || this.data.nickname || '').trim()
    if (!nickname) {
      this.setData({ err: '请先点一下称呼，选用微信昵称' })
      return
    }
    this.setData({ busy: true, err: '', wechatTip: '', nickname: nickname })
    wxLogin()
      .then(function (code) {
        return request.post('/api/v1/auth/wechat', { code: code, nickname: nickname }, { withLedger: false })
      })
      .then((body) => this.afterLogin(body))
      .catch((err) => {
        this.setData({ busy: false })
        const msg = (err && err.message) || ''
        // 服务端没配微信登录（503）时别把用户卡在死路上，直接给账号密码入口。
        if (err && err.status === 503) {
          this.setData({ mode: 'password', wechatTip: msg || '线上还未开启微信登录，请先用用户名密码登录' })
          return
        }
        this.setData({ err: msg || '微信登录失败' })
      })
  },

  toPassword() {
    this.setData({ mode: 'password', err: '' })
  },

  toWechat() {
    this.setData({ mode: 'wechat', err: '' })
  },

  switchForm() {
    this.setData({ form: this.data.form === 'login' ? 'register' : 'login', err: '' })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const data = {}
    data[key] = e.detail.value
    this.setData(data)
  },

  onSubmit() {
    if (this.data.busy) return
    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    if (!username || !password) {
      this.setData({ err: '请输入用户名和密码' })
      return
    }
    const register = this.data.form === 'register'
    const payload = register
      ? { username: username, password: password, nickname: (this.data.nickname || '').trim() }
      : { username: username, password: password }

    this.setData({ busy: true, err: '' })
    const task = register
      ? request.post('/api/v1/auth/register', payload, { withLedger: false })
      : request.post('/api/v1/auth/login', payload, { withLedger: false })

    task
      .then((body) => this.afterLogin(body))
      .catch((err) => {
        this.setData({ busy: false, err: (err && err.message) || '登录失败' })
      })
  },
})
