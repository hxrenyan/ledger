/**
 * 统一请求层：带 token / 账本头、错误归一、401 回登录。
 *
 * 约定：
 * - 账本用 X-Ledger-Id 头传，与 web/src/api.ts 一致；
 * - 401 统一清会话并回登录页（登录接口自身除外，否则会递归）；
 * - 失败一律 reject 成 { code, message, status }，页面不用再关心 wx.request 的壳。
 */

const config = require('../config')
const transport = require('./transport')
const session = require('./session')

/**
 * 上传（语音转写 / 认图）的默认超时，也是 withTimeout 的兜底值。
 *
 * 这两个都是只读接口（认得出就返回文字，没写库），所以超时后丢弃结果没有副作用。
 * 值要**大于**服务端自己的单套超时：让服务端有机会先把可读的错误（比如
 * 「某套配置返回 401」）送回来，而不是被客户端的超时抢先盖成一句笼统的「识别超时」。
 */
const UPLOAD_TIMEOUT_MS = 120000

function toError(res, fallback) {
  const body = res && res.data
  const message = body && typeof body.message === 'string' && body.message ? body.message : fallback
  return {
    code: (body && body.code) || 'error',
    message,
    status: res ? res.statusCode : 0,
  }
}

function queryString(data) {
  const parts = []
  Object.keys(data || {}).forEach(function (k) {
    const v = data[k]
    if (v === undefined || v === null || v === '') return
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
  })
  return parts.join('&')
}

/**
 * 给一个 Promise 套上「自己的」超时。
 *
 * 为什么不能只靠 wx.request 的 timeout：那个参数兜不住「连接已经建立、
 * 后端迟迟不响应」这种最常见的情况 —— 认图正好撞在这个场景上（视觉模型
 * 首 token 就可能几十秒），浮层于是永远停在「识别中…」：不报错、不结束，
 * 只能杀进程重进。所以超时必须在 JS 这一层兜死。
 *
 * 超时的语义只是「不再等」，**不会重发**。写类接口绝不能靠它重试 ——
 * 请求可能已经被后端处理并落库了（这与 transport 里「超时不降级」同一条原则）。
 */
function withTimeout(promise, ms, message) {
  return new Promise(function (resolve, reject) {
    let done = false
    const timer = setTimeout(function () {
      if (done) return
      done = true
      reject({ code: 'timeout', message: message, status: 0 })
    }, ms)
    promise.then(
      function (v) {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      },
      function (e) {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function request(options) {
  const opts = options || {}
  const path = opts.path
  const withLedger = opts.withLedger !== false
  const timeout = opts.timeout || 20000
  const token = session.getToken()
  const ledgerId = session.getLedgerId()

  const header = Object.assign(
    { 'content-type': 'application/json' },
    token ? { authorization: 'Bearer ' + token } : {},
    withLedger && ledgerId ? { 'x-ledger-id': ledgerId } : {},
    opts.header || {},
  )

  return withTimeout(
    transport.send({
      path: path,
      method: (opts.method || 'GET').toUpperCase(),
      data: opts.data || undefined,
      header: header,
      timeout: timeout,
    }),
    timeout,
    '请求超时，请稍后重试',
  ).then(function (res) {
    if (res.statusCode === 401) {
      // 登录类接口的 401 是「密码错」这类业务语义，不能当成掉登录。
      //
      // 还要确认这是「当前这条会话」的 401：token 是发请求时捕获的，
      // 响应回来时可能已经登录过（或换过账号）了。这种迟到的 401 若照样
      // 清会话跳登录，现象就是「刚登录进去又被踢回登录页」，极难定位。
      // 因此只有 token 与当前存储的一致，才认定这条会话真的失效。
      if (path.indexOf('/api/v1/auth/') !== 0 && token === session.getToken()) {
        session.clear()
        wx.reLaunch({ url: '/pages/login/login' })
      }
      throw toError(res, '登录已过期')
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return res.data
    }
    throw toError(res, '请求失败')
  })
}

/**
 * 云通道只能送 JSON，送不了二进制分片。
 *
 * 收据图与语音录音都还是这条限制的受害者（认图已经用 JSON base64 绕开了，
 * 见 scanImage）。体验版走云通道时，这两处会明确报「不支持」，而不是留一个
 * 「开发者工具里看着能用、体验版必然失败」的口子。
 * 以后要接的话，正确做法是走云存储中转：
 *   1. wx.cloud.uploadFile 把文件传到云存储（该 API 不受域名白名单限制）；
 *   2. callFunction 把 fileID 交给 ledgerProxy；
 *   3. 云函数 cloud.downloadFile 取回字节，自己拼 multipart 转发给后端。
 */
function rejectCloudUpload(what) {
  return Promise.reject({
    code: 'not_implemented',
    message: what + '暂不支持，请稍后再试',
    status: 0,
  })
}

/**
 * 上传（收据图、账单文件、录音都用它）。
 * @param {{path:string, filePath:string, name?:string, formData?:object, timeout?:number}} options
 */
function upload(options) {
  const opts = options || {}
  if (transport.usingCloud()) return rejectCloudUpload('文件上传')
  const token = session.getToken()
  const ledgerId = session.getLedgerId()

  return new Promise(function (resolve, reject) {
    wx.uploadFile({
      url: config.getBaseUrl() + opts.path,
      filePath: opts.filePath,
      name: opts.name || 'file',
      formData: opts.formData || {},
      header: Object.assign(
        token ? { authorization: 'Bearer ' + token } : {},
        ledgerId ? { 'x-ledger-id': ledgerId } : {},
      ),
      timeout: opts.timeout || 120000,
      success: function (res) {
        if (res.statusCode === 401) {
          session.clear()
          wx.reLaunch({ url: '/pages/login/login' })
          reject({ code: 'unauthorized', message: '登录已过期', status: 401 })
          return
        }
        let body = null
        try {
          body = res.data ? JSON.parse(res.data) : null
        } catch (e) {
          body = null
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body)
          return
        }
        reject({
          code: (body && body.code) || 'error',
          message: (body && body.message) || '上传失败',
          status: res.statusCode,
        })
      },
      fail: function (err) {
        reject({ code: 'network', message: '上传失败，请检查网络', status: 0, detail: err })
      },
    })
  })
}

function strBytes(s) {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * 手工拼 multipart 请求体。
 *
 * 为什么不用 wx.uploadFile：收据接口读的是分片自己的 Content-Type
 * （src/routes/transactions.ts 里 `file.type` 必须命中 jpeg/png/webp 白名单），
 * 而 wx.uploadFile 不保证按扩展名给出正确的分片类型，实测容易被打回
 * 「仅支持 jpeg / png / webp」。所以这里自己拼，显式写死类型。
 *
 * filename 只用 ASCII：非 ASCII 会破坏头部的字节长度计算。
 *
 * @param {string} field 表单字段名（收据接口固定是 file）
 * @param {string} filename ASCII 文件名
 * @param {string} mime 分片的 Content-Type
 * @param {Uint8Array} bytes 文件字节
 * @param {Object} [extra] 附加的普通表单字段（值会被 String() 化）
 */
function buildMultipart(field, filename, mime, bytes, extra) {
  const boundary = '----ledger' + Date.now().toString(16) + Math.random().toString(16).slice(2)
  let header =
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + field + '"; filename="' + filename + '"\r\n' +
    'Content-Type: ' + mime + '\r\n\r\n'
  const extraKeys = Object.keys(extra || {})
  if (extraKeys.length) {
    let fields = ''
    extraKeys.forEach(function (k) {
      fields += '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
        String(extra[k]) + '\r\n'
    })
    // 普通字段排在文件分片之前，是 multipart 的常规顺序。
    header = fields + header
  }
  const footer = '\r\n--' + boundary + '--\r\n'
  const head = strBytes(header)
  const tail = strBytes(footer)
  const body = new Uint8Array(head.length + bytes.length + tail.length)
  body.set(head, 0)
  body.set(bytes, head.length)
  body.set(tail, head.length + bytes.length)
  return { boundary: boundary, body: body.buffer }
}

/** 读本地文件为字节；收据、语音、认图都要它。 */
function readFileBytes(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      success: function (res) { resolve(new Uint8Array(res.data)) },
      fail: function (err) {
        reject({ code: 'file', message: '文件读取失败', status: 0, detail: err })
      },
    })
  })
}

/** 读本地文件为 base64（云通道送图只能用它，见 scanImage）。 */
function readFileBase64(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (res) { resolve(String(res.data || '')) },
      fail: function (err) {
        reject({ code: 'file', message: '图片读取失败', status: 0, detail: err })
      },
    })
  })
}

const RECEIPT_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }

/**
 * 上传收据图（收据接口只收 image/jpeg|png|webp，且要小于 512KB）。
 * @param {string} txId 流水 id
 * @param {string} filePath 本地临时文件路径
 * @param {string} mime 必须是 RECEIPT_EXT 里的三种之一
 */
function uploadReceipt(txId, filePath, mime) {
  if (transport.usingCloud()) return rejectCloudUpload('收据上传')
  const ext = RECEIPT_EXT[mime]
  if (!ext) {
    return Promise.reject({ code: 'bad_request', message: '仅支持 jpeg / png / webp', status: 0 })
  }
  const token = session.getToken()
  const ledgerId = session.getLedgerId()

  return new Promise(function (resolve, reject) {
    readFileBytes(filePath)
      .then(function (bytes) {
        const packed = buildMultipart('file', 'receipt.' + ext, mime, bytes)
        wx.request({
          url: config.getBaseUrl() + '/api/v1/transactions/' + txId + '/receipt',
          method: 'POST',
          header: Object.assign(
            { 'content-type': 'multipart/form-data; boundary=' + packed.boundary },
            token ? { authorization: 'Bearer ' + token } : {},
            ledgerId ? { 'x-ledger-id': ledgerId } : {},
          ),
          data: packed.body,
          timeout: 60000,
          success: function (res) {
            let body = null
            try {
              body = res.data ? (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) : null
            } catch (e) {
              body = null
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body)
              return
            }
            reject({
              code: (body && body.code) || 'error',
              message: (body && body.message) || '收据上传失败',
              status: res.statusCode,
            })
          },
          fail: function (err) {
            reject({ code: 'network', message: '收据上传失败，请检查网络', status: 0, detail: err })
          },
        })
      })
      .catch(function (err) {
        reject(err)
      })
  })
}

const AUDIO_MIME = {
  mp3: 'audio/mp3',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
}

/**
 * 手工 multipart 上传任意本地文件（目前用于语音识别）。
 *
 * 和 uploadReceipt 同一个理由：分片自己的 Content-Type 必须是我们写的那个，
 * wx.uploadFile 不保证，而语音接口是按 audio/* 白名单校验的。
 *
 * @param {{path:string, filePath:string, ext?:string, mime?:string, field?:string, formData?:object}} options
 */
function uploadBinary(options) {
  const opts = options || {}
  if (transport.usingCloud()) return rejectCloudUpload('文件上传')
  const ext = (opts.ext || 'mp3').replace(/^\./, '').toLowerCase()
  const mime = opts.mime || AUDIO_MIME[ext] || 'application/octet-stream'
  const field = opts.field || 'file'
  const extra = opts.formData || {}
  const timeout = opts.timeout || UPLOAD_TIMEOUT_MS
  const token = session.getToken()
  const ledgerId = session.getLedgerId()

  const sent = readFileBytes(opts.filePath).then(function (bytes) {
    const packed = buildMultipart(field, 'upload.' + ext, mime, bytes, extra)
    return new Promise(function (resolve, reject) {
      wx.request({
        url: config.getBaseUrl() + opts.path,
        method: 'POST',
        header: Object.assign(
          { 'content-type': 'multipart/form-data; boundary=' + packed.boundary },
          token ? { authorization: 'Bearer ' + token } : {},
          ledgerId ? { 'x-ledger-id': ledgerId } : {},
        ),
        data: packed.body,
        // 这个参数也传着，但真正兜底的是下面那层 withTimeout ——
        // wx.request 的 timeout 管不到「连接已建立、后端不吭声」。
        timeout: timeout,
        success: function (res) {
          let body = null
          try {
            body = res.data ? (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) : null
          } catch (e) {
            body = null
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body)
            return
          }
          reject({
            code: (body && body.code) || 'error',
            message: (body && body.message) || '上传失败',
            status: res.statusCode,
          })
        },
        fail: function (err) {
          reject({ code: 'network', message: '上传失败，请检查网络', status: 0, detail: err })
        },
      })
    })
  })

  return withTimeout(sent, timeout, '识别超时，请重试')
}

const IMAGE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
}

/**
 * 认图体积上限，按通道分开。
 *
 * 云通道要把图片 base64 塞进 callFunction 的 event，而 event 上限约 1MB，
 * base64 又会把字节数放大 1/3 —— 所以这里取 600KB 反推，留出余量。
 * 直连没有这层限制，只受后端 6MB 上限约束，给到 3MB 足够手机直出照片。
 *
 * 客户端主动压到这个值以下，比让后端/云函数报错好定位得多。
 */
const DIRECT_IMAGE_BYTES = 3 * 1024 * 1024
const CLOUD_IMAGE_BYTES = 600 * 1024

/**
 * 认图的超时。
 *
 * 后端这条链路本身就很慢：实测视觉模型首 token 就要 30~60 秒（见 src/ocr/vision.ts
 * 顶部的实测数据），而且几条配置接力还会累加。后端单套 90 秒、整条 100 秒，
 * 这里给 120 秒 —— 让「哪一套失败、为什么」这种可读错误先回来，
 * 而不是被客户端抢先盖成一句笼统的「识别超时」。
 */
const SCAN_TIMEOUT_MS = 120000

function imageLimit() {
  return transport.usingCloud() ? CLOUD_IMAGE_BYTES : DIRECT_IMAGE_BYTES
}

/**
 * 认图：拍到的照片 → 文字。
 *
 * 两条送法必须都留着：
 *   - 直连（开发者工具 / 真机调试）走 multipart，图片不膨胀；
 *   - 云通道只能走 JSON base64 —— callFunction 的 event 只送 JSON。
 * 后端的 /ocr/scan 两种都收，语义一致，所以这里只换传输、不换语义。
 *
 * @param {{filePath:string, mime?:string, timeout?:number}} options
 */
function scanImage(options) {
  const opts = options || {}
  const mime = opts.mime || 'image/jpeg'
  const timeout = opts.timeout || SCAN_TIMEOUT_MS
  if (transport.usingCloud()) {
    return readFileBase64(opts.filePath).then(function (b64) {
      return post('/api/v1/ocr/scan', { image_base64: b64, mime: mime }, { timeout: timeout })
    })
  }
  return uploadBinary({
    path: '/api/v1/ocr/scan',
    filePath: opts.filePath,
    ext: IMAGE_EXT[mime] || 'jpg',
    mime: mime,
    timeout: timeout,
  })
}

function get(path, data, options) {
  return request(Object.assign({ path: path, method: 'GET', data: data }, options || {}))
}

function post(path, data, options) {
  return request(Object.assign({ path: path, method: 'POST', data: data }, options || {}))
}

function put(path, data, options) {
  return request(Object.assign({ path: path, method: 'PUT', data: data }, options || {}))
}

function del(path, data, options) {
  return request(Object.assign({ path: path, method: 'DELETE', data: data }, options || {}))
}

module.exports = {
  request: request,
  upload: upload,
  uploadReceipt: uploadReceipt,
  uploadBinary: uploadBinary,
  scanImage: scanImage,
  imageLimit: imageLimit,
  readFileBytes: readFileBytes,
  readFileBase64: readFileBase64,
  get: get,
  post: post,
  put: put,
  del: del,
  queryString: queryString,
  // 导出只为测试：语义见 withTimeout 的说明。
  withTimeout: withTimeout,
}
