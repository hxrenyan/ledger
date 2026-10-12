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

App({
  globalData: {
    /** 环境切换后置位，页面 onShow 时判断是否要重新拉数据。 */
    envChangedAt: 0,
  },

  onLaunch() {
    // 必须排在所有请求之前：登录页也要发请求。
    initCloud()
    // 未登录也进首页。审核要求先浏览功能，再由用户自己选择登录。
    if (!session.getToken()) return
  },

  /**
   * 回到前台时领当天的进入积分。发不发、发多少都由服务端决定。
   * 同一天再进来 granted_daily 是 0，不再提示。
   */
  onShow() {
    if (!session.getToken()) return
    request
      .post('/api/v1/points/check-in', {}, { withLedger: false })
      .then((body) => {
        if (!body || !body.granted_daily) return
        if (body.granted_streak) {
          wx.showModal({ title: '连续进入', content: body.message || '连续进入奖励已到账', showCancel: false })
          return
        }
        wx.showToast({ title: '今日进入 +1', icon: 'none' })
      })
      .catch(() => {})
  },
})
