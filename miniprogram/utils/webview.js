/**
 * web-view 会话交接的客户端部分。
 *
 * 网页里没有 wx.login，所以由原生侧先拿一个一次性交接码，拼进 web-view 的 src，
 * 网页启动时用这个码换回会话（见 src/auth/handoff.ts）。
 *
 * 为什么不用「同域 cookie 共享」：以后服务会迁到自己的服务器、API 域名可能和小程序
 * 业务域名不同，显式交接不依赖同域假设。
 */

const request = require('./request')

/** HTML 查询参数名，必须和 web/src/bridge.ts 里一致。 */
const HANDOFF_PARAM = 'handoff'

/** 换一个一次性交接码。5 分钟有效、用一次即失效。 */
function handoff() {
  return request.post('/api/v1/webview/handoff', {})
}

/**
 * 拼 web-view 的 src。
 * @param {string} host 业务域名，形如 https://ledger.example.com（不带结尾斜杠）
 * @param {string} path H5 路由，形如 /budgets
 * @param {string} code 一次性交接码
 * @param {string} extra 透传给网页的业务参数，形如 month=2026-09（可为空）
 */
function buildUrl(host, path, code, extra) {
  if (!host || path.charAt(0) !== '/') return ''
  const parts = []
  if (extra) parts.push(extra)
  parts.push(HANDOFF_PARAM + '=' + encodeURIComponent(code))
  return host + path + '?' + parts.join('&')
}

/**
 * 拿码 + 拼地址。任何一步失败都 resolve 成空串，由页面走降级文案，
 * 不要在这里抛错把 web-view 容器页搞崩。
 */
function prepare(host, path, extra) {
  return handoff()
    .then(function (res) {
      if (!res || !res.code) return ''
      return buildUrl(host, path, res.code, extra)
    })
    .catch(function () {
      return ''
    })
}

module.exports = {
  HANDOFF_PARAM: HANDOFF_PARAM,
  handoff: handoff,
  buildUrl: buildUrl,
  prepare: prepare,
}
