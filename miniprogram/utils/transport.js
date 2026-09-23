/**
 * 传输层：决定请求「怎么送出去」，业务语义一概不管。
 *
 * 这一层存在的唯一原因是：体验版 / 正式版会严格校验「服务器域名」白名单，
 * 而白名单要求域名已完成 ICP 备案，我们的后端挂在 Cloudflare 上、备案走不通。
 * 于是线上环境把请求交给云函数（cloudfunctions/ledgerProxy）出网转发 ——
 * 云函数出网不受小程序域名白名单约束。
 *
 * 关键约定：对外只暴露 { statusCode, data }，形状与 wx.request 的 success
 * 回调一致。这样 utils/request.js 里的 401 / 400 / 错误归一逻辑一行都不用改，
 * 两种传输方式对它完全透明。
 *
 * 降级：只有「云这一层根本没走通」才允许改用直连重试。**超时绝不降级** ——
 * 云函数超时意味着请求可能已经到达后端并写库了，重试会重复提交（比如重复记一笔）。
 */

const config = require('../config')

const CLOUD_FN = 'ledgerProxy'

/** 直连：wx.request。只在「开发者工具 + 真机调试」下能跑通（本地工程 urlCheck:false）。 */
function directSend(options) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.getBaseUrl() + options.path,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout,
      success: function (res) {
        resolve({ statusCode: res.statusCode, data: res.data })
      },
      fail: function (err) {
        reject({ code: 'network', message: '网络异常，请稍后重试', status: 0, detail: err })
      },
    })
  })
}

/**
 * 云函数是不是「压根没发出去」。
 *
 * 判据很简单：除了超时，都算没发出去。云函数调用失败基本只有两类 ——
 * 云开发没开通 / 函数没部署（请求根本没到后端），或者 callFunction 自身的
 * 网络失败（同样没到后端）。而一旦出现超时，请求就可能已经被转发并落库了，
 * 这时候重试是危险的，所以单独排除。
 */
function isNeverSent(message) {
  return !/timeout|timed?\s?out|超时/i.test(message)
}

function cloudUnavailable(reason, neverSent, detail) {
  return {
    code: 'cloud_unavailable',
    // 这句是给用户看的，所以别说「云函数」；具体原因放 reason 里给开发者看。
    message: '服务暂时不可用，请稍后重试',
    status: 0,
    fallback: neverSent,
    reason: reason,
    detail: detail,
  }
}

/** 走云函数：由 ledgerProxy 转发到后端。 */
function cloudSend(options) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(cloudUnavailable('当前基础库不支持云开发', true))
      return
    }
    wx.cloud.callFunction({
      name: CLOUD_FN,
      data: {
        path: options.path,
        method: options.method,
        header: options.header,
        body: options.data === undefined ? null : options.data,
      },
      success: function (res) {
        const result = res && res.result
        // 云函数返回格式不对，说明部署的不是我们那份代码（或版本太旧）：
        // 请求虽然发出去了，但没被转发，所以这里也不当作「已送达」。
        if (!result || typeof result.statusCode !== 'number') {
          reject(cloudUnavailable('云函数返回格式异常，请确认已部署最新版 ledgerProxy', true, res))
          return
        }
        resolve({ statusCode: result.statusCode, data: result.data })
      },
      fail: function (err) {
        const msg = String((err && (err.errMsg || err.message)) || '云函数调用失败')
        reject(cloudUnavailable(msg, isNeverSent(msg), err))
      },
    })
  })
}

/**
 * 送一个请求出去。
 * @param {{path:string, method:string, data?:any, header?:object, timeout?:number}} options
 * @returns {Promise<{statusCode:number, data:any}>}
 */
function send(options) {
  // 没配云开发环境 ID 就照旧直连，行为与改造前一致：
  // 开发者工具和真机调试不受影响，只是体验版仍然跑不起来。
  if (config.getTransport() !== 'cloud' || !config.getCloudEnv()) {
    return directSend(options)
  }

  return cloudSend(options).catch(function (err) {
    if (!err || !err.fallback) throw err
    // eslint-disable-next-line no-console
    console.warn('[transport] 云函数走不通，降级为直连：' + err.reason)
    return directSend(options).catch(function (err2) {
      err2.cloudReason = err.reason
      throw err2
    })
  })
}

/** 当前是否真的在走云函数通道（用于上传等暂不支持云通道的能力做前置判断）。 */
function usingCloud() {
  return config.getTransport() === 'cloud' && !!config.getCloudEnv()
}

module.exports = {
  send: send,
  usingCloud: usingCloud,
  CLOUD_FN: CLOUD_FN,
}
