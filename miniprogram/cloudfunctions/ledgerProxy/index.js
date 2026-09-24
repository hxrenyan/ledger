/**
 * 云函数：把小程序的请求转发到后端（Cloudflare Worker）。
 *
 * 为什么需要它：体验版 / 正式版会严格校验「服务器域名」白名单，而白名单里的域名
 * 必须已完成 ICP 备案。后端挂在 Cloudflare Worker 上（hxsmj.top 的 NS 也在
 * Cloudflare），没有境内接入商、备案走不通，所以只能让请求先到云函数、由云函数
 * 出网转发 —— 云函数出网不受小程序的域名白名单约束。
 *
 * 只做纯转发，不碰业务：状态码、响应体、错误原样带回。小程序端
 * utils/request.js 仍然只认 { statusCode, data }，401 / 400 等语义完全不变。
 *
 * 为什么用内置 https 而不是 axios / 全局 fetch：云函数默认 Node 版本未必有
 * 全局 fetch，而 axios 会多一个要 npm install 的依赖（部署时容易踩坑）。
 *
 * 安全：**后端原点必须固定，绝不接受客户端传入的域名**，否则这个函数就成了
 * 任何人可用的任意 URL 跳板（SSRF）。需要换后端时用云开发控制台的
 * 环境变量 BACKEND_ORIGIN 覆盖，不要从 event 里读。
 */

const https = require('https')
const { URL } = require('url')

const ORIGIN = process.env.BACKEND_ORIGIN || 'https://ledger.hxsmj.top'
const PATH_PREFIX = '/api/'

/** 只透传这几个头；host / content-length / connection 必须让 https 模块自己算。 */
const PASS_HEADERS = ['authorization', 'x-ledger-id', 'content-type', 'accept']

/** 云函数返回体上限约 1MB，留出余量，超了就明确报错而不是被网关截断。 */
const MAX_RESPONSE = 900 * 1024

// DeepSeek-OCR 首 token 可能需要几十秒；必须留出完整 OCR 请求窗口。
// 小程序端 scanImage 同样使用 120 秒，代理要略早返回，避免客户端先断开。
const UPSTREAM_TIMEOUT = 110000

function badRequest(message) {
  return { statusCode: 400, data: { code: 'bad_request', message: message } }
}

function pickHeaders(raw) {
  const out = {}
  Object.keys(raw || {}).forEach(function (k) {
    if (PASS_HEADERS.indexOf(String(k).toLowerCase()) >= 0) out[k] = raw[k]
  })
  return out
}

/**
 * 发一个请求，拿回原始文本。
 * @returns {Promise<{statusCode:number, text:string}>}
 */
function send(target, method, headers, payload) {
  return new Promise(function (resolve, reject) {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: method,
        headers: payload
          ? Object.assign({}, headers, { 'content-length': Buffer.byteLength(payload) })
          : headers,
        timeout: UPSTREAM_TIMEOUT,
      },
      function (res) {
        const chunks = []
        let size = 0
        res.on('data', function (chunk) {
          size += chunk.length
          if (size > MAX_RESPONSE) {
            req.destroy(new Error('too_large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', function () {
          resolve({ statusCode: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', function () {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

exports.main = async function (event, context) {
  const path = typeof event.path === 'string' ? event.path : ''
  if (path.indexOf(PATH_PREFIX) !== 0) {
    return badRequest('path 必须以 ' + PATH_PREFIX + ' 开头')
  }

  let target
  let origin
  try {
    origin = new URL(ORIGIN)
    target = new URL(path, ORIGIN)
  } catch (e) {
    return badRequest('后端原点或 path 非法')
  }
  // 双保险：path 里塞绝对 URL（如 //evil.com/x）也走不出去。
  if (target.origin !== origin.origin) {
    return badRequest('拒绝转发到 ' + ORIGIN + ' 以外的域名')
  }

  const method = String(event.method || 'GET').toUpperCase()
  const headers = pickHeaders(event.header)
  if (!headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json'
  }
  const payload =
    event.body === undefined || event.body === null ? null : JSON.stringify(event.body)

  let res
  try {
    res = await send(target, method, headers, payload)
  } catch (err) {
    const reason = err && err.message === 'timeout' ? '后端响应超时' : '后端连接失败'
    return { statusCode: 502, data: { code: 'upstream', message: reason }, upstreamError: String(err && err.message) }
  }

  if (res.statusCode === 204 || !res.text) {
    return { statusCode: res.statusCode, data: null }
  }

  // 能解析成 JSON 就解析好带回去，省得客户端再 parse 一次；
  // 解析不了（网关错误页之类）就原样返回字符串。
  let data = res.text
  try {
    data = JSON.parse(res.text)
  } catch (e) {
    data = res.text
  }
  return { statusCode: res.statusCode, data: data }
}
