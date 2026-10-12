/**
 * 运行环境与能力开关。
 *
 * 后端是 Sealos 上的 Node 服务，本地和线上是同一份接口，差别只在域名。
 * 误切到本地时，登录页可以切回线上。
 *
 * transport 决定请求怎么送出去（见 utils/transport.js）：
 *   direct —— wx.request 直连 api 域名。只在「开发者工具 + 真机调试」下能跑通，
 *             因为这两条通道使用本地工程的 urlCheck:false（不校验合法域名）。
 *   cloud  —— 体验版 / 正式版会校验「服务器域名」白名单，域名还必须完成 ICP 备案。
 *             Sealos 分配的 *.bja.sealos.run 一般填不进白名单，所以线上走云函数
 *             ledgerProxy 出网转发。转发目标是云函数环境变量 BACKEND_ORIGIN。
 *
 * PROD_API：小程序 request 合法域名。不要带路径，不要结尾斜杠。
 * 不要填 https://bja.sealos.run（那是控制台）。
 */

const PROD_API = 'https://ledger-7aie87ej.sealosbja.site'

const ENVS = {
  local: { key: 'local', label: '本地', api: 'http://127.0.0.1:3000', transport: 'direct' },
  prod: { key: 'prod', label: '线上', api: PROD_API, transport: 'cloud' },
}

/**
 * 云开发环境 ID（形如 ledger-3gxxxxxxxxxxxx）。
 *
 * 开通路径：小程序后台 → 云开发 → 新建环境，然后把 ID 填到这里。
 * 留空时 transport 会自动降级成 direct，行为与改造前一致 —— 也就是说
 * 没填这个值，开发者工具和真机调试照旧能用，只是体验版仍然跑不起来。
 */
const CLOUD_ENV = ''

const STORAGE_KEY = 'ledger.env'

function currentEnvKey() {
  let saved = ''
  try {
    saved = wx.getStorageSync(STORAGE_KEY) || ''
  } catch (e) {
    saved = ''
  }
  return ENVS[saved] ? saved : 'prod'
}

function currentEnv() {
  return ENVS[currentEnvKey()]
}

function getBaseUrl() {
  return currentEnv().api
}

/** 当前环境用哪种传输方式：'direct' | 'cloud'。 */
function getTransport() {
  return currentEnv().transport || 'direct'
}

/** 云开发环境 ID；没配就返回空串（transport 会据此降级成直连）。 */
function getCloudEnv() {
  return CLOUD_ENV
}

function setEnv(key) {
  if (!ENVS[key]) return false
  wx.setStorageSync(STORAGE_KEY, key)
  return true
}

function envList() {
  return Object.keys(ENVS).map((k) => ENVS[k])
}

module.exports = {
  ENVS,
  getBaseUrl,
  getTransport,
  getCloudEnv,
  setEnv,
  currentEnv,
  currentEnvKey,
  envList,
}
