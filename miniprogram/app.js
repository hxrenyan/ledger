const config = require('./config')
const session = require('./utils/session')
const request = require('./utils/request')

let cloudReady = false

/**
 * 线上环境的请求走云函数中转（见 utils/transport.js），得先把云开发环境初始化好。
 *
 * 用不用得上只取决于「配没配 CLOUD_ENV」，与当前选的是本地还是线上无关 ——
 * 所以不必在环境切换时重新初始化。没配 CLOUD_ENV 就整个跳过，transport 会
 * 自动降级成直连，开发者工具和真机调试的行为与改造前完全一致。
 */
function initCloud() {
  if (cloudReady) return
  const env = config.getCloudEnv()
  if (!env) return
  if (!wx.cloud || typeof wx.cloud.init !== 'function') return
  wx.cloud.init({ env: env, traceUser: false })
  cloudReady = true
}

const FORCE_PAGE = 'pages/force-update/force-update'
const DEFAULT_ABOUT =
  '个人和家庭记账。记录收入、支出和转账，查看月度明细与预算，管理账户和分类。可以建多个账本，邀请家人一起记，也能记人情往来、做周期记账、导入和导出账单。'

function clientVersion() {
  try {
    const info = wx.getAccountInfoSync().miniProgram || {}
    return { version: info.version || '', env: info.envVersion || '' }
  } catch (e) {
    return { version: '', env: '' }
  }
}

App({
  globalData: {
    /** 环境切换后置位，页面 onShow 时判断是否要重新拉数据。 */
    envChangedAt: 0,
    /** 最近一次关于文案和版本门槛。关于弹窗优先用它。 */
    client: null,
    updateRequired: false,
    updateReady: false,
    updateFailed: false,
  },

  onLaunch() {
    // 必须排在所有请求之前：登录页也要发请求。
    initCloud()
    this.bindUpdateManager()
    this.checkClient()
    // 未登录也进首页。审核要求先浏览功能，再由用户自己选择登录。
  },

  /**
   * 回到前台时核对版本，再领当天的进入积分。发不发、发多少都由服务端决定。
   * 同一天再进来 granted_daily 是 0，不再提示。
   */
  onShow() {
    return this.checkClient()
      .then(() => {
        if (this.globalData.updateRequired || !session.getToken()) return null
        return request.post('/api/v1/points/check-in', {}, { withLedger: false })
      })
      .then((body) => {
        if (this.globalData.updateRequired || !body || !body.granted_daily) return
        if (body.granted_streak) {
          wx.showModal({ title: '连续进入', content: body.message || '连续进入奖励已到账', showCancel: false })
          return
        }
        wx.showToast({ title: '今日进入 +1', icon: 'none' })
      })
      .catch(() => {})
  },

  /** 新版本下好后先记着。必须更新时直接重新进入，不等用户再点一次。 */
  bindUpdateManager() {
    if (this._updateBound || typeof wx.getUpdateManager !== 'function') return
    this._updateBound = true
    const mgr = wx.getUpdateManager()
    const self = this
    mgr.onUpdateReady(function () {
      self.globalData.updateReady = true
      self.globalData.updateFailed = false
      if (self.globalData.updateRequired) mgr.applyUpdate()
    })
    mgr.onUpdateFailed(function () {
      self.globalData.updateFailed = true
      const pages = getCurrentPages()
      const top = pages[pages.length - 1]
      if (top && top.route === FORCE_PAGE) top.setData({ failed: true })
    })
  },

  /**
   * 读关于文案和最低版本。正式版低于门槛时停在更新页。
   * 开发版、体验版版本号经常是空的，不拦截。
   */
  checkClient() {
    // 启动和首次回前台会紧接着触发，复用检查，避免旧配置响应覆盖新门槛。
    if (this._clientCheck) return this._clientCheck
    const info = clientVersion()
    const self = this
    const query = info.version ? '?version=' + encodeURIComponent(info.version) : ''
    this._clientCheck = request
      .get('/api/v1/app/client' + query, null, { withLedger: false })
      .then(function (body) {
        self.globalData.client = body || null
        const required = !!(body && body.update_required) && info.env === 'release'
        self.globalData.updateRequired = required
        if (!required) {
          self.leaveForceUpdate()
          return
        }
        if (self.globalData.updateReady && typeof wx.getUpdateManager === 'function') {
          wx.getUpdateManager().applyUpdate()
          return
        }
        self.openForceUpdate()
      })
      .catch(function () {
        if (self.globalData.updateRequired) self.openForceUpdate()
      })
      .finally(function () {
        self._clientCheck = null
      })
    return this._clientCheck
  },

  openForceUpdate() {
    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    if (top && top.route === FORCE_PAGE) return
    wx.reLaunch({ url: '/' + FORCE_PAGE })
  },

  leaveForceUpdate() {
    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    if (!top || top.route !== FORCE_PAGE) return
    wx.switchTab({ url: '/pages/home/home' })
  },

  aboutText() {
    const body = this.globalData.client
    return {
      title: (body && body.about_title) || '记账',
      content: (body && body.about_body) || DEFAULT_ABOUT,
    }
  },
})
