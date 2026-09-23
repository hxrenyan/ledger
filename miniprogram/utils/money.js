/**
 * 金额一律用整数分。这里的表达式求值语义与 src/money.ts 的 yuanExprToCents 一致——
 * 后端按同一套规则再校验一次，前端只负责「输入 12+8 也能算出 20」。
 */

function formatYuan(cents) {
  const n = Number(cents) || 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(n))
  const y = Math.floor(abs / 100)
  const f = String(abs % 100).padStart(2, '0')
  return sign + y + '.' + f
}

/** 千分位，金额大时更易读：12345.67 → 12,345.67 */
function formatYuanGrouped(cents) {
  const s = formatYuan(cents)
  const neg = s.charAt(0) === '-'
  const body = neg ? s.slice(1) : s
  const parts = body.split('.')
  return (neg ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1]
}

/** 带符号的展示金额：支出取负、收入取正、转账不带符号。 */
function signedText(kind, cents) {
  const v = Math.abs(Number(cents) || 0)
  if (kind === 'expense') return '-' + formatYuan(v)
  if (kind === 'income') return '+' + formatYuan(v)
  return formatYuan(v)
}

/** 支持 12+8、3*4，按分运算避免浮点。非法返回 null。 */
function yuanExprToCents(raw) {
  const s = String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, '')
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
  if (!s) return null
  if (!/^\d+(\.\d+)?([+\-*/]\d+(\.\d+)?)*$/.test(s)) return null
  const nums = s.split(/[+\-*/]/).map(function (x) {
    const n = Number(x)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100)
  })
  if (nums.some(function (x) { return x === null })) return null
  const values = nums.slice()
  const ops = s.match(/[+\-*/]/g) || []
  let i = 0
  while (i < ops.length) {
    if (ops[i] === '*' || ops[i] === '/') {
      const a = values[i]
      const b = values[i + 1]
      if (ops[i] === '/' && b === 0) return null
      const r = ops[i] === '*' ? Math.round((a * b) / 100) : Math.round((a * 100) / b)
      if (!Number.isFinite(r)) return null
      values.splice(i, 2, r)
      ops.splice(i, 1)
    } else {
      i += 1
    }
  }
  let acc = values.length ? values[0] : 0
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k] === '+') acc += values[k + 1]
    else acc -= values[k + 1]
  }
  if (!Number.isInteger(acc) || acc <= 0 || acc > 1e12) return null
  return acc
}

module.exports = {
  formatYuan: formatYuan,
  formatYuanGrouped: formatYuanGrouped,
  signedText: signedText,
  yuanExprToCents: yuanExprToCents,
}
