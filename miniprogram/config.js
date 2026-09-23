/**
 * 运行环境与能力开关。
 *
 * 后端只有一套代码（Cloudflare Worker），本地和线上是同一份接口，
 * 差别只在域名，所以这里做成可切换：我的 → 开发者 → 环境。
 *
 * transport 决定请求怎么送出去（见 utils/transport.js）：
 *   direct —— wx.request 直连 api 域名。只在「开发者工具 + 真机调试」下能跑通，
 *             因为这两条通道使用本地工程的 urlCheck:false（不校验合法域名）。
 *   体验版 / 正式版会严格校验「服务器域名」白名单，而白名单要求域名已完成
 *   ICP 备案 —— ledger.hxsmj.top 挂在 Cloudflare，没有境内接入商、备案走不通，
 *   所以走 cloud：把请求交给云函数 ledgerProxy，由它出网转发。
 */

const ENVS = {
  local: { key: 'local', label: '本地', api: 'http://127.0.0.1:8787', transport: 'direct' },
  prod: { key: 'prod', label: '线上', api: 'https://ledger.hxsmj.top', transport: 'cloud' },
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

/**
 * web-view 混合架构的本地兜底。
 *
 * 真正生效的页面归属表来自服务端（GET /api/v1/app/config，见 utils/appConfig.js）：
 * 运维把某页切成 web-view 后 deploy 即生效，不用发版。这里的值只在
 * 「首次启动还没拉到配置」或「接口挂了」时使用——所以默认全部原生，
 * 宁可多走原生，也不要让用户撞上一个打不开的网页。
 *
 * 启用 web-view 的三个前置条件（缺一不可，详见 README「web-view 接入清单」）：
 *   1. 小程序主体是非个人（企业 / 个体户）——个人主体配不了业务域名；
 *   2. 域名已 HTTPS 化，且 ICP 备案主体与小程序认证主体一致；
 *   3. 该域名在微信后台登记为「业务域名」，并把校验文件放到域名根目录。
 */
const WEBVIEW_PAGES = {
  budgets: { mode: 'native', path: '/budgets' },
  categories: { mode: 'native', path: '/categories' },
  recurring: { mode: 'native', path: '/recurring' },
  import: { mode: 'native', path: '/import' },
  ledger: { mode: 'native', path: '/me' },
}

/** 深拷贝一份，避免调用方改到这份常量。 */
function fallbackPages() {
  const out = {}
  Object.keys(WEBVIEW_PAGES).forEach(function (key) {
    out[key] = { mode: WEBVIEW_PAGES[key].mode, path: WEBVIEW_PAGES[key].path }
  })
  return out
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
  fallbackPages,
}
