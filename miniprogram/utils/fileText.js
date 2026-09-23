/**
 * 把本地文件读成文本：UTF-8 优先，失败再按 GBK 解。
 *
 * 微信 readFile 只支持 utf-8/ascii 等编码名，读 GBK 文件会得到乱码而不是报错，
 * 所以这里的做法是：先按 utf-8 解，若出现替换字符（\uFFFD）就用 GBK 表重解。
 */

const gbk = require('./gbk')

/** utf-8 解码，遇到非法字节返回 null（原生 TextDecoder 在小程序里不一定有）。 */
function decodeUtf8(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
      continue
    }
    let need = 0
    let code = 0
    if ((b & 0xe0) === 0xc0) { need = 1; code = b & 0x1f }
    else if ((b & 0xf0) === 0xe0) { need = 2; code = b & 0x0f }
    else if ((b & 0xf8) === 0xf0) { need = 3; code = b & 0x07 }
    else return null
    if (i + need >= bytes.length) return null
    for (let k = 1; k <= need; k += 1) {
      const nb = bytes[i + k]
      if ((nb & 0xc0) !== 0x80) return null
      code = (code << 6) | (nb & 0x3f)
    }
    if (code > 0x10ffff) return null
    if (code > 0xffff) {
      const v = code - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
    i += need + 1
  }
  return out
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {string}
 */
function fromBytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3)) || ''
  }
  const utf8 = decodeUtf8(bytes)
  if (utf8 != null && utf8.indexOf('\uFFFD') === -1) return utf8
  const asGbk = gbk.decode(bytes)
  // 两边都有替换字符时，挑「坏字符更少」的那个。
  if (utf8 != null && countBad(utf8) <= countBad(asGbk)) return utf8
  return asGbk
}

function countBad(s) {
  let n = 0
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 0xfffd) n += 1
  return n
}

/** 读本地文件（chooseMessageFile / 录音等拿到的临时路径）为文本。 */
function readFileText(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      success: function (res) { resolve(fromBytes(res.data)) },
      fail: function (err) { reject({ code: 'file', message: '文件读取失败', detail: err }) },
    })
  })
}

/** 读二进制，用于手工拼 multipart。 */
function readFileBytes(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      success: function (res) { resolve(new Uint8Array(res.data)) },
      fail: function (err) { reject({ code: 'file', message: '文件读取失败', detail: err }) },
    })
  })
}

module.exports = {
  decodeUtf8: decodeUtf8,
  fromBytes: fromBytes,
  readFileText: readFileText,
  readFileBytes: readFileBytes,
}
