/** 把路径参数、data-id、本地存储里的主键收成正整数。空值返回 null。 */
function toId(value) {
  if (typeof value === 'number' && value > 0 && value === Math.floor(value) && value <= Number.MAX_SAFE_INTEGER) {
    return value
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value)
    if (n > 0 && n <= Number.MAX_SAFE_INTEGER) return n
  }
  return null
}

module.exports = { toId }
