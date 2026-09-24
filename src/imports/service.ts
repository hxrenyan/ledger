/**
 * 导入业务编排：预览 → 提交 → 撤销。
 *
 * 设计要点：
 * - 预览不落库，解析结果全部返回前端由用户确认/修正
 * - 规则解析优先，AI 只在识别不出来时兜底（没配 AI 也能用）
 * - 提交先整体校验（账户/分类归属、金额、日期），再按批 chunk 写 D1，任一批失败即回滚
 * - 去重用「账户 + 金额 + 发生时间 + 备注」签名，在日期区间内一次性捞出库里已有流水比对
 */

import { balanceStmts, type TxMoney } from '../balance.ts'
import type { Db, Stmt } from '../db/types.ts'
import { badRequest } from '../http.ts'
import { assertAmountCents } from '../money.ts'
import { parseId } from '../id.ts'
import { dateToOccurredAt, shanghaiDate } from '../time.ts'
import {
  aiParseTable,
  aiParseUtterances,
  aiReady,
  aiSuggestCategories,
  readAiConfigs,
  type AiParsedRow,
  type SuggestItem,
  type UtteranceMode,
} from './ai.ts'
import { accountNameBySource, suggestAccount, suggestCategory, type AccountLite, type CategoryLite, type Suggestion } from './match.ts'
import { detectFavor, isPersonName, parseUtterances } from './favor.ts'
import { detectTable, normalizeRow, type ParsedRow, type Source } from './mapping.ts'
import { MAX_ROWS, textToTable } from './text.ts'
import { parseDateYmd } from './values.ts'

export const PREVIEW_LIMIT = 5000
const COMMIT_CHUNK = 25

export type PreviewInput = {
  filename?: string
  sheet?: string
  kind: 'text' | 'rows'
  text?: string
  rows?: unknown
  useAi?: boolean
}

export type PreviewRow = {
  row: number
  date: string
  amount_cents: number
  direction: 'expense' | 'income' | 'skip'
  note: string
  counterparty: string
  category_id: number | null
  category_name: string
  account_id: number | null
  account_name: string
  status: 'ok' | 'skip' | 'error'
  reason: string
  duplicate: boolean
  favor_contact: string
  favor_kind: '' | 'give' | 'receive'
  favor_occasion: string
}

export type PreviewResult = {
  source: Source
  via: 'csv' | 'json'
  sheet?: string
  filename: string
  header_index: number
  header: string[]
  mapping: Record<string, number>
  stats: { total: number; ok: number; skip: number; failed: number; duplicate: number }
  truncated: boolean
  ai: { available: boolean; used: boolean; error?: string; truncated?: boolean }
  rows: PreviewRow[]
  accounts: AccountLite[]
  categories: CategoryLite[]
}

export async function buildPreview(db: Db, ledgerId: number, input: PreviewInput, opts: { useAi?: boolean } = {}): Promise<PreviewResult> {
  const table = readTable(input)
  const accounts = await db.all<{ id: number; name: string }>(
    `SELECT id, name FROM accounts WHERE ledger_id = ? AND archived = 0 ORDER BY sort_order ASC, created_at ASC`,
    [ledgerId],
  )
  const categories = await db.all<{ id: number; name: string; kind: string }>(
    `SELECT id, name, kind FROM categories WHERE ledger_id = ? AND archived = 0 ORDER BY sort_order ASC, created_at ASC`,
    [ledgerId],
  )
  const catList: CategoryLite[] = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind === 'income' ? 'income' : 'expense' }))

  const shape = detectTable(table.rows, table.via)
  let parsed: ParsedRow[] = []
  let startRowNo = 1
  if (shape) {
    startRowNo = shape.headerIndex + 2
    for (let i = shape.headerIndex + 1; i < table.rows.length; i++) {
      parsed.push(normalizeRow(table.rows[i] ?? [], shape, i + 1))
    }
  }

  const aiConfigs = await readAiConfigs(db)
  const aiAvailable = aiConfigs.some(aiReady)
  const okCount = parsed.filter((p) => p.status === 'ok').length
  const dataRows = parsed.filter((p) => p.status !== 'skip').length
  const needAi = opts.useAi === true || !shape || (dataRows > 0 && okCount / dataRows < 0.5) || (dataRows === 0 && table.rows.length > 0)

  let aiUsed = false
  let aiError: string | undefined
  let aiTruncated = false

  if (needAi) {
    if (!aiAvailable) {
      if (!shape) aiError = '未识别出表格结构，且管理后台未启用 AI'
    } else {
      const res = await aiParseTable(aiConfigs, table.rows, {
        startRowNo: 1,
        categories: catList.map((c) => c.name),
        accounts: accounts.map((a) => a.name),
      })
      if (res.ok) {
        aiUsed = true
        aiTruncated = res.data.truncated
        parsed = mergeAiRows(parsed, res.data.rows)
      } else {
        aiError = res.error
      }
    }
  }

  const previewRows: PreviewRow[] = []
  // 结构识别失败且 AI 不可用：也要把读到的行还给用户，否则界面上什么都没有
  if (!shape && !aiUsed) {
    const reason = aiError ?? '未识别出表格结构'
    for (let i = 0; i < Math.min(table.rows.length, 50); i++) {
      parsed.push({
        row: i + 1,
        status: 'error',
        reason,
        date: '',
        amount_cents: 0,
        direction: 'expense',
        note: (table.rows[i] ?? []).filter(Boolean).slice(0, 3).join(' ').slice(0, 80),
        counterparty: '',
        category_name: '',
        account_name: '',
      })
    }
  }
  for (const p of parsed) {
    previewRows.push(withSuggestions(p, accounts, catList, shape?.source ?? 'generic'))
  }

  const occurredAts = previewRows.filter((r) => r.status !== 'error').map((r) => toOccurredAt(r.date) ?? 0).filter(Boolean)
  const existing = await loadExistingSignatures(db, ledgerId, occurredAts)
  for (const r of previewRows) {
    if (r.status === 'error') continue
    const occurredAt = toOccurredAt(r.date)
    if (occurredAt && r.account_id) r.duplicate = existing.has(signature(r.account_id, r.amount_cents, occurredAt, r.note))
  }

  // 账本没有可用账户时无法导入，直接标出来而不是等到提交才报错
  if (!accounts.length) {
    for (const r of previewRows) {
      if (r.status === 'ok') {
        r.status = 'error'
        r.reason = '账本没有可用账户'
      }
    }
  }

  const capped = previewRows.slice(0, PREVIEW_LIMIT)
  const stats = {
    total: previewRows.length,
    ok: previewRows.filter((r) => r.status === 'ok').length,
    skip: previewRows.filter((r) => r.status === 'skip').length,
    failed: previewRows.filter((r) => r.status === 'error').length,
    duplicate: previewRows.filter((r) => r.duplicate).length,
  }

  return {
    source: shape?.source ?? (aiUsed ? 'ai' : 'generic'),
    via: table.via,
    sheet: input.sheet,
    filename: input.filename ?? '',
    header_index: shape?.headerIndex ?? -1,
    header: shape?.header ?? [],
    mapping: shape ? mapToJson(shape.map) : {},
    stats,
    truncated: previewRows.length > PREVIEW_LIMIT,
    ai: { available: aiAvailable, used: aiUsed, error: aiError, truncated: aiTruncated },
    rows: capped,
    accounts,
    categories: catList,
  }
}

/** 单独给预览结果补分类建议（前端「AI 建议分类」按钮）。 */
export async function suggestWithAi(
  db: Db,
  rows: { i: number; note: string; counterparty: string; direction: 'expense' | 'income'; amount_cents: number }[],
): Promise<{ applied: Record<number, string>; error?: string }> {
  const configs = await readAiConfigs(db)
  if (!configs.some(aiReady)) return { applied: {}, error: 'AI 未启用' }
  const categories = await db.all<{ name: string; kind: string }>(
    `SELECT name, kind FROM categories WHERE archived = 0 ORDER BY sort_order ASC`,
  )
  const items: SuggestItem[] = rows.filter((r) => r.direction === 'expense' || r.direction === 'income')
  if (!items.length) return { applied: {} }
  const res = await aiSuggestCategories(
    configs,
    items,
    categories.map((c) => c.name),
  )
  if (!res.ok) return { applied: {}, error: res.error }
  return { applied: res.data }
}

export type CommitRowInput = {
  date?: string
  amount_cents?: number
  direction?: string
  category_id?: string | number | null
  account_id?: string | number | null
  note?: string
  /** 未传则按备注自动识别；传空字符串表示用户明确不要记人情。 */
  favor_contact?: string
  favor_kind?: string
  favor_occasion?: string
}

export type CommitInput = {
  filename?: string
  sheet?: string
  source?: string
  dedupe?: boolean
  ai_used?: boolean
  rows?: unknown
}

export type CommitResult = {
  batch_id: number
  imported: number
  duplicates: number
  skipped: number
  failed: { row: number; reason: string }[]
  gifts: number
}

export async function commitImport(db: Db, ledgerId: number, userId: number, input: CommitInput): Promise<CommitResult> {
  const rawRows = Array.isArray(input.rows) ? input.rows : []
  if (!rawRows.length) throw badRequest('没有可导入的行')
  if (rawRows.length > MAX_ROWS) throw badRequest(`单次最多导入 ${MAX_ROWS} 行`)
  const dedupe = input.dedupe !== false

  const accounts = await db.all<{ id: number; name: string; archived: number }>(
    `SELECT id, name, archived FROM accounts WHERE ledger_id = ?`,
    [ledgerId],
  )
  const categories = await db.all<{ id: number; name: string; kind: string; archived: number }>(
    `SELECT id, name, kind, archived FROM categories WHERE ledger_id = ?`,
    [ledgerId],
  )
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const categoryById = new Map(categories.map((c) => [c.id, c]))

  const failed: { row: number; reason: string }[] = []
  type Prepared = {
    row: number
    date: string
    occurredAt: number
    amountCents: number
    direction: 'expense' | 'income'
    accountId: number
    categoryId: number
    note: string
    favor: { contact: string; kind: 'give' | 'receive'; occasion: string } | null
  }
  const prepared: Prepared[] = []
  let skipped = 0

  rawRows.forEach((raw, index) => {
    const rowNo = index + 1
    const row = (raw ?? {}) as CommitRowInput
    const direction = row.direction === 'income' ? 'income' : row.direction === 'expense' ? 'expense' : null
    if (!direction) {
      skipped++
      return
    }
    const occurredAt = toOccurredAt(String(row.date ?? ''))
    if (!occurredAt) {
      failed.push({ row: rowNo, reason: '日期无效' })
      return
    }
    try {
      assertAmountCents(row.amount_cents)
    } catch {
      failed.push({ row: rowNo, reason: '金额无效' })
      return
    }
    const accountId = parseId(row.account_id)
    const account = accountId == null ? undefined : accountById.get(accountId)
    if (!account) {
      failed.push({ row: rowNo, reason: '账户不存在' })
      return
    }
    if (account.archived) {
      failed.push({ row: rowNo, reason: '账户已归档' })
      return
    }
    const categoryId = parseId(row.category_id)
    const category = categoryId == null ? undefined : categoryById.get(categoryId)
    if (!category) {
      failed.push({ row: rowNo, reason: '分类不存在' })
      return
    }
    if (category.archived) {
      failed.push({ row: rowNo, reason: '分类已归档' })
      return
    }
    if (category.kind !== direction) {
      failed.push({ row: rowNo, reason: '分类与收支方向不一致' })
      return
    }
    prepared.push({
      row: rowNo,
      date: row.date as string,
      occurredAt,
      amountCents: row.amount_cents as number,
      direction,
      accountId: account.id,
      categoryId: category.id,
      note: (row.note ?? '').toString().trim().slice(0, 200),
      favor: readFavor(row, direction),
    })
  })

  let duplicates = 0
  let toInsert = prepared
  if (dedupe && prepared.length) {
    const existing = await loadExistingSignatures(db, ledgerId, prepared.map((p) => p.occurredAt))
    toInsert = []
    for (const p of prepared) {
      if (existing.has(signature(p.accountId, p.amountCents, p.occurredAt, p.note))) {
        duplicates++
        continue
      }
      toInsert.push(p)
    }
  }

  const now = Date.now()
  const source = normalizeSource(input.source)
  const filename = (input.filename ?? '').toString().slice(0, 200)

  const batch = await db.first<{ id: number }>(
    `INSERT INTO import_batches (ledger_id, source, filename, parsed_rows, imported_rows, skipped_rows, duplicate_rows, ai_used, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?) RETURNING id`,
    [ledgerId, source, filename, rawRows.length, toInsert.length, skipped, duplicates, input.ai_used ? 1 : 0, userId, now],
  )
  if (!batch) throw new Error('导入批次创建失败')
  const batchId = batch.id

  try {
    for (let offset = 0; offset < toInsert.length; offset += COMMIT_CHUNK) {
      const chunk = toInsert.slice(offset, offset + COMMIT_CHUNK)
      const stmts: Stmt[] = []
      for (const p of chunk) {
        stmts.push({
          sql: `INSERT INTO transactions
            (ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, import_batch_id, created_by, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
          params: [ledgerId, p.accountId, p.categoryId, p.direction, p.amountCents, p.occurredAt, p.note, batchId, userId, now, now],
        })
        const money: TxMoney = { kind: p.direction, amount_cents: p.amountCents, account_id: p.accountId, to_account_id: null }
        stmts.push(...balanceStmts(money, 1))
      }
      await db.batch(stmts)
    }
    const gifts = await writeBatchGifts(db, ledgerId, userId, batchId, now, toInsert)
    return { batch_id: batchId, imported: toInsert.length, duplicates, skipped, failed, gifts }
  } catch (e) {
    // 写库中途失败：流水、余额、这次带上的人情一起回滚。原始文件本身没有入库。
    await rollbackInserted(db, ledgerId, batchId)
    throw e
  }
}

async function rollbackInserted(db: Db, ledgerId: number, batchId: number) {
  try {
    const rows = await db.all<TxMoney>(
      `SELECT kind, amount_cents, account_id, to_account_id FROM transactions WHERE ledger_id = ? AND import_batch_id = ?`,
      [ledgerId, batchId],
    )
    for (let offset = 0; offset < rows.length; offset += COMMIT_CHUNK) {
      const chunk = rows.slice(offset, offset + COMMIT_CHUNK)
      const stmts: Stmt[] = chunk.flatMap((r) => balanceStmts({ ...r, amount_cents: Number(r.amount_cents) }, -1))
      await db.batch(stmts)
    }
    await db.run(`DELETE FROM transactions WHERE ledger_id = ? AND import_batch_id = ?`, [ledgerId, batchId])
  } finally {
    await db.run(`DELETE FROM gifts WHERE ledger_id = ? AND import_batch_id = ?`, [ledgerId, batchId])
    await db.run(`DELETE FROM import_batches WHERE id = ?`, [batchId])
  }
}

export type BatchRow = {
  id: number
  source: string
  filename: string
  parsed_rows: number
  imported_rows: number
  skipped_rows: number
  duplicate_rows: number
  ai_used: boolean
  status: string
  created_at: number
  undone_at: number | null
  created_by_name: string
}

export async function listBatches(db: Db, ledgerId: number, limit = 20): Promise<BatchRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT b.id, b.source, b.filename, b.parsed_rows, b.imported_rows, b.skipped_rows, b.duplicate_rows,
            b.ai_used, b.status, b.created_at, b.undone_at, COALESCE(u.nickname, u.username, '') AS created_by_name
     FROM import_batches b
     LEFT JOIN users u ON u.id = b.created_by
     WHERE b.ledger_id = ?
     ORDER BY b.created_at DESC
     LIMIT ?`,
    [ledgerId, limit],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    source: String(r.source),
    filename: String(r.filename ?? ''),
    parsed_rows: Number(r.parsed_rows ?? 0),
    imported_rows: Number(r.imported_rows ?? 0),
    skipped_rows: Number(r.skipped_rows ?? 0),
    duplicate_rows: Number(r.duplicate_rows ?? 0),
    ai_used: !!r.ai_used,
    status: String(r.status),
    created_at: Number(r.created_at ?? 0),
    undone_at: r.undone_at === null || r.undone_at === undefined ? null : Number(r.undone_at),
    created_by_name: String(r.created_by_name ?? ''),
  }))
}

/** 撤销一次导入：删掉该批次流水并回滚余额。 */
export async function undoBatch(db: Db, ledgerId: number, batchId: number): Promise<{ removed: number }> {
  const batch = await db.first<{ id: number; status: string }>(
    `SELECT id, status FROM import_batches WHERE id = ? AND ledger_id = ?`,
    [batchId, ledgerId],
  )
  if (!batch) throw badRequest('导入批次不存在')
  if (batch.status !== 'done') throw badRequest('该批次已撤销')

  const ids = await db.all<{ id: number }>(
    `SELECT id FROM transactions WHERE ledger_id = ? AND import_batch_id = ?`,
    [ledgerId, batchId],
  )
  const idList = ids.map((r) => r.id)
  for (let offset = 0; offset < idList.length; offset += COMMIT_CHUNK) {
    const chunk = idList.slice(offset, offset + COMMIT_CHUNK)
    const rows = await db.all<TxMoney>(
      `SELECT kind, amount_cents, account_id, to_account_id FROM transactions WHERE ledger_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      [ledgerId, ...chunk],
    )
    const stmts: Stmt[] = rows.flatMap((r) => balanceStmts({ ...r, amount_cents: Number(r.amount_cents) }, -1))
    stmts.push({ sql: `DELETE FROM transactions WHERE ledger_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, params: [ledgerId, ...chunk] })
    await db.batch(stmts)
  }
  const touched = await db.all<{ contact_id: number }>(
    `SELECT DISTINCT contact_id FROM gifts WHERE ledger_id = ? AND import_batch_id = ?`,
    [ledgerId, batchId],
  )
  await db.run(`DELETE FROM gifts WHERE ledger_id = ? AND import_batch_id = ?`, [ledgerId, batchId])
  const contactIds = touched.map((r) => r.contact_id).filter(Boolean)
  if (contactIds.length) {
    await db.run(
      `DELETE FROM contacts
       WHERE ledger_id = ? AND relation = '' AND note = ''
         AND id IN (${contactIds.map(() => '?').join(',')})
         AND id NOT IN (SELECT contact_id FROM gifts WHERE ledger_id = ?)`,
      [ledgerId, ...contactIds, ledgerId],
    )
  }
  await db.run(`UPDATE import_batches SET status = 'undone', undone_at = ? WHERE id = ?`, [Date.now(), batchId])
  return { removed: idList.length }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function readTable(input: PreviewInput): { rows: string[][]; via: 'csv' | 'json' } {
  if (input.kind === 'rows') {
    if (!Array.isArray(input.rows)) throw badRequest('rows 必须是二维数组')
    const rows = (input.rows as unknown[][]).map((r) => (Array.isArray(r) ? r.map((v) => (v === null || v === undefined ? '' : String(v))) : []))
    if (!rows.length) throw badRequest('表格没有内容')
    return { rows: rows.slice(0, MAX_ROWS), via: 'csv' }
  }
  const text = typeof input.text === 'string' ? input.text : ''
  if (!text.trim()) throw badRequest('文件内容为空')
  const table = textToTable(text)
  if (!table) throw badRequest('文件解析不出表格')
  return { rows: table.rows, via: table.via }
}

function mergeAiRows(parsed: ParsedRow[], aiRows: AiParsedRow[]): ParsedRow[] {
  const byRow = new Map<number, ParsedRow>()
  for (const p of parsed) byRow.set(p.row, p)
  for (const a of aiRows) {
    const existing = byRow.get(a.row)
    if (existing && existing.status === 'ok') continue
    if (a.direction === 'skip') {
      byRow.set(a.row, {
        row: a.row,
        status: 'skip',
        reason: '不计收支',
        date: a.date,
        amount_cents: a.amount_cents,
        direction: 'skip',
        note: a.note || a.category_name || a.counterparty,
        counterparty: a.counterparty,
        category_name: a.category_name,
        account_name: a.account_name,
      })
      continue
    }
    byRow.set(a.row, {
      row: a.row,
      status: a.date ? 'ok' : 'error',
      reason: a.date ? '' : 'AI 未给出日期',
      date: a.date,
      amount_cents: a.amount_cents,
      direction: a.direction,
      note: a.note || a.category_name || a.counterparty,
      counterparty: a.counterparty,
      category_name: a.category_name,
      account_name: a.account_name,
    })
  }
  return [...byRow.values()].sort((x, y) => x.row - y.row)
}

function withSuggestions(p: ParsedRow, accounts: AccountLite[], categories: CategoryLite[], source: string): PreviewRow {
  const base: PreviewRow = {
    row: p.row,
    date: p.date,
    amount_cents: p.amount_cents,
    direction: p.direction,
    note: p.note,
    counterparty: p.counterparty,
    category_id: null,
    category_name: '',
    account_id: null,
    account_name: '',
    status: p.status,
    reason: p.reason,
    duplicate: false,
    favor_contact: '',
    favor_kind: '',
    favor_occasion: '',
  }
  attachFavor(base)
  if (p.status === 'error' || !accounts.length) return base

  const hay = [p.note, p.counterparty, p.category_name].filter(Boolean).join(' ')
  let account = p.account_name ? matchByName(accounts, p.account_name) : null
  if (!account) account = suggestAccount(hay, accounts)
  if (!account) account = suggestAccount(accountNameBySource(source), accounts)
  if (!account) account = accounts[0] ? { id: accounts[0].id, name: accounts[0].name } : null
  if (account) {
    base.account_id = account.id
    base.account_name = account.name
  }

  if (p.status === 'ok') {
    const direction = p.direction === 'income' ? 'income' : 'expense'
    let category: Suggestion | null = p.category_name
      ? matchByName(
          categories.filter((c) => c.kind === direction),
          p.category_name,
        )
      : null
    if (!category) category = suggestCategory(direction, hay, categories)
    if (category) {
      base.category_id = category.id
      base.category_name = category.name
    } else {
      base.status = 'error'
      base.reason = '账本没有可用的收支分类'
    }
  }
  return base
}

function matchByName(list: { id: number; name: string }[], needle: string): Suggestion | null {
  const key = needle.trim().toLowerCase()
  if (!key) return null
  const exact = list.find((c) => c.name.toLowerCase() === key)
  if (exact) return { id: exact.id, name: exact.name }
  const partial = list.find((c) => c.name && (c.name.includes(needle) || needle.includes(c.name)))
  return partial ? { id: partial.id, name: partial.name } : null
}

function mapToJson(map: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(map)) if (typeof v === 'number') out[k] = v
  return out
}

/** 严格要求 YYYY-MM-DD 且日期真实存在（挡住 2024-02-31 这种）。 */
function toOccurredAt(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (parseDateYmd(date) !== date) return null
  try {
    return dateToOccurredAt(date)
  } catch {
    return null
  }
}

export function signature(accountId: number, amountCents: number, occurredAt: number, note: string): string {
  return `${accountId}|${amountCents}|${occurredAt}|${note}`
}

async function loadExistingSignatures(db: Db, ledgerId: number, occurredAts: number[]): Promise<Set<string>> {
  if (!occurredAts.length) return new Set()
  const day = 86400000
  const min = Math.min(...occurredAts) - day
  const max = Math.max(...occurredAts) + day
  const rows = await db.all<{ account_id: number; amount_cents: number; occurred_at: number; note: string }>(
    `SELECT account_id, amount_cents, occurred_at, note FROM transactions
     WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at <= ?
     LIMIT 50000`,
    [ledgerId, min, max],
  )
  return new Set(rows.map((r) => signature(r.account_id, Number(r.amount_cents), Number(r.occurred_at), String(r.note ?? ''))))
}

function normalizeSource(source: unknown): string {
  const s = String(source ?? '').toLowerCase()
  return ['wechat', 'alipay', 'bank', 'generic', 'json', 'ai', 'utterance'].includes(s) ? s : 'generic'
}

export type UtterancePreview = {
  items: PreviewRow[]
  /**
   * none 只会出现在拍照那条链路：没有配文本解析模型时，规则解析对一整页 OCR
   * 文字无能为力 —— 与其吐出一堆错行让人逐条删，不如老实说「没配置」，
   * 界面会把识别出的原文直接摆给用户看。
   */
  parser: 'ai' | 'rules' | 'none'
  ai_error: string
  accounts: { id: number; name: string }[]
  categories: { id: number; name: string; kind: string }[]
}

export async function previewUtterances(
  db: Db,
  ledgerId: number,
  text: string,
  mode: UtteranceMode = 'speak',
): Promise<UtterancePreview> {
  const accounts = await db.all<{ id: number; name: string }>(
    `SELECT id, name FROM accounts WHERE ledger_id = ? AND archived = 0 ORDER BY sort_order ASC, created_at ASC`,
    [ledgerId],
  )
  const categories = await db.all<{ id: number; name: string; kind: string }>(
    `SELECT id, name, kind FROM categories WHERE ledger_id = ? AND archived = 0 ORDER BY sort_order ASC, created_at ASC`,
    [ledgerId],
  )
  const catList: CategoryLite[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind === 'income' ? 'income' : 'expense',
  }))
  const byRules = (): PreviewRow[] =>
    parseUtterances(text)
      .slice(0, 50)
      .map((item, index) => {
        if (item.kind === 'skip') return blankPreview(index + 1, item.raw, 'skip', item.reason)
        const row = withSuggestions(
          {
            row: index + 1,
            status: 'ok',
            reason: '',
            date: item.date,
            amount_cents: item.amountCents,
            direction: item.direction,
            note: item.note,
            counterparty: item.favor?.contactName ?? '',
            category_name: '',
            account_name: '',
          },
          accounts,
          catList,
          'generic',
        )
        if (item.favor) {
          row.favor_contact = item.favor.contactName
          row.favor_kind = item.favor.giftKind
          row.favor_occasion = item.favor.occasion
        }
        return row
      })

  const configs = await readAiConfigs(db)
  if (!configs.some(aiReady)) {
    if (mode === 'photo') {
      return {
        items: [],
        parser: 'none',
        ai_error: '图片识别出文字之后，还需要一个文本解析模型把它整理成流水。请在后台「AI 配置」里加一套。',
        accounts,
        categories,
      }
    }
    return { items: byRules(), parser: 'rules', ai_error: '', accounts, categories }
  }
  const ai = await aiParseUtterances(
    configs,
    text,
    {
      today: shanghaiDate(),
      categories: catList.map((c) => `${c.name}(${c.kind === 'income' ? '收入' : '支出'})`),
      accounts: accounts.map((a) => a.name),
    },
    mode,
  )
  if (!ai.ok) {
    return mode === 'photo'
      ? { items: [], parser: 'none', ai_error: ai.error, accounts, categories }
      : { items: byRules(), parser: 'rules', ai_error: ai.error, accounts, categories }
  }

  const items = ai.data.map((item, index) => {
    const row = withSuggestions(
      {
        row: index + 1,
        status: item.date ? 'ok' : 'error',
        reason: item.date ? '' : 'AI 未给出日期',
        date: item.date,
        amount_cents: item.amount_cents,
        direction: item.direction,
        note: item.note,
        counterparty: item.favor_contact,
        category_name: item.category_name,
        account_name: item.account_name,
      },
      accounts,
      catList,
      // 第四个参数是「账单来源」（只用来推默认账户：wechat → 微信）。
      // 口语和拍照都不是账单来源，给 utterance 即可 —— 账户主要靠备注里的
      // 关键词（suggestAccount）和模型给的名字来定。
      'utterance',
    )
    const fromText = detectFavor([item.source, item.note].filter(Boolean).join(' '), item.direction)
    if (isPersonName(item.favor_contact) && item.favor_kind) {
      row.favor_contact = item.favor_contact
      row.favor_kind = item.favor_kind
      row.favor_occasion = item.favor_occasion
    } else if (fromText) {
      row.favor_contact = fromText.contactName
      row.favor_kind = fromText.giftKind
      row.favor_occasion = fromText.occasion
    }
    return row
  })
  return { items, parser: 'ai', ai_error: '', accounts, categories }
}

function blankPreview(row: number, note: string, status: PreviewRow['status'], reason: string): PreviewRow {
  return {
    row,
    date: '',
    amount_cents: 0,
    direction: 'skip',
    note,
    counterparty: '',
    category_id: null,
    category_name: '',
    account_id: null,
    account_name: '',
    status,
    reason,
    duplicate: false,
    favor_contact: '',
    favor_kind: '',
    favor_occasion: '',
  }
}

function attachFavor(row: PreviewRow) {
  const favor = detectFavor(
    [row.note, row.counterparty, row.category_name].filter(Boolean).join(' '),
    row.direction === 'income' ? 'income' : 'expense',
  )
  row.favor_contact = favor?.contactName ?? ''
  row.favor_kind = favor?.giftKind ?? ''
  row.favor_occasion = favor?.occasion ?? ''
}

function readFavor(
  row: CommitRowInput,
  direction: 'expense' | 'income',
): { contact: string; kind: 'give' | 'receive'; occasion: string } | null {
  if (typeof row.favor_contact === 'string') {
    const contact = row.favor_contact.trim().slice(0, 32)
    const kind = row.favor_kind === 'give' || row.favor_kind === 'receive' ? row.favor_kind : ''
    if (!contact || !kind) return null
    return {
      contact,
      kind,
      occasion: typeof row.favor_occasion === 'string' ? row.favor_occasion.trim().slice(0, 16) : '',
    }
  }
  const hit = detectFavor(String(row.note ?? ''), direction)
  return hit ? { contact: hit.contactName, kind: hit.giftKind, occasion: hit.occasion } : null
}

async function writeBatchGifts(
  db: Db,
  ledgerId: number,
  userId: number,
  batchId: number,
  now: number,
  rows: { favor: { contact: string; kind: 'give' | 'receive'; occasion: string } | null; amountCents: number; occurredAt: number; note: string }[],
): Promise<number> {
  const favors = rows.filter((row) => row.favor)
  if (!favors.length) return 0
  const names = [...new Set(favors.map((row) => row.favor!.contact))]
  const existing = await db.all<{ id: number; name: string }>(
    `SELECT id, name FROM contacts WHERE ledger_id = ? AND archived = 0 AND name IN (${names.map(() => '?').join(',')})`,
    [ledgerId, ...names],
  )
  const map = new Map(existing.map((row) => [row.name, row.id]))
  const create: Stmt[] = []
  const creating: string[] = []
  for (const name of names) {
    if (map.has(name)) continue
    creating.push(name)
    create.push({
      sql: `INSERT INTO contacts (ledger_id, name, relation, archived, created_at) VALUES (?, ?, '', 0, ?)`,
      params: [ledgerId, name, now],
    })
  }
  try {
    if (create.length) await db.batch(create)
    if (creating.length) {
      const createdRows = await db.all<{ id: number; name: string }>(
        `SELECT id, name FROM contacts WHERE ledger_id = ? AND archived = 0 AND created_at = ? AND name IN (${creating.map(() => '?').join(',')})`,
        [ledgerId, now, ...creating],
      )
      for (const row of createdRows) map.set(row.name, row.id)
    }
    const stmts: Stmt[] = []
    for (const row of favors) {
      const contactId = map.get(row.favor!.contact)
      if (!contactId) continue
      stmts.push({
        sql: `INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note, created_by, created_at, updated_at, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [ledgerId, contactId, row.favor!.kind, row.amountCents, row.favor!.occasion, row.occurredAt, row.note, userId, now, now, batchId],
      })
    }
    for (let offset = 0; offset < stmts.length; offset += COMMIT_CHUNK) {
      await db.batch(stmts.slice(offset, offset + COMMIT_CHUNK))
    }
    return stmts.length
  } catch (error) {
    if (creating.length) {
      const createdRows = await db.all<{ id: number }>(
        `SELECT id FROM contacts WHERE ledger_id = ? AND archived = 0 AND created_at = ? AND name IN (${creating.map(() => '?').join(',')})`,
        [ledgerId, now, ...creating],
      )
      if (createdRows.length) {
        await db.run(
          `DELETE FROM contacts WHERE ledger_id = ? AND id IN (${createdRows.map(() => '?').join(',')})
           AND id NOT IN (SELECT contact_id FROM gifts WHERE ledger_id = ?)`,
          [ledgerId, ...createdRows.map((row) => row.id), ledgerId],
        )
      }
    }
    throw error
  }
}
