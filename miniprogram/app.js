const config = require('./config')
const session = require('./utils/session')
const appConfig = require('./utils/appConfig')

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
    if (!session.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    // 拉一次「页面归属表」（决定功能页走原生还是 web-view）。
    // 不 await、不弹错：拉不到就用本地兜底（全原生），不阻塞启动。
    appConfig.refresh()
  },
})
