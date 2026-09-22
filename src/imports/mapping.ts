/**
 * 表格结构识别：找到表头行、把列映射到业务字段、判断账单来源。
 *
 * 账单导出格式差异极大（微信 / 支付宝 / 各家银行 / 自研导出），
 * 策略是「表头关键词优先 + 取值特征校验补位」，都失败时交给 AI 兜底。
 */

import { parseAmountCents, parseDateYmd, parseDirection, toHalfWidth, getCell, type Direction } from './values.ts'

export type Source = 'wechat' | 'alipay' | 'bank' | 'generic' | 'json' | 'ai'

export type ColumnRole =
  | 'date'
  | 'amount'
  | 'direction'
  | 'note'
  | 'counterparty'
  | 'account'
  | 'category'
  | 'status'
  | 'income_amount'
  | 'expense_amount'

export type ColumnMap = Partial<Record<ColumnRole, number>>

export type TableShape = {
  source: Source
  via: 'csv' | 'json'
  headerIndex: number
  header: string[]
  map: ColumnMap
}

export type ParsedRow = {
  /** 源文件行号（1 基），便于用户回查 */
  row: number
  status: 'ok' | 'skip' | 'error'
  reason: string
  date: string
  amount_cents: number
  direction: Direction
  note: string
  counterparty: string
  category_name: string
  account_name: string
}

const HEADER_SCAN = 40
const SAMPLE = 40

export function detectTable(rows: string[][], via: 'csv' | 'json'): TableShape | null {
  let best: { index: number; map: ColumnMap; score: number } | null = null
  const limit = Math.min(rows.length, HEADER_SCAN)
  for (let i = 0; i < limit; i++) {
    const map = mapColumns(rows[i] ?? [])
    const score = scoreMap(map)
    if (score >= 3 && (!best || score > best.score)) best = { index: i, map, score }
  }

  if (!best) {
    // 没有表头：完全按取值特征推断（日期列 + 金额列 + 方向列）
    const map = inferColumnsByValues(rows, 0)
    if (!map.date && !map.amount) return null
    return { source: 'generic', via, headerIndex: -1, header: [], map }
  }

  const header = (rows[best.index] ?? []).map((v) => String(v ?? '').trim())
  const map = refineByValues(rows, best.index + 1, best.map)
  return {
    source: detectSource(rows, best.index, header, via),
    via,
    headerIndex: best.index,
    header,
    map,
  }
}

function scoreMap(map: ColumnMap): number {
  let score = 0
  if (map.date !== undefined) score += 2
  if (map.amount !== undefined) score += 2
  if (map.income_amount !== undefined) score += 2
  if (map.expense_amount !== undefined) score += 2
  if (map.direction !== undefined) score += 1.5
  if (map.note !== undefined) score += 1
  if (map.counterparty !== undefined) score += 1
  if (map.category !== undefined) score += 0.5
  if (map.account !== undefined) score += 0.5
  return score
}

/** 表头名 → 列角色。先做宽松归一化（去空格、去括号说明、转半角）。 */
export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {}
  header.forEach((raw, index) => {
    const role = classifyHeader(String(raw ?? ''))
    if (role && map[role] === undefined) map[role] = index
  })
  return map
}

const RE_DIRECTION = /^(收\/支|收支|收支类型|收支方向|资金流向|借贷标志|借贷方向|借贷|收入\/支出|收付标志|交易方向|方向|in_?out|direction|debit_?credit|收\/付)$/
const RE_INCOME_AMOUNT = /(贷方|收入|存入|转入|收款|入账)/
const RE_EXPENSE_AMOUNT = /(借方|支出|支取|转出|付款|出账)/
const RE_AMOUNT = /^(金额|交易金额|发生额|交易额|消费金额|付款金额|实付金额|订单金额|订单实付金额|amount|money|value|价格|售价|总价)$/
const RE_DATE = /^(交易时间|交易日期|日期|时间|记账日期|入账日期|发生日期|发生时间|消费时间|创建时间|支付时间|date|time|datetime|transaction_?date|occurred_?at|pay_?time|created_?at)$/
const RE_NOTE = /^(备注|附言|摘要|说明|用途|商品|商品说明|商品名称|交易说明|交易备注|交易摘要|交易摘要说明|note|remark|memo|desc|description|comment|detail|title|标题)$/
const RE_COUNTERPARTY = /^(交易对方|对方|对方户名|对方名称|对方账号|商户|商户名称|收款方|付款方|交易对象|对手信息|payee|payer|counterparty|merchant|vendor)$/
const RE_ACCOUNT = /^(支付方式|付款方式|收\/付款方式|账户|账号|支付账户|付款账户|本方账号|卡号|支付渠道|渠道|account|payment_?method|card)$/
const RE_CATEGORY = /^(交易分类|分类|消费类型|类别|账单分类|category|kind|tag)$/
const RE_IGNORE = /^(序号|编号|index|no|id|行号|交易单号|商户单号|订单号|交易订单号|商家订单号|流水号|交易流水号|记账凭证号)$/

function classifyHeader(raw: string): ColumnRole | null {
  const h = normalizeHeader(raw)
  const loose = toHalfWidth(raw).replace(/\s/g, '').toLowerCase()
  if (!h || !loose) return null
  if (RE_IGNORE.test(h)) return null
  // 方向列要在「收入金额 / 支出金额」之前判，避免「借贷标志」被当成金额列
  if (RE_DIRECTION.test(h)) return 'direction'
  // 收支拆分列：必须有「额 / 金额」字样，否则「付款方式」「收/付款方式」会被误判
  if (/(额|金额|amount)/.test(loose) && RE_INCOME_AMOUNT.test(loose)) return 'income_amount'
  if (/(额|金额|amount)/.test(loose) && RE_EXPENSE_AMOUNT.test(loose)) return 'expense_amount'
  if (RE_AMOUNT.test(h)) return 'amount'
  if (RE_DATE.test(h)) return 'date'
  if (RE_NOTE.test(h)) return 'note'
  if (RE_COUNTERPARTY.test(h)) return 'counterparty'
  if (RE_ACCOUNT.test(h)) return 'account'
  if (RE_CATEGORY.test(h)) return 'category'
  if (/^(交易状态|状态|当前状态|status|交易结果)$/.test(h)) return 'status'

  // 宽松兜底：中文账单列名经常带前后缀
  if (/日期|时间|date|time/i.test(h)) return 'date'
  if (/金额|发生额|amount|money/i.test(h)) return 'amount'
  if (/对方|商户|payee|merchant|counterparty/i.test(h)) return 'counterparty'
  if (/备注|摘要|说明|note|remark|memo|desc|商品/i.test(h)) return 'note'
  if (/收支|借贷|direction|in_?out/i.test(h)) return 'direction'
  if (/账户|卡号|account|支付方式|付款方式/i.test(h)) return 'account'
  if (/分类|category/i.test(h)) return 'category'
  return null
}

function normalizeHeader(raw: string): string {
  return toHalfWidth(String(raw ?? ''))
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[【[][^】\]]*[】\]]/g, '')
    .replace(/[:：*]/g, '')
    .toLowerCase()
}

type ColumnStats = {
  samples: number
  dateRatio: number
  amountRatio: number
  dirRatio: number
  distinct: number
}

function sampleColumn(rows: string[][], col: number, from: number): string[] {
  const values: string[] = []
  for (let i = from; i < rows.length && values.length < SAMPLE; i++) {
    const v = getCell(rows[i], col)
    if (v) values.push(v)
  }
  return values
}

function statsOf(values: string[]): ColumnStats {
  const n = values.length
  if (!n) return { samples: 0, dateRatio: 0, amountRatio: 0, dirRatio: 0, distinct: 0 }
  let d = 0
  let a = 0
  let dir = 0
  for (const v of values) {
    if (parseDateYmd(v)) d++
    if (parseAmountCents(v) !== null) a++
    if (parseDirection(v)) dir++
  }
  return {
    samples: n,
    dateRatio: d / n,
    amountRatio: a / n,
    dirRatio: dir / n,
    distinct: new Set(values.map((v) => v.toLowerCase())).size,
  }
}

function columnStats(rows: string[][], from: number, maxCols: number): ColumnStats[] {
  const width = Math.min(maxCols, rows.reduce((m, r) => Math.max(m, r.length), 0))
  const out: ColumnStats[] = []
  for (let c = 0; c < width; c++) out.push(statsOf(sampleColumn(rows, c, from)))
  return out
}

/** 用取值特征补齐表头没识别出的列；表头明确但取值明显不符的列会被丢弃。 */
function refineByValues(rows: string[][], from: number, map: ColumnMap): ColumnMap {
  const next: ColumnMap = { ...map }
  const stats = columnStats(rows, from, 40)
  const used = (col: number) => Object.values(next).includes(col)
  const isDateish = (s: ColumnStats) => s.dateRatio >= 0.6 && s.samples >= 2
  const isAmountish = (s: ColumnStats) => s.amountRatio >= 0.6 && s.samples >= 2

  // 表头说这是方向列，但取值全不是方向词 → 撤销该映射（宁可退回按金额正负判断）
  if (next.direction !== undefined) {
    const s = stats[next.direction]
    if (s && s.samples >= 3 && s.dirRatio < 0.3) delete next.direction
  }
  // 表头说这是金额列，但取值全解析不出金额 → 撤销
  if (next.amount !== undefined) {
    const s = stats[next.amount]
    if (s && s.samples >= 3 && s.amountRatio < 0.3) delete next.amount
  }

  if (next.date === undefined) {
    const idx = bestIndex(stats, (s, c) => isDateish(s) && !used(c))
    if (idx >= 0) next.date = idx
  }
  if (next.direction === undefined) {
    // 真实的方向列取值种类很少（支出/收入/不计收支），用 distinct 过滤掉备注类文本
    const idx = bestIndex(stats, (s, c) => s.samples >= 2 && s.dirRatio >= 0.7 && s.distinct <= 8 && !isDateish(s) && !isAmountish(s) && !used(c))
    if (idx >= 0) next.direction = idx
  }
  if (next.amount === undefined && next.income_amount === undefined && next.expense_amount === undefined) {
    const idx = bestIndex(stats, (s, c) => isAmountish(s) && !isDateish(s) && !used(c))
    if (idx >= 0) next.amount = idx
  }
  // 无表头时把第一个「既不像日期也不像金额」的文本列当备注（列少的导出格式常见）
  if (next.note === undefined) {
    const idx = stats.findIndex((s, c) => s.samples >= 2 && s.dateRatio < 0.3 && s.amountRatio < 0.5 && s.dirRatio < 0.5 && !used(c))
    if (idx >= 0) next.note = idx
  }
  return next
}

function inferColumnsByValues(rows: string[][], from: number): ColumnMap {
  return refineByValues(rows, from, {})
}

function bestIndex(stats: ColumnStats[], ok: (s: ColumnStats, col: number) => boolean): number {
  let bestCol = -1
  let bestRatio = 0
  stats.forEach((s, c) => {
    if (!ok(s, c)) return
    const ratio = Math.max(s.dateRatio, s.amountRatio, s.dirRatio)
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestCol = c
    }
  })
  return bestCol
}

function detectSource(rows: string[][], headerIndex: number, header: string[], via: 'csv' | 'json'): Source {
  if (via === 'json') return 'json'
  const preamble = rows.slice(0, Math.max(4, headerIndex + 2)).flat().join(' ')
  const h = header.join(' ')

  if (/微信支付账单|微信昵称|微信支付|财付通/.test(preamble)) return 'wechat'
  if (/支付宝|余额宝|花呗/.test(preamble)) return 'alipay'
  if (/商品说明|收\/付款方式|交易分类|对方账号|交易订单号/.test(h)) return 'alipay'
  if (/商品名称|商品|支付方式|当前状态|商户单号|交易类型/.test(h)) return 'wechat'
  if (/借贷|发生额|借方|贷方|摘要|对方户名|对方账号|余额|开户行/.test(h)) return 'bank'
  return 'generic'
}

/** 单行 → 业务字段。解析不出来的行保留原因，交给用户修正而不是静默丢弃。 */
export function normalizeRow(row: string[], shape: TableShape, rowNo: number): ParsedRow {
  const map = shape.map
  const empty: ParsedRow = {
    row: rowNo,
    status: 'error',
    reason: '',
    date: '',
    amount_cents: 0,
    direction: 'expense',
    note: '',
    counterparty: '',
    category_name: '',
    account_name: '',
  }

  const cells = row.map((v) => String(v ?? '').trim())
  if (!cells.some(Boolean)) return { ...empty, status: 'skip', reason: '空行' }
  const head = cells.slice(0, 3).join('')
  if (/^(合计|总计|小计|汇总|共\s*\d+\s*笔|以上)/.test(head) || /^-{3,}/.test(head)) {
    return { ...empty, status: 'skip', reason: '汇总/分隔行' }
  }

  const out: ParsedRow = { ...empty }
  out.date = parseDateYmd(getCell(row, map.date)) ?? ''
  out.note = getCell(row, map.note)
  out.counterparty = getCell(row, map.counterparty)
  out.category_name = getCell(row, map.category)
  out.account_name = getCell(row, map.account)

  const columnDirection = map.direction !== undefined ? parseDirection(getCell(row, map.direction)) : null
  let cents: number | null = null
  let direction: Direction | null = columnDirection

  // 收入/支出分列（银行常见）：方向列优先，其次取有值的那一列
  const incomeCents = map.income_amount !== undefined ? parseAmountCents(getCell(row, map.income_amount)) : null
  const expenseCents = map.expense_amount !== undefined ? parseAmountCents(getCell(row, map.expense_amount)) : null
  if (incomeCents || expenseCents) {
    if (columnDirection === 'income' && incomeCents) cents = Math.abs(incomeCents)
    else if (columnDirection === 'expense' && expenseCents) cents = Math.abs(expenseCents)
    else if (incomeCents) {
      cents = Math.abs(incomeCents)
      direction = direction ?? 'income'
    } else if (expenseCents) {
      cents = Math.abs(expenseCents)
      direction = direction ?? 'expense'
    }
  }

  if (cents === null && map.amount !== undefined) {
    const raw = parseAmountCents(getCell(row, map.amount))
    if (raw !== null) {
      cents = Math.abs(raw)
      if (!direction) direction = raw > 0 ? 'income' : raw < 0 ? 'expense' : 'skip'
    }
  }

  if (!out.note) out.note = out.category_name || out.counterparty
  if (cents === null || cents === 0) {
    out.reason = '未识别到金额'
    return out
  }
  if (!out.date) {
    out.date = ''
    out.reason = '未识别到日期'
    return out
  }
  out.amount_cents = cents
  out.direction = direction ?? 'expense'
  out.status = direction === 'skip' ? 'skip' : 'ok'
  if (out.status === 'skip') out.reason = '不计收支'
  return out
}
