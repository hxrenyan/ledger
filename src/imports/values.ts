/**
 * 导入解析的取值归一化：金额、日期、方向。
 *
 * 这里全部是纯函数，不碰数据库，便于单测覆盖各种账单写法：
 * 「¥1,234.56」「(123.45)」「123.45-」「45293（Excel 序列号）」「2024年1月2日」……
 */

import { shanghaiDate } from '../time.ts'

/** 全角字符转半角（数字、括号、逗号、减号等）。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\uFFE5/g, '¥')
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function getCell(row: unknown[] | undefined, index: number | undefined): string {
  if (!row || index === undefined || index < 0) return ''
  const v = row[index]
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return stripBom(v).trim()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v).trim()
}

/**
 * 解析金额为「分」，保留正负号（负号表示支出，具体方向由调用方结合方向列决定）。
 * 无法识别返回 null。
 */
export function parseAmountCents(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Math.abs(raw) > 1e10) return null
    return Math.round(raw * 100)
  }
  if (typeof raw !== 'string') return null

  let s = toHalfWidth(raw).trim()
  if (!s) return null
  if (/^[a-zA-Z\u4e00-\u9fa5]+$/.test(s)) return null

  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s
    .replace(/[¥￥$€£]/g, '')
    .replace(/人民币|RMB/gi, '')
    .replace(/元|圆/g, '')
    .replace(/\s/g, '')
  if (s.endsWith('-')) {
    negative = true
    s = s.slice(0, -1)
  }
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (!s) return null

  // 千分位「1,234.56」；欧洲写法「123,45」按小数处理（中文账单少见，兜底）
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.')

  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const cents = Math.round(n * 100)
  if (cents > 1e12) return null
  return negative ? -cents : cents
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** Excel 1900 日期序列号（如 45293）转 YYYY-MM-DD。 */
export function excelSerialToYmd(serial: number): string | null {
  if (serial < 20000 || serial > 80000) return null
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000)
  const d = new Date(ms)
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * 解析日期为 YYYY-MM-DD（上海日历）。
 *
 * 支持：2024-01-02、2024/1/2、2024.1.2、2024年1月2日、20240102、
 * ISO（带 Z 时按上海时区换算）、13/10 位时间戳、Excel 序列号。
 * 对「01/02/2024」这类月日歧义写法直接返回 null，交给用户手工修正而不是猜错。
 */
export function parseDateYmd(raw: unknown): string | null {
  if (raw instanceof Date) {
    return shanghaiDate(raw.getTime())
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    if (raw > 1e11) return shanghaiDate(raw)
    if (raw > 1e9) return shanghaiDate(raw * 1000)
    return excelSerialToYmd(raw)
  }
  if (typeof raw !== 'string') return null

  const s = toHalfWidth(raw).trim()
  if (!s) return null

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/i.test(s)) {
    const ms = Date.parse(s)
    if (!Number.isFinite(ms)) return null
    return shanghaiDate(ms)
  }

  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))

  m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    const serial = excelSerialToYmd(n)
    if (serial) return serial
  }
  return null
}

export type Direction = 'expense' | 'income' | 'skip'

const EXPENSE_WORDS = ['支出', '支', '付款', '支付', '借', '借方', '消费', '转出', '出账', '扣款', '减少', 'debit', 'expense', 'dr', 'out']
const INCOME_WORDS = ['收入', '收', '收款', '贷', '贷方', '转入', '入账', '退款', '增加', 'credit', 'income', 'cr', 'in']
const SKIP_WORDS = ['不计收支', '不计入', '不计', '中性', '内部', '其他', '转账', '还款', '理财', '投资', 'neutral', '/', '—', '-']

function matchWords(s: string, words: string[]): boolean {
  return words.some((w) => {
    if (w.length <= 1) return s === w
    // 短英文词（in/out/dr/cr）按全等匹配，否则 "pending" 会命中 "in"
    if (/^[a-z0-9]+$/i.test(w) && w.length <= 4) return s === w
    return s.includes(w)
  })
}

/**
 * 解析「收/支」「借贷标志」等方向列。无法判定返回 null。
 * 「不计收支」这类返回 'skip'，表示不应计入收支统计。
 */
export function parseDirection(raw: unknown): Direction | null {
  if (typeof raw === 'number') {
    if (raw > 0) return 'income'
    if (raw < 0) return 'expense'
    return null
  }
  if (typeof raw !== 'string') return null
  const s = toHalfWidth(raw).trim().toLowerCase()
  if (!s) return null
  if (matchWords(s, SKIP_WORDS)) return 'skip'
  if (matchWords(s, EXPENSE_WORDS)) return 'expense'
  if (matchWords(s, INCOME_WORDS)) return 'income'
  return null
}

/** 数值带符号推断方向，仅在没有方向列时使用。 */
export function directionFromSign(cents: number): Direction {
  if (cents > 0) return 'income'
  if (cents < 0) return 'expense'
  return 'skip'
}
