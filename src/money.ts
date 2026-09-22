/** 金额一律用整数分，禁止浮点入库存。 */

export function yuanToCents(yuan: unknown): number {
  if (typeof yuan === 'number') {
    if (!Number.isFinite(yuan)) throw new Error('金额无效')
    return Math.round(yuan * 100)
  }
  if (typeof yuan !== 'string' || !yuan.trim()) throw new Error('金额无效')
  const n = Number(yuan.trim())
  if (!Number.isFinite(n)) throw new Error('金额无效')
  return Math.round(n * 100)
}

export function centsToYuan(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const y = Math.floor(abs / 100)
  const f = String(abs % 100).padStart(2, '0')
  return `${sign}${y}.${f}`
}

/** 支持 12+8、3*4，按分运算避免浮点。非法或结果非正则返回 null。 */
export function yuanExprToCents(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/\s+/g, '')
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
  if (!s) return null
  if (!/^\d+(\.\d+)?([+\-*/]\d+(\.\d+)?)*$/.test(s)) return null
  const nums = s.split(/[+\-*/]/).map((x) => {
    const n = Number(x)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100)
  })
  if (nums.some((x) => x === null)) return null
  const values = nums as number[]
  const ops = s.match(/[+\-*/]/g) ?? []
  for (let i = 0; i < ops.length; ) {
    if (ops[i] === '*' || ops[i] === '/') {
      const a = values[i]
      const b = values[i + 1]
      if (ops[i] === '/' && b === 0) return null
      const r = ops[i] === '*' ? Math.round((a * b) / 100) : Math.round((a * 100) / b)
      if (!Number.isFinite(r)) return null
      values.splice(i, 2, r)
      ops.splice(i, 1)
    } else {
      i++
    }
  }
  let acc = values[0] ?? 0
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === '+') acc += values[i + 1]
    else acc -= values[i + 1]
  }
  if (!Number.isInteger(acc) || acc <= 0 || acc > 1e12) return null
  return acc
}

export function assertAmountCents(cents: unknown): number {
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents <= 0 || cents > 1e12) {
    throw new Error('金额须为正整数分')
  }
  return cents
}
