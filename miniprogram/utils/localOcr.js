/**
 * 小程序端侧认字（微信 VisionKit）。照片不出设备。
 *
 * 只负责「这张图上有没有足够的字」。整理成流水仍走服务器上的文本模型。
 * 认不出、超时、基础库不支持，调用方再走 request.scanImage 上传。
 * 压图不在这里做：端侧用原图画进 canvas 再缩小，上传用的压缩梯度仍在 image.js。
 *
 * 静态图模式是 OCR mode 2（mode 1 是摄像头实时）。基础库 2.27.0 起提供。
 */

/** 长边上限。再大的图 RGBA 缓冲会把低端机撑满，支付长截图也进不了 canvas。 */
const MAX_EDGE = 1280
/**
 * 少于此数的字母 / 数字 / 汉字视为没认全，交给云端。
 * 单独一个金额（如 35.00）只有 4 个数字，不够越过这一档。
 */
const MIN_MEANINGFUL = 8
/** 本机认字的等待上限。模型没就绪或设备不支持时，不要让人干等再进云端。 */
const LOCAL_TIMEOUT_MS = 12000

function fail(code, message) {
  return { code: code, message: message, status: 0 }
}

/** 当前基础库有没有 VisionKit。开发者工具里 canIUse 也可能为真，真正跑不跑要看 start 的 errno。 */
function supported() {
  try {
    return typeof wx !== 'undefined' && !!wx.canIUse && !!wx.canIUse('createVKSession')
  } catch (e) {
    return false
  }
}

/**
 * 拍照入口开不开。
 * 服务器配了图片识别，或者这台手机能端侧认字，二者有一个就给入口。
 * 端侧认不全时仍会请求服务器；服务器没配，那次会拿到明确的失败原因。
 */
function photoAvailable(serverReady) {
  return !!serverReady || supported()
}

/**
 * 把原图像素收进长边不超过 maxEdge 的矩形，宽高至少为 1。
 * 宽或高不是正数时返回 null，调用方不要拿 0 去建 canvas。
 */
function fitSize(width, height, maxEdge) {
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)
  const edge = Number(maxEdge) > 0 ? Number(maxEdge) : MAX_EDGE
  if (w <= 0 || h <= 0) return null
  const long = Math.max(w, h)
  if (long <= edge) return { width: w, height: h }
  const scale = edge / long
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

function anchorPos(anchor) {
  if (!anchor || typeof anchor !== 'object') return null
  const origin = anchor.origin || anchor.center
  if (!origin) return null
  const x = Number(origin.x)
  const y = Number(origin.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: x, y: y }
}

/**
 * 把 VisionKit 返回的文字块拼成一段。
 * 每块都有坐标时按从上到下、从左到右排；有一块没有坐标就保持原顺序，
 * 避免半截坐标把微信已经排好的阅读顺序打乱。
 */
function joinAnchors(anchors) {
  const list = Array.isArray(anchors) ? anchors : []
  const rows = []
  let positioned = 0
  for (let i = 0; i < list.length; i += 1) {
    const text = String((list[i] && list[i].text) || '')
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (!text) continue
    const pos = anchorPos(list[i])
    if (pos) positioned += 1
    rows.push({ text: text, x: pos ? pos.x : 0, y: pos ? pos.y : 0 })
  }
  if (rows.length > 1 && positioned === rows.length) {
    rows.sort((a, b) => a.y - b.y || a.x - b.x)
  }
  return rows.map((row) => row.text).join('\n')
}

/** 只数字母、数字、汉字。标点和空格不算，避免一串符号被当成认全了。 */
function meaningfulCount(text) {
  const s = String(text || '')
  let n = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c >= 48 && c <= 57) n += 1
    else if (c >= 65 && c <= 90) n += 1
    else if (c >= 97 && c <= 122) n += 1
    else if (c >= 0x4e00 && c <= 0x9fff) n += 1
  }
  return n
}

function usable(text) {
  return meaningfulCount(text) >= MIN_MEANINGFUL
}

/**
 * 拷一份紧凑的 RGBA ArrayBuffer。
 * canvas 的缓冲可能稍后被复用，runOCR 又是异步读的，必须先复制再交给它。
 * 长度对不上 width*height*4 时返回 null。
 */
function rgbaBuffer(data, width, height) {
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)
  const need = w * h * 4
  if (!need || !data || data.length !== need) return null
  const copy = new Uint8Array(need)
  copy.set(data)
  return copy.buffer
}

function loadRgba(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success(info) {
        const fitted = fitSize(info && info.width, info && info.height, MAX_EDGE)
        if (!fitted) {
          reject(fail('bad_image', '这张图读不了'))
          return
        }
        let canvas
        try {
          canvas = wx.createOffscreenCanvas({ type: '2d', width: fitted.width, height: fitted.height })
        } catch (e) {
          reject(fail('unsupported', '本机认字不可用'))
          return
        }
        const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null
        if (!ctx || !canvas.createImage) {
          reject(fail('unsupported', '本机认字不可用'))
          return
        }
        const img = canvas.createImage()
        img.onload = () => {
          try {
            ctx.drawImage(img, 0, 0, fitted.width, fitted.height)
            const imageData = ctx.getImageData(0, 0, fitted.width, fitted.height)
            const buffer = rgbaBuffer(imageData && imageData.data, fitted.width, fitted.height)
            if (!buffer) {
              reject(fail('bad_image', '这张图读不了'))
              return
            }
            resolve({ frameBuffer: buffer, width: fitted.width, height: fitted.height })
          } catch (e) {
            reject(fail('bad_image', '这张图读不了'))
          }
        }
        img.onerror = () => reject(fail('bad_image', '这张图读不了'))
        img.src = (info && info.path) || filePath
      },
      fail() {
        reject(fail('bad_image', '这张图读不了'))
      },
    })
  })
}

function runSession(frame) {
  return new Promise((resolve, reject) => {
    let session = null
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(fail('timeout', '本机认字超时')))
    }, LOCAL_TIMEOUT_MS)

    function finish(fn) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (session && session.stop) {
        try {
          session.stop()
        } catch (e) {
          /* 会话已经停了就不用再报 */
        }
      }
      fn()
    }

    try {
      session = wx.createVKSession({
        track: { OCR: { mode: 2 } },
      })
    } catch (e) {
      finish(() => reject(fail('unsupported', '本机认字不可用')))
      return
    }
    if (!session || !session.start || !session.runOCR || !session.on) {
      finish(() => reject(fail('unsupported', '本机认字不可用')))
      return
    }

    session.on('updateAnchors', (anchors) => {
      finish(() => resolve(joinAnchors(anchors)))
    })
    session.start((errno) => {
      if (settled) return
      if (errno) {
        finish(() => reject(fail('unsupported', '本机认字不可用')))
        return
      }
      try {
        session.runOCR({
          frameBuffer: frame.frameBuffer,
          width: frame.width,
          height: frame.height,
        })
      } catch (e) {
        finish(() => reject(fail('unsupported', '本机认字不可用')))
      }
    })
  })
}

/**
 * 认一张本地图片。成功时 resolve 拼好的文字（可能是空串）。
 * 设备不支持、读图失败、超时则 reject，调用方应改走云端，不要把这类错误直接抛给用户。
 */
function recognize(filePath) {
  if (!filePath) return Promise.reject(fail('bad_image', '没有照片'))
  if (!supported()) return Promise.reject(fail('unsupported', '本机认字不可用'))
  return loadRgba(filePath).then(runSession)
}

module.exports = {
  MAX_EDGE,
  MIN_MEANINGFUL,
  LOCAL_TIMEOUT_MS,
  supported,
  photoAvailable,
  fitSize,
  joinAnchors,
  meaningfulCount,
  usable,
  rgbaBuffer,
  recognize,
}
