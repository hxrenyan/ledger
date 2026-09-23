/**
 * GBK 解码。
 *
 * 微信的 readFile 只认 utf-8 / ascii 这类编码名，没有 gbk；而国内银行、微信、
 * 支付宝导出的 CSV 大量是 GBK。所以这里带一份 GBK 双字节映射表
 * （utils/gbk-table.js，由 tools/gen-gbk-table.py 生成），自己解。
 */

const table = require('./gbk-table')

const LEAD = table.LEAD_COUNT
const TRAIL = table.TRAIL_COUNT
const TABLE = table.TABLE

function trailIndex(b) {
  // 0x40–0xFE 去掉 0x7F，映射到连续下标
  return b - 0x40 - (b > 0x7f ? 1 : 0)
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      continue
    }
    const next = bytes[i + 1]
    if (next == null || next < 0x40 || next > 0xfe || next === 0x7f) {
      out += '\uFFFD'
      continue
    }
    out += TABLE[(b - 0x81) * TRAIL + trailIndex(next)]
    i += 1
  }
  return out
}

module.exports = {
  decode: decode,
}
